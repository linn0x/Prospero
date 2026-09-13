use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

use super::{UsageDailyBucket, UsageReport, UsageWindow};
use crate::error::{Error, Result};

pub(crate) const NATIVE_CODEX_ID: &str = "native-codex";

const CODEX_TIMEOUT: Duration = Duration::from_secs(12);
const MAX_CODEX_LINE_BYTES: usize = 1024 * 1024;

fn codex_binary() -> String {
    std::env::var("PROSPERO_CODEX_BIN").unwrap_or_else(|_| "codex".into())
}

fn user_home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
}

fn shared_codex_home() -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| user_home().map(|home| home.join(".codex")))
        .unwrap_or_else(|| PathBuf::from("."))
}

fn codex_auth_refresh(path: &Path) -> i64 {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return 0;
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
        return 0;
    };
    parsed
        .get("last_refresh")
        .and_then(|value| value.as_str())
        .map(stable_time_score)
        .unwrap_or(0)
}

fn stable_time_score(value: &str) -> i64 {
    value
        .bytes()
        .filter(|byte| byte.is_ascii_digit())
        .take(14)
        .fold(0i64, |acc, byte| {
            acc.saturating_mul(10).saturating_add((byte - b'0') as i64)
        })
}

#[cfg(unix)]
fn set_private_dir_permissions(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn set_private_dir_permissions(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn set_private_file_permissions(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn set_private_file_permissions(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

pub(crate) fn native_codex_environment(data: &Path) -> Result<(PathBuf, Vec<(String, String)>)> {
    let usage_root = data
        .join("agent-accounts")
        .join("codex-usage")
        .join(NATIVE_CODEX_ID);
    let usage_home = usage_root.join("home");
    let usage_sqlite = usage_root.join("sqlite");
    for dir in [&usage_root, &usage_home, &usage_sqlite] {
        std::fs::create_dir_all(dir)?;
        let _ = set_private_dir_permissions(dir);
    }

    let target_auth = usage_home.join("auth.json");
    let shared_auth = shared_codex_home().join("auth.json");
    if shared_auth != target_auth && shared_auth.exists() {
        let should_copy = !target_auth.exists()
            || codex_auth_refresh(&shared_auth) > codex_auth_refresh(&target_auth);
        if should_copy && std::fs::copy(&shared_auth, &target_auth).is_ok() {
            let _ = set_private_file_permissions(&target_auth);
        }
    }

    Ok((
        user_home().unwrap_or_else(|| PathBuf::from("/")),
        vec![
            ("OPENAI_API_KEY".into(), String::new()),
            ("CODEX_API_KEY".into(), String::new()),
            ("CODEX_ACCESS_TOKEN".into(), String::new()),
            ("CODEX_REFRESH_TOKEN".into(), String::new()),
            (
                "CODEX_HOME".into(),
                usage_home.to_string_lossy().into_owned(),
            ),
            (
                "CODEX_SQLITE_HOME".into(),
                usage_sqlite.to_string_lossy().into_owned(),
            ),
        ],
    ))
}

struct CodexRpc {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl CodexRpc {
    async fn start(cwd: PathBuf, env: &[(String, String)]) -> Result<Self> {
        let mut command = Command::new(codex_binary());
        command
            .arg("app-server")
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (key, value) in env {
            command.env(key, value);
        }
        let mut child = command.spawn().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                Error::Feature("agent_unavailable".into(), "未安装 codex".into())
            } else {
                Error::Io(error)
            }
        })?;
        if let Some(mut stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut sink = Vec::new();
                let _ = stderr.read_to_end(&mut sink).await;
            });
        }
        let stdin = child.stdin.take().ok_or(Error::Closed)?;
        let stdout = child.stdout.take().ok_or(Error::Closed)?;
        let mut rpc = Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 1,
        };
        rpc.request(
            "initialize",
            json!({
                "clientInfo": { "name": "prospero", "title": "Prospero", "version": env!("CARGO_PKG_VERSION") },
                "capabilities": { "experimentalApi": true, "requestAttestation": false },
            }),
        )
        .await?;
        rpc.notify("initialized", json!({})).await?;
        Ok(rpc)
    }

    async fn notify(&mut self, method: &str, params: Value) -> Result<()> {
        let frame = json!({ "method": method, "params": params });
        self.write_frame(&frame).await
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        let frame = json!({ "id": id, "method": method, "params": params });
        self.write_frame(&frame).await?;
        tokio::time::timeout(CODEX_TIMEOUT, self.read_response(id))
            .await
            .map_err(|_| Error::Timeout)?
    }

    async fn write_frame(&mut self, frame: &Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(frame)?;
        bytes.push(b'\n');
        self.stdin.write_all(&bytes).await?;
        self.stdin.flush().await?;
        Ok(())
    }

    async fn read_response(&mut self, id: u64) -> Result<Value> {
        loop {
            let mut line = String::new();
            let n = self.stdout.read_line(&mut line).await?;
            if n == 0 {
                return Err(Error::Closed);
            }
            if line.len() > MAX_CODEX_LINE_BYTES {
                return Err(Error::Invalid("codex usage response too large".into()));
            }
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if value.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if let Some(error) = value.get("error") {
                let message = error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("codex RPC failed");
                return Err(Error::Invalid(message.chars().take(1000).collect()));
            }
            return Ok(value.get("result").cloned().unwrap_or_else(|| json!({})));
        }
    }

    async fn shutdown(mut self) {
        let _ = self.stdin.shutdown().await;
        let _ = self.child.start_kill();
        let _ = tokio::time::timeout(Duration::from_secs(2), self.child.wait()).await;
    }
}

pub(crate) async fn read_native_codex_usage(data: &Path) -> Result<Option<UsageReport>> {
    let (cwd, env) = native_codex_environment(data)?;
    let mut rpc = CodexRpc::start(cwd, &env).await?;
    let result = async {
        let identity = rpc
            .request("account/read", json!({ "refreshToken": true }))
            .await?;
        if identity.get("account").is_none_or(|value| value.is_null()) {
            return Ok(None);
        }

        let limits = rpc.request("account/rateLimits/read", json!({})).await.ok();
        let history = rpc.request("account/usage/read", json!({})).await.ok();
        let mut report = limits.and_then(|response| {
            let selected = response
                .get("rateLimitsByLimitId")
                .and_then(|value| value.as_object())
                .and_then(|map| map.get("codex").or_else(|| map.values().next()))
                .or_else(|| response.get("rateLimits"));
            selected.and_then(usage_from_rate_limits)
        });
        if let Some(history) = history.and_then(|value| usage_from_token_history(&value)) {
            let mut merged = report.take().unwrap_or_else(|| UsageReport {
                windows: Vec::new(),
                ..Default::default()
            });
            if history.lifetime_tokens.is_some() {
                merged.lifetime_tokens = history.lifetime_tokens;
            }
            if history.daily_usage.is_some() {
                merged.daily_usage = history.daily_usage;
            }
            report = Some(merged);
        }
        Ok(report)
    }
    .await;
    rpc.shutdown().await;
    result
}

fn finite_nonnegative(value: Option<&Value>) -> Option<i64> {
    let number = match value? {
        Value::Number(number) => number.as_f64()?,
        Value::String(text) if !text.trim().is_empty() => text.trim().parse::<f64>().ok()?,
        _ => return None,
    };
    (number.is_finite() && number >= 0.0).then(|| number.round() as i64)
}

fn describe_window(mins: f64) -> String {
    let rounded = mins.round() as i64;
    if rounded > 0 && rounded % (60 * 24) == 0 {
        format!("{} 天", rounded / (60 * 24))
    } else if rounded > 0 && rounded % 60 == 0 {
        format!("{} 小时", rounded / 60)
    } else {
        format!("{} 分钟", rounded)
    }
}

fn usage_window(value: Option<&Value>, fallback: &str) -> Option<UsageWindow> {
    let record = value?.as_object()?;
    let utilization = record.get("usedPercent")?.as_f64()?;
    let label = record
        .get("windowDurationMins")
        .and_then(Value::as_f64)
        .map(describe_window)
        .unwrap_or_else(|| fallback.into());
    let resets_at = record
        .get("resetsAt")
        .and_then(Value::as_i64)
        .and_then(unix_seconds_to_iso);
    Some(UsageWindow {
        label,
        utilization,
        resets_at,
    })
}

fn usage_from_rate_limits(value: &Value) -> Option<UsageReport> {
    let rate_limits = value.as_object()?;
    let windows = [
        usage_window(rate_limits.get("primary"), "主窗口"),
        usage_window(rate_limits.get("secondary"), "次窗口"),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();
    let plan = rate_limits
        .get("planType")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let credits = rate_limits.get("credits").and_then(Value::as_object);
    let spend = rate_limits
        .get("individualLimit")
        .and_then(Value::as_object);
    if windows.is_empty() && plan.is_none() && credits.is_none() && spend.is_none() {
        return None;
    }
    Some(UsageReport {
        subscription: plan,
        credits_unlimited: credits
            .and_then(|value| value.get("unlimited"))
            .and_then(Value::as_bool),
        credits_balance: credits
            .and_then(|value| value.get("balance"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        spend_limit: spend
            .and_then(|value| value.get("limit"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        spend_used: spend
            .and_then(|value| value.get("used"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        spend_remaining_percent: spend
            .and_then(|value| value.get("remainingPercent"))
            .and_then(Value::as_f64),
        windows,
        ..Default::default()
    })
}

fn usage_from_token_history(value: &Value) -> Option<UsageReport> {
    let response = value.as_object()?;
    let lifetime_tokens = finite_nonnegative(
        response
            .get("summary")
            .and_then(Value::as_object)
            .and_then(|summary| summary.get("lifetimeTokens")),
    );
    let mut daily_usage = response
        .get("dailyUsageBuckets")
        .and_then(Value::as_array)
        .map(|buckets| {
            buckets
                .iter()
                .filter_map(|candidate| {
                    let bucket = candidate.as_object()?;
                    let date = bucket.get("startDate")?.as_str()?.to_owned();
                    let tokens = finite_nonnegative(bucket.get("tokens"))?;
                    Some(UsageDailyBucket { date, tokens })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if daily_usage.len() > 31 {
        daily_usage = daily_usage.split_off(daily_usage.len() - 31);
    }
    (lifetime_tokens.is_some() || !daily_usage.is_empty()).then_some(UsageReport {
        lifetime_tokens,
        daily_usage: (!daily_usage.is_empty()).then_some(daily_usage),
        windows: Vec::new(),
        ..Default::default()
    })
}

fn unix_seconds_to_iso(seconds: i64) -> Option<String> {
    if seconds < 0 {
        return None;
    }
    let days = seconds.div_euclid(86_400);
    let rem = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = rem / 3600;
    let minute = (rem % 3600) / 60;
    let second = rem % 60;
    Some(format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.000Z"
    ))
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if m <= 2 { 1 } else { 0 };
    (year, m, d)
}

fn timestamp_ms(value: Option<&Value>) -> Option<i64> {
    let raw = value?.as_f64()?;
    if !raw.is_finite() || raw < 0.0 {
        return None;
    }
    Some(
        (if raw < 1_000_000_000_000.0 {
            raw * 1000.0
        } else {
            raw
        })
        .round() as i64,
    )
}

fn trim_codex(value: &str, maximum: usize) -> String {
    let value = value.trim();
    let end = value
        .char_indices()
        .nth(maximum)
        .map_or(value.len(), |(index, _)| index);
    value[..end].to_owned()
}

fn codex_threads_from_response(
    value: &Value,
    limit: usize,
    fallback_cwd: &Path,
) -> Vec<crate::agent::ResumableConversation> {
    let Some(data) = value.get("data").and_then(Value::as_array) else {
        return Vec::new();
    };
    let fallback_cwd = fallback_cwd.to_string_lossy().into_owned();
    let mut conversations = Vec::new();
    for value in data {
        let Some(result) = value.as_object() else {
            continue;
        };
        let thread = result
            .get("thread")
            .and_then(Value::as_object)
            .unwrap_or(result);
        let id = thread.get("id").and_then(Value::as_str).unwrap_or_default();
        if id.is_empty()
            || thread.get("ephemeral").and_then(Value::as_bool) == Some(true)
            || thread
                .get("parentThreadId")
                .and_then(Value::as_str)
                .is_some()
        {
            continue;
        }
        let cwd = thread
            .get("cwd")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or(&fallback_cwd);
        if !Path::new(cwd).exists() {
            continue;
        }
        let preview = thread
            .get("preview")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        let snippet = result
            .get("snippet")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        let title = thread
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .or_else(|| {
                preview
                    .lines()
                    .next()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
            })
            .unwrap_or("Codex 对话");
        let created_at = timestamp_ms(thread.get("createdAt"));
        conversations.push(crate::agent::ResumableConversation {
            id: trim_codex(id, 256),
            agent: crate::protocol::AgentKind::Codex,
            title: trim_codex(title, 500),
            preview: (!snippet.is_empty() || !preview.is_empty()).then(|| {
                trim_codex(
                    if !snippet.is_empty() {
                        snippet
                    } else {
                        preview
                    },
                    4_000,
                )
            }),
            cwd: trim_codex(cwd, 4096),
            created_at,
            updated_at: timestamp_ms(thread.get("updatedAt"))
                .or(created_at)
                .unwrap_or_else(crate::database::now),
        });
        if conversations.len() >= limit {
            break;
        }
    }
    conversations
}

pub(crate) async fn search_native_codex_conversations(
    data: &Path,
    query: &str,
    limit: usize,
) -> Result<Vec<crate::agent::ResumableConversation>> {
    let (cwd, env) = native_codex_environment(data)?;
    let mut rpc = CodexRpc::start(cwd.clone(), &env).await?;
    let trimmed = query.trim();
    let params = if trimmed.is_empty() {
        json!({ "limit": limit, "sortKey": "updated_at", "sortDirection": "desc", "archived": false })
    } else {
        json!({ "searchTerm": trimmed, "limit": limit, "sortKey": "updated_at", "sortDirection": "desc", "archived": false })
    };
    let result = async {
        let raw = if trimmed.is_empty() {
            rpc.request("thread/list", params).await?
        } else {
            match rpc.request("thread/search", params.clone()).await {
                Ok(value) => value,
                Err(_) => rpc.request("thread/list", params).await?,
            }
        };
        Ok(codex_threads_from_response(&raw, limit, &cwd))
    }
    .await;
    rpc.shutdown().await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_codex_rate_limits_and_history() {
        let raw = json!({
            "planType": "pro",
            "primary": { "usedPercent": 42.5, "windowDurationMins": 300, "resetsAt": 1_700_000_000 },
            "secondary": { "usedPercent": 9, "windowDurationMins": 10080 },
            "credits": { "unlimited": false, "balance": "12.34" },
            "individualLimit": { "limit": "20", "used": "5", "remainingPercent": 75 }
        });
        let report = usage_from_rate_limits(&raw).unwrap();
        assert_eq!(report.subscription.as_deref(), Some("pro"));
        assert_eq!(report.windows[0].label, "5 小时");
        assert_eq!(
            report.windows[0].resets_at.as_deref(),
            Some("2023-11-14T22:13:20.000Z")
        );
        assert_eq!(report.windows[1].label, "7 天");
        assert_eq!(report.credits_unlimited, Some(false));
        assert_eq!(report.credits_balance.as_deref(), Some("12.34"));
        assert_eq!(report.spend_remaining_percent, Some(75.0));

        let history = usage_from_token_history(&json!({
            "summary": { "lifetimeTokens": "1234.4" },
            "dailyUsageBuckets": [{ "startDate": "2026-09-13", "tokens": 12 }]
        }))
        .unwrap();
        assert_eq!(history.lifetime_tokens, Some(1234));
        assert_eq!(history.daily_usage.unwrap()[0].tokens, 12);
    }
}
