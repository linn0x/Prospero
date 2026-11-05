use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use fs2::FileExt;
use serde_json::{Value, json};
use tempfile::NamedTempFile;
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

fn replace_file_atomically(source: &Path, target: &Path) -> std::io::Result<()> {
    let parent = target
        .parent()
        .ok_or_else(|| std::io::Error::other("target has no parent"))?;
    let mut temporary = NamedTempFile::new_in(parent)?;
    std::io::copy(&mut std::fs::File::open(source)?, &mut temporary)?;
    set_private_file_permissions(temporary.path())?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(target)
        .map(|_| ())
        .map_err(std::io::Error::from)
}

fn prepare_native_codex_environment(home: &Path, sqlite: &Path) -> Result<Vec<(String, String)>> {
    for dir in [home, sqlite] {
        std::fs::create_dir_all(dir)?;
        let _ = set_private_dir_permissions(dir);
    }
    crate::cross_model_tool::install_codex_skill(home)?;
    let lock_path = home.join(".sync.lock");
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(lock_path)?;
    lock.lock_exclusive()?;

    let target_auth = home.join("auth.json");
    let shared_auth = shared_codex_home().join("auth.json");
    if shared_auth != target_auth && shared_auth.exists() {
        let shared_refresh = codex_auth_refresh(&shared_auth);
        let target_refresh = codex_auth_refresh(&target_auth);
        let should_copy = !target_auth.exists()
            || shared_refresh > target_refresh
            || (shared_refresh == target_refresh
                && std::fs::metadata(&shared_auth)?.modified()?
                    > std::fs::metadata(&target_auth)?.modified()?);
        if should_copy {
            replace_file_atomically(&shared_auth, &target_auth)?;
        }
    }
    let target_config = home.join("config.toml");
    let shared_config = shared_codex_home().join("config.toml");
    if shared_config != target_config && shared_config.is_file() {
        let shared_time = std::fs::metadata(&shared_config)?.modified()?;
        let target_time = std::fs::metadata(&target_config)
            .and_then(|value| value.modified())
            .ok();
        if target_time.is_none_or(|time| shared_time > time) {
            replace_file_atomically(&shared_config, &target_config)?;
        }
    }
    let target_models = home.join("models_cache.json");
    let shared_models = shared_codex_home().join("models_cache.json");
    if shared_models != target_models && shared_models.is_file() {
        let shared_time = std::fs::metadata(&shared_models)?.modified()?;
        let target_time = std::fs::metadata(&target_models)
            .and_then(|value| value.modified())
            .ok();
        if target_time.is_none_or(|time| shared_time > time) {
            let _ = replace_file_atomically(&shared_models, &target_models);
        }
    }
    FileExt::unlock(&lock)?;

    Ok(vec![
        ("OPENAI_API_KEY".into(), String::new()),
        ("CODEX_API_KEY".into(), String::new()),
        ("CODEX_ACCESS_TOKEN".into(), String::new()),
        ("CODEX_REFRESH_TOKEN".into(), String::new()),
        ("CODEX_HOME".into(), home.to_string_lossy().into_owned()),
        (
            "CODEX_SQLITE_HOME".into(),
            sqlite.to_string_lossy().into_owned(),
        ),
    ])
}

pub(crate) fn native_codex_environment(data: &Path) -> Result<(PathBuf, Vec<(String, String)>)> {
    let root = data
        .join("agent-accounts")
        .join("codex-usage")
        .join(NATIVE_CODEX_ID);
    std::fs::create_dir_all(&root)?;
    set_private_dir_permissions(&root)?;
    let mut env = crate::accounts::config::read_runtime_environment(data, NATIVE_CODEX_ID)
        .unwrap_or_default();
    env.extend(prepare_native_codex_environment(
        &root.join("home"),
        &root.join("sqlite"),
    )?);
    Ok((user_home().unwrap_or_else(|| PathBuf::from("/")), env))
}

pub(crate) fn native_codex_terminal_environment(data: &Path) -> Result<Vec<(String, String)>> {
    let root = data
        .join("agent-accounts")
        .join("codex")
        .join(NATIVE_CODEX_ID);
    let mut env = crate::accounts::config::read_runtime_environment(data, NATIVE_CODEX_ID)
        .unwrap_or_default();
    env.extend(prepare_native_codex_environment(&root, &root)?);
    Ok(env)
}

struct CodexRpc {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
    cleanup: super::codex::AppServerCleanup,
}

impl CodexRpc {
    async fn start(data: &Path, cwd: PathBuf, env: &[(String, String)]) -> Result<Self> {
        Self::start_with_args(data, cwd, env, &[]).await
    }

    async fn start_with_args(
        data: &Path,
        cwd: PathBuf,
        env: &[(String, String)],
        app_server_args: &[String],
    ) -> Result<Self> {
        super::codex::preflight_app_servers(data, env).await?;
        let mut command = Command::new(codex_binary());
        command
            .arg("app-server")
            .args(app_server_args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(false);
        for (key, value) in env {
            command.env(key, value);
        }
        #[cfg(unix)]
        unsafe {
            command.pre_exec(|| {
                if libc::setpgid(0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = command.spawn().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                Error::Feature("agent_unavailable".into(), "未安装 codex".into())
            } else {
                Error::Io(error)
            }
        })?;
        let child_pid = child.id().ok_or(Error::Closed)?;
        let cleanup = match super::codex::AppServerCleanup::new(data, child_pid, env) {
            Ok(cleanup) => cleanup,
            Err(error) => {
                super::codex::kill_process_group(child_pid);
                let _ = child.start_kill();
                let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
                return Err(error);
            }
        };
        if let Some(mut stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut sink = Vec::new();
                let _ = stderr.read_to_end(&mut sink).await;
            });
        }
        let stdin = match child.stdin.take() {
            Some(stdin) => stdin,
            None => {
                cleanup.terminate(&mut child).await;
                return Err(Error::Closed);
            }
        };
        let stdout = match child.stdout.take() {
            Some(stdout) => stdout,
            None => {
                cleanup.terminate(&mut child).await;
                return Err(Error::Closed);
            }
        };
        let mut rpc = Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 1,
            cleanup,
        };
        let initialized = rpc
            .request(
                "initialize",
                json!({
                    "clientInfo": {
                        "name": "prospero",
                        "title": "Prospero",
                        "version": env!("CARGO_PKG_VERSION"),
                    },
                    "capabilities": { "experimentalApi": true, "requestAttestation": false },
                }),
            )
            .await;
        if let Err(error) = initialized {
            rpc.cleanup.terminate(&mut rpc.child).await;
            return Err(error);
        }
        if let Err(error) = rpc.notify("initialized", json!({})).await {
            rpc.cleanup.terminate(&mut rpc.child).await;
            return Err(error);
        }
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
        self.cleanup.terminate(&mut self.child).await;
    }
}

fn codex_usage_cache() -> &'static std::sync::Mutex<
    std::collections::HashMap<String, (std::time::Instant, Option<UsageReport>)>,
> {
    static CACHE: std::sync::OnceLock<
        std::sync::Mutex<
            std::collections::HashMap<String, (std::time::Instant, Option<UsageReport>)>,
        >,
    > = std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

fn codex_usage_cache_key(data: &Path, cwd: &Path, env: &[(String, String)]) -> String {
    let mut key = format!("{}:{}:", data.display(), cwd.display());
    for (k, v) in env {
        key.push_str(k);
        key.push('=');
        key.push_str(v);
        key.push(';');
    }
    if let Some((_, home)) = env.iter().find(|(k, _)| k == "CODEX_HOME") {
        let auth_path = Path::new(home).join("auth.json");
        if let Ok(meta) = std::fs::metadata(auth_path) {
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            key.push_str(&format!("auth:{mtime}:{};", meta.len()));
        }
    }
    key
}

pub(crate) async fn read_native_codex_usage(data: &Path) -> Result<Option<UsageReport>> {
    let data_for_env = data.to_owned();
    let (cwd, env) = tokio::task::spawn_blocking(move || native_codex_environment(&data_for_env))
        .await
        .map_err(|_| Error::Closed)??;
    read_codex_usage_with_env(data, cwd, &env).await
}

pub(crate) async fn read_codex_usage_for_account(
    data: &Path,
    account_id: &str,
) -> Result<Option<UsageReport>> {
    let data_for_env = data.to_owned();
    let id = account_id.to_owned();
    let env = tokio::task::spawn_blocking(move || {
        crate::accounts::managed::codex_subscription_environment(&data_for_env, &id)
    })
    .await
    .map_err(|_| Error::Closed)??;
    let cwd = user_home().unwrap_or_else(|| PathBuf::from("/"));
    read_codex_usage_with_env(data, cwd, &env).await
}

async fn read_codex_usage_with_env(
    data: &Path,
    cwd: PathBuf,
    env: &[(String, String)],
) -> Result<Option<UsageReport>> {
    let cache_key = std::env::var_os("PROSPERO_CODEX_BIN")
        .is_none()
        .then(|| codex_usage_cache_key(data, &cwd, env));
    if let Some(key) = &cache_key
        && let Ok(guard) = codex_usage_cache().lock()
        && let Some((checked_at, cached)) = guard.get(key)
        && checked_at.elapsed() < Duration::from_secs(20)
    {
        return Ok(cached.clone());
    }
    let mut rpc = CodexRpc::start(data, cwd, env).await?;
    let result = async {
        let mut identity = rpc
            .request("account/read", json!({ "refreshToken": false }))
            .await?;
        if identity.get("account").is_none_or(|value| value.is_null()) {
            identity = rpc
                .request("account/read", json!({ "refreshToken": true }))
                .await?;
        }
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
    if let (Some(key), Ok(report)) = (cache_key, &result)
        && let Ok(mut guard) = codex_usage_cache().lock()
    {
        guard.insert(key, (std::time::Instant::now(), report.clone()));
    }
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
        format!("{rounded} 分钟")
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
    search_codex_conversations_in(data, cwd, env, query, limit).await
}

pub(crate) async fn search_codex_conversations_in(
    data: &Path,
    cwd: PathBuf,
    env: Vec<(String, String)>,
    query: &str,
    limit: usize,
) -> Result<Vec<crate::agent::ResumableConversation>> {
    let mut rpc = CodexRpc::start(data, cwd.clone(), &env).await?;
    let trimmed = query.trim();
    let params = if trimmed.is_empty() {
        json!({ "limit": limit, "sortKey": "updated_at", "sortDirection": "desc", "archived": false })
    } else {
        json!({ "searchTerm": trimmed, "limit": limit, "sortKey": "updated_at", "sortDirection": "desc", "archived": false })
    };
    let result = async {
        let raw = if uuid::Uuid::parse_str(trimmed).is_ok() {
            let response = rpc
                .request(
                    "thread/read",
                    json!({"threadId":trimmed,"includeTurns":false}),
                )
                .await?;
            json!({"data":[response["thread"].clone()]})
        } else if trimmed.is_empty() {
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

fn codex_models_from_response(value: &Value, models: &mut Vec<crate::agent::LaunchModelInfo>) {
    let Some(data) = value.get("data").and_then(Value::as_array) else {
        return;
    };
    for item in data {
        let Some(row) = item.as_object() else {
            continue;
        };
        let id = row
            .get("model")
            .or_else(|| row.get("id"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        if id.is_empty() || id.chars().count() > 160 {
            continue;
        }
        let label = row
            .get("displayName")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or(id);
        let supported_efforts = row
            .get("supportedReasoningEfforts")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|entry| {
                        entry.as_str().or_else(|| {
                            entry
                                .as_object()
                                .and_then(|item| item.get("reasoningEffort"))
                                .and_then(Value::as_str)
                        })
                    })
                    .filter(|value| !value.is_empty())
                    .map(|value| value.chars().take(80).collect::<String>())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        models.push(crate::agent::LaunchModelInfo {
            id: id.to_owned(),
            label: trim_codex(label, 160),
            description: row
                .get("description")
                .and_then(Value::as_str)
                .map(|value| trim_codex(value, 1000)),
            supported_efforts,
            default_effort: row
                .get("defaultReasoningEffort")
                .or_else(|| row.get("default_reasoning_level"))
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(|value| trim_codex(value, 80)),
            is_default: row.get("isDefault").and_then(Value::as_bool) == Some(true),
        });
    }
}

fn codex_models_from_cache_file(path: &Path) -> Option<Vec<crate::agent::LaunchModelInfo>> {
    type CacheKey = (PathBuf, u128, u64);
    static MODEL_FILE_CACHE: std::sync::OnceLock<
        std::sync::Mutex<
            std::collections::HashMap<PathBuf, (u128, u64, Vec<crate::agent::LaunchModelInfo>)>,
        >,
    > = std::sync::OnceLock::new();

    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let len = meta.len();
    let cache = MODEL_FILE_CACHE
        .get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
    if let Ok(guard) = cache.lock()
        && let Some((cached_mtime, cached_len, models)) = guard.get(path)
        && *cached_mtime == mtime
        && *cached_len == len
    {
        return Some(models.clone());
    }

    let _key: CacheKey = (path.to_path_buf(), mtime, len);
    let raw = std::fs::read_to_string(path).ok()?;
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    let rows = parsed.get("models")?.as_array()?;
    let mut models = Vec::new();
    for item in rows {
        let Some(row) = item.as_object() else {
            continue;
        };
        if let Some(visibility) = row.get("visibility").and_then(Value::as_str)
            && visibility != "list"
        {
            continue;
        }
        let id = row
            .get("slug")
            .or_else(|| row.get("model"))
            .or_else(|| row.get("id"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        if id.is_empty() || id.chars().count() > 160 {
            continue;
        }
        let label = row
            .get("display_name")
            .or_else(|| row.get("displayName"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or(id);
        let supported_efforts = row
            .get("supported_reasoning_levels")
            .or_else(|| row.get("supportedReasoningEfforts"))
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|entry| {
                        entry.as_str().or_else(|| {
                            entry
                                .as_object()
                                .and_then(|item| {
                                    item.get("effort").or_else(|| item.get("reasoningEffort"))
                                })
                                .and_then(Value::as_str)
                        })
                    })
                    .filter(|value| !value.is_empty())
                    .map(|value| value.chars().take(80).collect::<String>())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let is_default = models.is_empty();
        models.push(crate::agent::LaunchModelInfo {
            id: id.to_owned(),
            label: trim_codex(label, 160),
            description: row
                .get("description")
                .and_then(Value::as_str)
                .map(|value| trim_codex(value, 1000)),
            supported_efforts,
            default_effort: row
                .get("default_reasoning_level")
                .or_else(|| row.get("defaultReasoningEffort"))
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(|value| trim_codex(value, 80)),
            is_default,
        });
    }
    if models.is_empty() {
        return None;
    }
    if let Ok(mut guard) = cache.lock() {
        guard.insert(path.to_path_buf(), (mtime, len, models.clone()));
    }
    Some(models)
}

fn codex_config_defaults(codex_home: &Path) -> (Option<String>, Option<String>) {
    let Ok(source) = std::fs::read_to_string(codex_home.join("config.toml")) else {
        return (None, None);
    };
    let Ok(config) = toml::from_str::<toml::Value>(&source) else {
        return (None, None);
    };
    let selected = config
        .get("profile")
        .and_then(toml::Value::as_str)
        .and_then(|name| config.get("profiles")?.get(name));
    let value = |key: &str| {
        selected
            .and_then(|table| table.get(key))
            .or_else(|| config.get(key))
            .and_then(toml::Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
    };
    (value("model"), value("model_reasoning_effort"))
}

fn apply_codex_catalog_defaults(
    catalog: &mut crate::agent::LaunchModelCatalog,
    preferred_model: Option<String>,
    preferred_effort: Option<String>,
) {
    if let Some(model_id) = preferred_model
        && catalog.models.iter().any(|model| model.id == model_id)
    {
        catalog.current_model = Some(model_id);
    }
    let active_model = catalog
        .current_model
        .as_deref()
        .and_then(|id| catalog.models.iter().find(|model| model.id == id))
        .or_else(|| catalog.models.iter().find(|model| model.is_default))
        .or_else(|| catalog.models.first());
    if let Some(effort) = preferred_effort
        && active_model
            .is_some_and(|model| model.supported_efforts.iter().any(|item| item == &effort))
    {
        catalog.current_effort = Some(effort);
    } else if catalog.current_effort.is_none() {
        catalog.current_effort = active_model.and_then(|model| model.default_effort.clone());
    }
}

pub(crate) fn fast_codex_catalog_for_account(
    data: &Path,
    account_id: &str,
) -> crate::agent::LaunchModelCatalog {
    let target = crate::accounts::config::ConfigTarget {
        account_id: account_id.to_owned(),
        model: None,
        model_capabilities: None,
        active_sessions: 0,
    };
    let (override_model, override_effort) =
        crate::accounts::config::read_defaults(data, &target).unwrap_or((None, None));
    let account_home = if account_id == NATIVE_CODEX_ID {
        shared_codex_home()
    } else {
        data.join("agent-accounts").join("codex").join(account_id)
    };
    let (config_model, config_effort) = if std::env::var_os("PROSPERO_CODEX_BIN").is_none() {
        let local = codex_config_defaults(&account_home);
        if local.0.is_some() || local.1.is_some() {
            local
        } else {
            codex_config_defaults(&shared_codex_home())
        }
    } else {
        (None, None)
    };
    let models = if std::env::var_os("PROSPERO_CODEX_BIN").is_none() {
        codex_models_from_cache_file(&account_home.join("models_cache.json"))
            .or_else(|| codex_models_from_cache_file(&shared_codex_home().join("models_cache.json")))
    } else {
        None
    }
    .unwrap_or_else(|| {
        vec![crate::agent::LaunchModelInfo {
            id: "default".into(),
            label: "Default".into(),
            description: None,
            supported_efforts: vec![
                "minimal".into(),
                "low".into(),
                "medium".into(),
                "high".into(),
                "xhigh".into(),
                "max".into(),
                "ultra".into(),
            ],
            default_effort: Some("medium".into()),
            is_default: true,
        }]
    });
    let current_model = models
        .iter()
        .find(|model| model.is_default)
        .or_else(|| models.first())
        .map(|model| model.id.clone());
    let mut catalog = crate::agent::LaunchModelCatalog {
        models,
        current_model,
        current_effort: None,
        presets: Vec::new(),
        current_preset: None,
    };
    apply_codex_catalog_defaults(
        &mut catalog,
        override_model.or(config_model),
        override_effort.or(config_effort),
    );
    catalog
}

pub(crate) async fn read_native_codex_models(
    data: &Path,
) -> Result<crate::agent::LaunchModelCatalog> {
    let target = crate::accounts::config::ConfigTarget {
        account_id: NATIVE_CODEX_ID.to_owned(),
        model: None,
        model_capabilities: None,
        active_sessions: 0,
    };
    let (override_model, override_effort) =
        crate::accounts::config::read_defaults(data, &target).unwrap_or((None, None));
    if std::env::var_os("PROSPERO_CODEX_BIN").is_none()
        && let Some(models) =
            codex_models_from_cache_file(&shared_codex_home().join("models_cache.json"))
    {
        let current_model = models
            .iter()
            .find(|model| model.is_default)
            .or_else(|| models.first())
            .map(|model| model.id.clone());
        let mut catalog = crate::agent::LaunchModelCatalog {
            models,
            current_model,
            current_effort: None,
            presets: Vec::new(),
            current_preset: None,
        };
        let (config_model, config_effort) = codex_config_defaults(&shared_codex_home());
        apply_codex_catalog_defaults(
            &mut catalog,
            override_model.or(config_model),
            override_effort.or(config_effort),
        );
        return Ok(catalog);
    }
    let (cwd, env) = native_codex_environment(data)?;
    let mut catalog = read_codex_models(data, cwd, &env, &[]).await?;
    let (config_model, config_effort) = if std::env::var_os("PROSPERO_CODEX_BIN").is_none() {
        codex_config_defaults(&shared_codex_home())
    } else {
        (None, None)
    };
    apply_codex_catalog_defaults(
        &mut catalog,
        override_model.or(config_model),
        override_effort.or(config_effort),
    );
    Ok(catalog)
}

pub(crate) async fn read_codex_models_for_account(
    data: &Path,
    account_id: &str,
) -> Result<crate::agent::LaunchModelCatalog> {
    let data_for_env = data.to_owned();
    let id = account_id.to_owned();
    let (env, (override_model, override_effort)) = tokio::task::spawn_blocking(move || {
        let env = crate::accounts::managed::codex_subscription_environment(&data_for_env, &id)?;
        let target = crate::accounts::config::ConfigTarget {
            account_id: id,
            model: None,
            model_capabilities: None,
            active_sessions: 0,
        };
        let defaults =
            crate::accounts::config::read_defaults(&data_for_env, &target).unwrap_or((None, None));
        Ok::<_, Error>((env, defaults))
    })
    .await
    .map_err(|_| Error::Closed)??;
    let cwd = user_home().unwrap_or_else(|| PathBuf::from("/"));
    let mut catalog = read_codex_models(data, cwd, &env, &[]).await?;
    let (config_model, config_effort) = if std::env::var_os("PROSPERO_CODEX_BIN").is_none() {
        env.iter()
            .find(|(key, _)| key == "CODEX_HOME")
            .map(|(_, path)| codex_config_defaults(Path::new(path)))
            .unwrap_or((None, None))
    } else {
        (None, None)
    };
    apply_codex_catalog_defaults(
        &mut catalog,
        override_model.or(config_model),
        override_effort.or(config_effort),
    );
    Ok(catalog)
}

async fn read_codex_models(
    data: &Path,
    cwd: PathBuf,
    env: &[(String, String)],
    app_server_args: &[String],
) -> Result<crate::agent::LaunchModelCatalog> {
    if std::env::var_os("PROSPERO_CODEX_BIN").is_none() && app_server_args.is_empty() {
        let codex_home = env
            .iter()
            .find(|(key, _)| key == "CODEX_HOME")
            .map(|(_, value)| PathBuf::from(value));
        let cached = codex_home
            .as_deref()
            .and_then(|home| codex_models_from_cache_file(&home.join("models_cache.json")))
            .or_else(|| codex_models_from_cache_file(&shared_codex_home().join("models_cache.json")));
        if let Some(models) = cached {
            let current_model = models
                .iter()
                .find(|model| model.is_default)
                .or_else(|| models.first())
                .map(|model| model.id.clone());
            return Ok(crate::agent::LaunchModelCatalog {
                models,
                current_model,
                current_effort: None,
                presets: Vec::new(),
                current_preset: None,
            });
        }
    }
    let mut rpc = CodexRpc::start_with_args(data, cwd, env, app_server_args).await?;
    let result = async {
        let mut models = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..5 {
            let mut params = serde_json::Map::new();
            params.insert("limit".into(), json!(50));
            params.insert("includeHidden".into(), json!(false));
            if let Some(cursor) = cursor.as_ref() {
                params.insert("cursor".into(), json!(cursor));
            }
            let raw = rpc.request("model/list", Value::Object(params)).await?;
            codex_models_from_response(&raw, &mut models);
            cursor = raw
                .get("nextCursor")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_owned);
            if cursor.is_none() {
                break;
            }
        }
        if models.is_empty() {
            return Err(Error::Invalid("Codex 没有返回可选模型".into()));
        }
        let current_model = models
            .iter()
            .find(|model| model.is_default)
            .or_else(|| models.first())
            .map(|model| model.id.clone());
        Ok(crate::agent::LaunchModelCatalog {
            models,
            current_model,
            current_effort: None,
            presets: Vec::new(),
            current_preset: None,
        })
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

    #[test]
    fn atomic_codex_file_replacement_keeps_readers_on_complete_files() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source");
        let target = directory.path().join("target");
        let first = "{\"tokens\":{\"access_token\":\"first\"}}";
        let second = "{\"tokens\":{\"access_token\":\"second\"}}";
        std::fs::write(&source, first).unwrap();
        std::fs::write(&target, first).unwrap();
        let reader_target = target.clone();
        let reader = std::thread::spawn(move || {
            for _ in 0..500 {
                let value = std::fs::read_to_string(&reader_target).unwrap();
                assert!(value == first || value == second);
            }
        });
        for _ in 0..100 {
            std::fs::write(&source, second).unwrap();
            replace_file_atomically(&source, &target).unwrap();
            std::fs::write(&source, first).unwrap();
            replace_file_atomically(&source, &target).unwrap();
        }
        reader.join().unwrap();
    }

    #[test]
    fn atomic_codex_file_replacement_failure_preserves_target() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("target");
        std::fs::write(&target, "existing").unwrap();
        let result = replace_file_atomically(&directory.path().join("missing"), &target);
        assert!(result.is_err());
        assert_eq!(std::fs::read_to_string(target).unwrap(), "existing");
    }
}
