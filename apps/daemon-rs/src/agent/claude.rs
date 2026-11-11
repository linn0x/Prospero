//! Direct Claude Code CLI driver.
//!
//! The CLI is spawned per turn in headless stream-json mode: prompts go to
//! stdin as JSONL user messages, normalized events come back on stdout.
//! Approvals use `--permission-prompt-tool stdio`: the CLI emits a
//! `control_request` and blocks until we answer on stdin. Multi-turn
//! conversations resume the native session id with `--resume`.

use std::collections::{HashMap, HashSet};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{Mutex, mpsc, oneshot};

use super::lifecycle::{ChildGuard, ProcessLifecycle, Quiescence, await_child_exit};
use super::store::{ApprovalPolicy, PermissionMode};
use crate::error::{Error, Result};
use crate::orchestration::reliability::ControlEffectState;

/// One AskUserQuestion entry, normalized from the tool input.
#[derive(Debug, Clone)]
pub(super) struct QuestionSpec {
    pub(super) id: String,
    pub(super) header: String,
    /// The original question text; the native `answers` map is keyed by it.
    pub(super) native_question: String,
    pub(super) question: String,
    pub(super) options: Vec<QuestionOptionSpec>,
    pub(super) multi_select: bool,
}

#[derive(Debug, Clone)]
pub(super) struct QuestionOptionSpec {
    pub(super) label: String,
    pub(super) description: Option<String>,
    pub(super) preview: Option<String>,
}

/// Answer to a structured question. A cancelled question still allows the
/// tool call with an empty `answers` map (matches the legacy adapter); a
/// dropped sender (turn interrupt/daemon shutdown) denies it.
pub(super) struct QuestionReply {
    pub(super) answers: HashMap<String, String>,
    pub(super) cancelled: bool,
}

/// Semantic events normalized from the CLI JSONL stream.
pub(super) enum AdapterEvent {
    NativeId(String),
    SubagentStarted {
        subagent: String,
        name: String,
        role: Option<String>,
        task: Option<String>,
    },
    SubagentUpdate {
        subagent: String,
        status: &'static str,
        can_message: bool,
        summary: Option<String>,
    },
    Text {
        subagent: Option<String>,
        text: String,
    },
    Thinking {
        subagent: Option<String>,
        text: String,
    },
    ToolCall {
        subagent: Option<String>,
        call_id: String,
        name: String,
        summary: String,
        diff: Option<crate::protocol::FileDiff>,
    },
    ToolResult {
        subagent: Option<String>,
        call_id: String,
        name: String,
        summary: String,
        error: bool,
        diff: Option<crate::protocol::FileDiff>,
        has_more: bool,
    },
    Permission {
        subagent: Option<String>,
        request_id: String,
        tool: String,
        summary: String,
        reply: oneshot::Sender<bool>,
    },
    Question {
        subagent: Option<String>,
        request_id: String,
        questions: Vec<QuestionSpec>,
        reply: oneshot::Sender<QuestionReply>,
    },
    Compact {
        ok: bool,
        message: String,
    },
    Finish {
        interrupted: bool,
        error: Option<String>,
        cost_usd: Option<f64>,
        input_tokens: Option<i64>,
        output_tokens: Option<i64>,
        diffs: Vec<crate::protocol::FileDiff>,
    },
}

pub(super) struct ClaudeTurn {
    stdin: mpsc::Sender<(String, Option<oneshot::Sender<()>>)>,
    /// Live control requests awaiting their correlated `control_response`.
    controls: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>,
    events: Option<mpsc::Receiver<AdapterEvent>>,
    lifecycle: ProcessLifecycle,
}

fn binary() -> String {
    std::env::var("PROSPERO_CLAUDE_BIN").unwrap_or_else(|_| "claude".into())
}

/// Bounded time for the catalog-only `initialize` handshake.
const CATALOG_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
/// Mirrors the status-probe output cap.
const CATALOG_MAX_BYTES: usize = 4 * 1024 * 1024;

/// Bounds a live-turn control request (model/effort switch).
const CONTROL_TIMEOUT: Duration = Duration::from_secs(15);

const CLAUDE_CATALOG_TTL: Duration = Duration::from_secs(1800);
const CLAUDE_CATALOG_FAILURE_TTL: Duration = Duration::from_secs(20);

fn claude_catalog_cache() -> &'static std::sync::Mutex<
    HashMap<String, (std::time::Instant, Vec<crate::agent::LaunchModelInfo>)>,
> {
    static CACHE: std::sync::OnceLock<
        std::sync::Mutex<HashMap<String, (std::time::Instant, Vec<crate::agent::LaunchModelInfo>)>>,
    > = std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

fn claude_catalog_failure_cache()
-> &'static std::sync::Mutex<HashMap<String, (std::time::Instant, String)>> {
    static CACHE: std::sync::OnceLock<
        std::sync::Mutex<HashMap<String, (std::time::Instant, String)>>,
    > = std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

fn claude_catalog_cache_key(environment: &[(String, String)]) -> String {
    environment
        .iter()
        .find(|(key, _)| key == "CLAUDE_CONFIG_DIR")
        .map(|(_, value)| value.clone())
        .unwrap_or_else(|| "native".into())
}

pub(crate) fn claude_settings_defaults(
    config_dir: Option<&std::path::Path>,
) -> (Option<String>, Option<String>) {
    let dir = config_dir.map(std::path::Path::to_path_buf).or_else(|| {
        std::env::var_os("CLAUDE_CONFIG_DIR")
            .map(std::path::PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME")
                    .or_else(|| std::env::var_os("USERPROFILE"))
                    .map(|home| std::path::PathBuf::from(home).join(".claude"))
            })
    });
    let Some(dir) = dir else {
        return (None, None);
    };
    let Ok(raw) = std::fs::read_to_string(dir.join("settings.json")) else {
        return (None, None);
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
        return (None, None);
    };
    let model = parsed
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned);
    let effort = parsed
        .get("effortLevel")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned);
    (model, effort)
}

pub(crate) fn fast_claude_catalog_for_account(
    data: &std::path::Path,
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
    let config_dir = (account_id != crate::accounts::NATIVE_CLAUDE_ID)
        .then(|| crate::accounts::managed::account_root(data, account_id).ok())
        .flatten();
    let cache_key = config_dir
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "native".into());
    let cached_models = claude_catalog_cache()
        .lock()
        .ok()
        .and_then(|guard| guard.get(&cache_key).map(|(_, models)| models.clone()));
    let models = cached_models.unwrap_or_else(|| {
        let efforts = vec![
            "low".to_owned(),
            "medium".to_owned(),
            "high".to_owned(),
            "xhigh".to_owned(),
            "max".to_owned(),
        ];
        vec![crate::agent::LaunchModelInfo {
            id: "default".into(),
            label: "Default".into(),
            description: None,
            supported_efforts: efforts,
            default_effort: None,
            is_default: true,
        }]
    });
    let (settings_model, settings_effort) = claude_settings_defaults(config_dir.as_deref());
    let preferred_model = override_model.or(settings_model);
    let preferred_effort = override_effort.or(settings_effort);
    let current_model = preferred_model
        .filter(|id| models.iter().any(|model| model.id == *id))
        .or_else(|| models.first().map(|model| model.id.clone()));
    let current_effort = preferred_effort.filter(|effort| {
        models
            .iter()
            .find(|model| Some(model.id.as_str()) == current_model.as_deref())
            .or_else(|| models.first())
            .is_some_and(|model| model.supported_efforts.iter().any(|item| item == effort))
    });
    crate::agent::LaunchModelCatalog {
        models,
        current_model,
        current_effort,
        presets: Vec::new(),
        current_preset: None,
    }
}

/// Fetches the launch model catalog without running a user turn: a headless
/// CLI process is started, sent a single `initialize` control request, and
/// shut down after reading its `control_response`. This is the same handshake
/// the official SDK performs before streaming (`supportedModels()`).
pub(super) async fn fetch_launch_catalog(
    environment: &[(String, String)],
) -> Result<Vec<crate::agent::LaunchModelInfo>> {
    let use_cache = std::env::var_os("PROSPERO_CLAUDE_BIN").is_none();
    let cache_key = claude_catalog_cache_key(environment);
    if use_cache
        && let Ok(guard) = claude_catalog_cache().lock()
        && let Some((instant, cached)) = guard.get(&cache_key)
        && instant.elapsed() < CLAUDE_CATALOG_TTL
    {
        return Ok(cached.clone());
    }
    if use_cache
        && let Ok(guard) = claude_catalog_failure_cache().lock()
        && let Some((instant, message)) = guard.get(&cache_key)
        && instant.elapsed() < CLAUDE_CATALOG_FAILURE_TTL
    {
        return Err(Error::Invalid(message.clone()));
    }
    let mut command = Command::new(binary());
    command
        .args([
            "-p",
            "--output-format",
            "stream-json",
            "--input-format",
            "stream-json",
            "--verbose",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    for (key, value) in environment {
        command.env(key, value);
    }
    let mut child = command
        .spawn()
        .map_err(|_| Error::Invalid("Claude CLI 不可用".into()))?;
    let mut stdin = child.stdin.take().ok_or(Error::Closed)?;
    let stdout = child.stdout.take().ok_or(Error::Closed)?;
    let request_id = uuid::Uuid::new_v4().to_string();
    let frame = serde_json::json!({
        "type": "control_request",
        "request_id": request_id,
        "request": {"subtype": "initialize"}
    })
    .to_string();
    stdin
        .write_all(frame.as_bytes())
        .await
        .map_err(|_| Error::Invalid("Claude CLI 不可用".into()))?;
    stdin.write_all(b"\n").await.ok();
    stdin.flush().await.ok();
    drop(stdin);

    let read = async {
        let mut lines = BufReader::new(stdout).lines();
        let mut total = 0usize;
        while let Some(line) = lines.next_line().await.map_err(|_| Error::Closed)? {
            total += line.len() + 1;
            if total > CATALOG_MAX_BYTES {
                return Err(Error::Invalid("Claude 模型目录响应过大".into()));
            }
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if message.get("type").and_then(Value::as_str) != Some("control_response") {
                continue;
            }
            let envelope = message
                .get("response")
                .ok_or_else(|| Error::Invalid("无法读取 Claude 模型目录".into()))?;
            if envelope.get("subtype").and_then(Value::as_str) != Some("success")
                || envelope.get("request_id").and_then(Value::as_str) != Some(&request_id)
            {
                // An error envelope (or a reply to a different request) cannot
                // carry the catalog; keep scanning in case frames reordered.
                continue;
            }
            let payload = envelope
                .get("response")
                .ok_or_else(|| Error::Invalid("无法读取 Claude 模型目录".into()))?;
            let models = parse_catalog_models(payload)?;
            return Ok(models);
        }
        Err(Error::Invalid("无法读取 Claude 模型目录".into()))
    };

    match tokio::time::timeout(CATALOG_TIMEOUT, read).await {
        Ok(Ok(models)) => {
            child.kill().await.ok();
            if use_cache {
                if let Ok(mut fail_guard) = claude_catalog_failure_cache().lock() {
                    fail_guard.remove(&cache_key);
                }
                if let Ok(mut guard) = claude_catalog_cache().lock() {
                    guard.insert(cache_key, (std::time::Instant::now(), models.clone()));
                }
            }
            Ok(models)
        }
        Ok(Err(error)) => {
            child.kill().await.ok();
            if use_cache && let Ok(mut fail_guard) = claude_catalog_failure_cache().lock() {
                fail_guard.insert(cache_key, (std::time::Instant::now(), error.to_string()));
            }
            Err(error)
        }
        Err(_) => {
            child.kill().await.ok();
            let message = "读取 Claude 模型目录超时".to_owned();
            if use_cache && let Ok(mut fail_guard) = claude_catalog_failure_cache().lock() {
                fail_guard.insert(cache_key, (std::time::Instant::now(), message.clone()));
            }
            Err(Error::Invalid(message))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_tool_input_removes_task_model_override() {
        let input = serde_json::json!({"description":"review","prompt":"check","model":"opus"});
        assert_eq!(
            profile_tool_input(true, "Task", input),
            serde_json::json!({"description":"review","prompt":"check"})
        );
    }

    #[test]
    fn profile_tool_input_leaves_non_profile_or_non_task_input() {
        let input = serde_json::json!({"description":"review","prompt":"check","model":"opus"});
        assert_eq!(profile_tool_input(false, "Task", input.clone()), input);
        assert_eq!(
            profile_tool_input(true, "Bash", serde_json::json!({"command":"pwd"})),
            serde_json::json!({"command":"pwd"})
        );
    }

    #[test]
    fn forks_claude_transcript_natively_with_independent_ids_and_frozen_history() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("project");
        std::fs::create_dir_all(&workspace).unwrap();
        let config = root.path().join("claude");
        let project_key: String = workspace
            .to_string_lossy()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect();
        let project = config.join("projects").join(project_key);
        std::fs::create_dir_all(&project).unwrap();
        let session_id = uuid::Uuid::new_v4().to_string();
        let user_id = uuid::Uuid::new_v4().to_string();
        let assistant_id = uuid::Uuid::new_v4().to_string();
        let records = [
            serde_json::json!({
                "sessionId": session_id,
                "cwd": workspace,
                "isSidechain": false,
                "timestamp": "2026-01-01T00:00:00.000Z",
                "version": "2.1.0",
                "type": "user",
                "uuid": user_id,
                "parentUuid": null,
                "message": { "role": "user", "content": "Original question" }
            }),
            serde_json::json!({
                "sessionId": session_id,
                "cwd": workspace,
                "isSidechain": false,
                "timestamp": "2026-01-01T00:00:01.000Z",
                "version": "2.1.0",
                "type": "assistant",
                "uuid": assistant_id,
                "parentUuid": user_id,
                "message": {
                    "role": "assistant",
                    "type": "message",
                    "id": "msg_fixture",
                    "model": "fixture",
                    "content": [{ "type": "text", "text": "Original answer" }],
                    "stop_reason": "end_turn",
                    "stop_sequence": null,
                    "usage": { "input_tokens": 1, "output_tokens": 1 }
                }
            }),
        ];
        let source_path = project.join(format!("{session_id}.jsonl"));
        let original = format!(
            "{}\n{}\n",
            serde_json::to_string(&records[0]).unwrap(),
            serde_json::to_string(&records[1]).unwrap()
        );
        std::fs::write(&source_path, &original).unwrap();
        let forked_id =
            fork_session_file_in_config_dir(&config, &workspace.to_string_lossy(), &session_id)
                .unwrap();
        assert_ne!(forked_id, session_id);
        assert_eq!(std::fs::read_to_string(&source_path).unwrap(), original);
        let target_path = project.join(format!("{forked_id}.jsonl"));
        let copied = std::fs::read_to_string(&target_path).unwrap();
        assert!(copied.contains("Original question"));
        assert!(copied.contains("Original answer"));
        let messages: Vec<Value> = copied
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter(|row| {
                matches!(
                    row.get("type").and_then(Value::as_str),
                    Some("user" | "assistant")
                )
            })
            .collect();
        assert_eq!(messages.len(), 2);
        assert_ne!(
            messages[0].get("uuid").and_then(Value::as_str),
            Some(user_id.as_str())
        );
        assert_eq!(
            messages[1].get("parentUuid").and_then(Value::as_str),
            messages[0].get("uuid").and_then(Value::as_str)
        );
    }
}

/// Parses the `models` array from an `initialize` control_response payload
/// into the public catalog shape. Shared by the launch handshake and the
/// in-session live catalog request.
fn parse_catalog_models(payload: &Value) -> Result<Vec<crate::agent::LaunchModelInfo>> {
    let raw_models = payload
        .get("models")
        .and_then(Value::as_array)
        .ok_or_else(|| Error::Invalid("Claude 没有返回可选模型".into()))?;
    let mut models = Vec::new();
    for (index, raw) in raw_models.iter().enumerate() {
        let id = raw
            .get("value")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if id.is_empty() || id.chars().count() > 160 {
            continue;
        }
        let label = raw
            .get("displayName")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or(&id)
            .chars()
            .take(160)
            .collect::<String>();
        let description = raw
            .get("description")
            .and_then(Value::as_str)
            .map(|value| value.chars().take(1000).collect::<String>());
        let supported_efforts = raw
            .get("supportedEffortLevels")
            .and_then(Value::as_array)
            .map(|levels| {
                levels
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|level| level.chars().take(80).collect::<String>())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        models.push(crate::agent::LaunchModelInfo {
            id,
            label,
            description,
            supported_efforts,
            default_effort: None,
            is_default: index == 0,
        });
    }
    if models.is_empty() {
        return Err(Error::Invalid("Claude 没有返回可选模型".into()));
    }
    Ok(models)
}

/// Per-turn CLI selections persisted on the session run.
pub(super) struct TurnOptions {
    pub(super) policy: ApprovalPolicy,
    pub(super) mode: PermissionMode,
    pub(super) model: Option<String>,
    pub(super) effort: Option<String>,
    pub(super) agent_preset: Option<String>,
    /// Managed-account environment overrides (empty for the native env).
    pub(super) environment: Vec<(String, String)>,
    /// Non-secret API profile metadata for runtimes that need launch-time
    /// configuration in addition to environment variables.
    pub(super) api_profile: Option<crate::accounts::ApiProfile>,
}

fn resolve_claude_config_dir(environment: &[(String, String)]) -> Option<std::path::PathBuf> {
    if let Some((_, value)) = environment.iter().find(|(k, _)| k == "CLAUDE_CONFIG_DIR")
        && !value.trim().is_empty()
    {
        return Some(std::path::PathBuf::from(value));
    }
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR")
        && !dir.is_empty()
    {
        return Some(std::path::PathBuf::from(dir));
    }
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(|home| std::path::PathBuf::from(home).join(".claude"))
}

fn find_claude_session_file(
    config_dir: &std::path::Path,
    workspace: &str,
    source: &str,
) -> Option<std::path::PathBuf> {
    let file_name = format!("{source}.jsonl");
    let projects_root = config_dir.join("projects");
    let canonical = std::fs::canonicalize(workspace)
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| workspace.to_owned());
    for candidate_ws in [canonical.as_str(), workspace] {
        let project_key: String = candidate_ws
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect();
        let direct = projects_root.join(&project_key).join(&file_name);
        if direct.is_file() {
            return Some(direct);
        }
    }
    let entries = std::fs::read_dir(&projects_root).ok()?;
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let candidate = dir.join(&file_name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn fork_session_file_in_config_dir(
    config_dir: &std::path::Path,
    workspace: &str,
    source: &str,
) -> Result<String> {
    let source_path = find_claude_session_file(config_dir, workspace, source)
        .ok_or_else(|| Error::Invalid(format!("未找到 Claude 原生会话文件: {source}")))?;
    let raw = std::fs::read_to_string(&source_path)?;
    let mut all_rows = Vec::new();
    let mut custom_title: Option<String> = None;
    let mut ai_title: Option<String> = None;
    let mut content_replacements: Vec<Value> = Vec::new();
    let mut relocated_cwd: Option<String> = None;

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(row) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if let Some(t) = row
            .get("customTitle")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            custom_title = Some(t.to_owned());
        }
        if let Some(t) = row
            .get("aiTitle")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            ai_title = Some(t.to_owned());
        }
        match row.get("type").and_then(Value::as_str) {
            Some("content-replacement") => {
                if let Some(arr) = row.get("replacements").and_then(Value::as_array) {
                    content_replacements.extend(arr.iter().cloned());
                }
            }
            Some("relocated") => {
                if let Some(cwd) = row.get("relocatedCwd").and_then(Value::as_str) {
                    relocated_cwd = Some(cwd.to_owned());
                }
            }
            Some("user" | "assistant" | "attachment" | "system" | "progress") => {
                if row.get("isSidechain").and_then(Value::as_bool) != Some(true) {
                    all_rows.push(row);
                }
            }
            _ => {}
        }
    }

    if all_rows.is_empty() {
        return Err(Error::Invalid("Claude 原生会话没有可分支的消息记录".into()));
    }

    let mut uuid_map = HashMap::new();
    let mut by_uuid = HashMap::new();
    for row in &all_rows {
        if let Some(u) = row.get("uuid").and_then(Value::as_str) {
            uuid_map.insert(u.to_owned(), uuid::Uuid::new_v4().to_string());
            by_uuid.insert(u.to_owned(), row.clone());
        }
    }

    let non_progress: Vec<Value> = all_rows
        .into_iter()
        .filter(|row| row.get("type").and_then(Value::as_str) != Some("progress"))
        .collect();
    if non_progress.is_empty() {
        return Err(Error::Invalid("Claude 原生会话没有可分支的消息记录".into()));
    }

    let forked_id = uuid::Uuid::new_v4().to_string();
    let now_ms = crate::database::now();
    let now_iso = format!("{}.{:03}Z", (now_ms / 1000).max(0), (now_ms % 1000).max(0));
    let mut out_lines = Vec::new();
    let total = non_progress.len();

    for (idx, mut row) in non_progress.into_iter().enumerate() {
        let old_uuid = row
            .get("uuid")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let new_uuid = uuid_map
            .get(&old_uuid)
            .cloned()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

        let mut resolved_parent: Option<String> = None;
        let mut cursor = row
            .get("parentUuid")
            .and_then(Value::as_str)
            .map(str::to_owned);
        while let Some(parent_id) = cursor {
            let Some(parent_row) = by_uuid.get(&parent_id) else {
                break;
            };
            if parent_row.get("type").and_then(Value::as_str) != Some("progress") {
                resolved_parent = uuid_map.get(&parent_id).cloned();
                break;
            }
            cursor = parent_row
                .get("parentUuid")
                .and_then(Value::as_str)
                .map(str::to_owned);
        }

        let logical_parent = row
            .get("logicalParentUuid")
            .and_then(Value::as_str)
            .and_then(|id| uuid_map.get(id).cloned());

        let is_refusal_fallback = row.get("type").and_then(Value::as_str) == Some("system")
            && row.get("subtype").and_then(Value::as_str) == Some("model_refusal_fallback");

        if let Some(obj) = row.as_object_mut() {
            if is_refusal_fallback {
                obj.insert("neutralizedByFork".into(), Value::Bool(true));
            }
            obj.insert("uuid".into(), Value::String(new_uuid));
            obj.insert(
                "parentUuid".into(),
                resolved_parent.map_or(Value::Null, Value::String),
            );
            if obj.contains_key("logicalParentUuid") {
                obj.insert(
                    "logicalParentUuid".into(),
                    logical_parent.map_or(Value::Null, Value::String),
                );
            }
            obj.insert("sessionId".into(), Value::String(forked_id.clone()));
            if idx + 1 == total {
                obj.insert("timestamp".into(), Value::String(now_iso.clone()));
            }
            obj.insert("isSidechain".into(), Value::Bool(false));
            obj.remove("teamName");
            obj.remove("agentName");
            obj.remove("sessionKind");
            obj.remove("slug");
            obj.remove("sourceToolAssistantUUID");
            obj.insert(
                "forkedFrom".into(),
                serde_json::json!({
                    "sessionId": source,
                    "messageUuid": old_uuid,
                }),
            );
        }
        out_lines.push(serde_json::to_string(&row)?);
    }

    if !content_replacements.is_empty() {
        out_lines.push(serde_json::to_string(&serde_json::json!({
            "type": "content-replacement",
            "sessionId": forked_id,
            "replacements": content_replacements,
            "uuid": uuid::Uuid::new_v4().to_string(),
            "timestamp": now_iso,
        }))?);
    }
    if let Some(cwd) = relocated_cwd {
        out_lines.push(serde_json::to_string(&serde_json::json!({
            "type": "relocated",
            "sessionId": forked_id,
            "relocatedCwd": cwd,
        }))?);
    }
    let title = custom_title
        .or(ai_title)
        .unwrap_or_else(|| "Forked session".into());
    out_lines.push(serde_json::to_string(&serde_json::json!({
        "type": "custom-title",
        "sessionId": forked_id,
        "customTitle": format!("{title} (fork)"),
        "uuid": uuid::Uuid::new_v4().to_string(),
        "timestamp": now_iso,
    }))?);

    let parent_dir = source_path
        .parent()
        .ok_or_else(|| Error::Invalid("Claude 会话目录无效".into()))?;
    let dest_path = parent_dir.join(format!("{forked_id}.jsonl"));
    let mut output = out_lines.join("\n");
    output.push('\n');
    std::fs::write(&dest_path, output)?;
    Ok(forked_id)
}

/// Fork the persisted transcript without starting an inference turn.
pub(super) async fn fork_session(
    workspace: &str,
    source: &str,
    options: &TurnOptions,
) -> Result<String> {
    crate::database::validate_id(source)?;
    if let Some(helper) =
        std::env::var_os("PROSPERO_CLAUDE_FORK_HELPER").map(std::path::PathBuf::from)
    {
        let node = std::env::var_os("PROSPERO_NODE").unwrap_or_else(|| "node".into());
        let mut command = Command::new(node);
        command
            .arg(helper)
            .arg(source)
            .arg(workspace)
            .current_dir(workspace)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        for (key, value) in &options.environment {
            command.env(key, value);
        }
        let output = tokio::time::timeout(Duration::from_secs(30), command.output())
            .await
            .map_err(|_| Error::Timeout)??;
        let reply: Value = serde_json::from_slice(&output.stdout)
            .map_err(|_| Error::Invalid("Claude 分支组件返回了无效响应".into()))?;
        if !output.status.success() {
            return Err(Error::Invalid(
                reply
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("无法创建 Claude 聊天分支")
                    .to_owned(),
            ));
        }
        let id = reply
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|id| *id != source)
            .ok_or_else(|| Error::Invalid("Claude 未返回独立的分支会话".into()))?;
        uuid::Uuid::parse_str(id).map_err(|_| Error::Invalid("Claude 分支会话 ID 无效".into()))?;
        return Ok(id.to_owned());
    }

    let config_dir = resolve_claude_config_dir(&options.environment)
        .ok_or_else(|| Error::Invalid("未找到 Claude 配置目录".into()))?;
    fork_session_file_in_config_dir(&config_dir, workspace, source)
}

pub(super) fn spawn_turn(
    workspace: &str,
    prompt: &str,
    attachments: &[crate::agent::AttachmentInput],
    native_id: Option<&str>,
    options: &TurnOptions,
) -> Result<ClaudeTurn> {
    let mut command = Command::new(binary());
    command
        .args([
            "-p",
            "--output-format",
            "stream-json",
            "--input-format",
            "stream-json",
            "--include-partial-messages",
            "--permission-prompt-tool",
            "stdio",
            "--verbose",
        ])
        .current_dir(workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(false);
    for (key, value) in &options.environment {
        command.env(key, value);
    }
    if let Some(id) = native_id {
        command.arg(format!("--resume={id}"));
    }
    if options.mode == PermissionMode::Plan {
        // Plan mode: the CLI investigates and plans but does not apply edits.
        command.args(["--permission-mode", "plan"]);
    }
    if let Some(model) = &options.model {
        command.args(["--model", model]);
    }
    let effective_effort = options.api_profile.as_ref().map_or_else(
        || options.effort.clone(),
        |profile| {
            crate::accounts::profile::normalize_profile_effort(profile, options.effort.as_deref())
        },
    );
    if let Some(effort) = &effective_effort {
        command.args(["--effort", effort]);
    }
    super::lifecycle::configure_process_group(&mut command);
    let child = command.spawn()?;
    let mut guard = ChildGuard::new(child)?;
    let lifecycle = guard.lifecycle();
    let mut stdin = guard.child_mut().stdin.take().ok_or(Error::Closed)?;
    let stdout = guard.child_mut().stdout.take().ok_or(Error::Closed)?;

    let (frames_tx, mut frames_rx) = mpsc::channel::<(String, Option<oneshot::Sender<()>>)>(32);
    let (events_tx, events_rx) = mpsc::channel::<AdapterEvent>(64);
    // request_id -> waiter for the CLI's correlated `control_response`.
    let controls: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>> =
        Arc::new(Mutex::new(HashMap::new()));

    // Serialize stdin writes (prompts, steers and permission responses). An
    // optional ack lets a steer wait for the actual write so a broken pipe
    // (the CLI closed stdin / exited) degrades to the queue instead of
    // silently dropping the message.
    tokio::spawn(async move {
        while let Some((frame, ack)) = frames_rx.recv().await {
            if stdin.write_all(frame.as_bytes()).await.is_err()
                || stdin.write_all(b"\n").await.is_err()
                || stdin.flush().await.is_err()
            {
                break; // dropping `ack` reports the failed write
            }
            if let Some(ack) = ack {
                let _ = ack.send(());
            }
        }
    });

    // Channel the opening prompt once both tasks are running. Images come
    // first so the model sees them before the question (legacy order).
    let initial = user_frame(prompt, attachments);
    let prompt_writer = frames_tx.clone();
    tokio::spawn(async move {
        let _ = prompt_writer.send((initial, None)).await;
    });

    // Read and translate the JSONL stream.
    let auto = options.policy == ApprovalPolicy::Auto;
    let profile_model = options
        .environment
        .iter()
        .any(|(key, value)| key == "PROSPERO_API_PROFILE_MODEL" && !value.trim().is_empty());
    let reader_writer = frames_tx.clone();
    let reader_controls = controls.clone();
    let reader_lifecycle = lifecycle.clone();
    let (mut child, _) = guard.into_child();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        let mut translator = Translator::default();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            // Correlate replies to our own control_requests (set_model /
            // apply_flag_settings) before the translator ignores them.
            if message.get("type").and_then(Value::as_str) == Some("control_response")
                && let Some(request_id) = message
                    .get("response")
                    .and_then(|r| r.get("request_id"))
                    .and_then(Value::as_str)
                && let Some(waiter) = reader_controls.lock().await.remove(request_id)
            {
                let envelope = message
                    .get("response")
                    .cloned()
                    .unwrap_or_else(|| message.clone());
                let _ = waiter.send(envelope);
            }
            for outgoing in translator.feed(message, auto, profile_model, &reader_writer) {
                if events_tx.send(outgoing).await.is_err() {
                    reader_lifecycle.request_termination().await;
                    await_child_exit(&mut child, &reader_lifecycle).await;
                    return;
                }
            }
            if translator.finished {
                // The CLI delivered its result but would otherwise stay alive
                // waiting for another prompt on stdin; end the process group
                // (multi-turn conversations resume via --resume).
                let _ = reader_lifecycle.request_termination().await;
                break;
            }
        }
        if !translator.finished {
            reader_lifecycle.request_termination().await;
        }
        let wait_error = match await_child_exit(&mut child, &reader_lifecycle).await {
            Quiescence::Confirmed | Quiescence::DirectChildExited if translator.finished => None,
            Quiescence::Confirmed | Quiescence::DirectChildExited => {
                Some("Claude event stream closed before a terminal result".into())
            }
            Quiescence::Unknown => Some("Claude executor process group exit is unknown".into()),
        };
        let finish_error = if translator.aborted {
            None
        } else {
            translator.error.or(wait_error)
        };
        let reason = if translator.interrupted {
            "工具调用已中断"
        } else {
            finish_error
                .as_deref()
                .unwrap_or("Claude event stream closed before tool result")
        };
        for event in translator.in_flight_tools.drain_unfinished(reason) {
            if events_tx.send(event).await.is_err() {
                return;
            }
        }
        events_tx
            .send(AdapterEvent::Finish {
                interrupted: translator.interrupted,
                error: finish_error,
                cost_usd: translator.cost_usd,
                input_tokens: translator.input_tokens,
                output_tokens: translator.output_tokens,
                diffs: Vec::new(),
            })
            .await
            .ok();
    });

    Ok(ClaudeTurn {
        stdin: frames_tx,
        controls,
        events: Some(events_rx),
        lifecycle,
    })
}

impl ClaudeTurn {
    pub(super) fn take_events(&mut self) -> Option<mpsc::Receiver<AdapterEvent>> {
        self.events.take()
    }

    pub(super) fn interrupt(&self) -> ControlEffectState {
        let frame = serde_json::json!({
            "type": "control_request",
            "request_id": uuid::Uuid::new_v4().to_string(),
            "request": {"subtype": "interrupt"}
        })
        .to_string();
        if self.stdin.try_send((frame, None)).is_ok() {
            ControlEffectState::Received
        } else {
            ControlEffectState::Failed
        }
    }

    /// Send an extra user message into the running turn ("引导"). The
    /// stream-json CLI keeps reading stdin frames after the opening prompt;
    /// a broken pipe (the result frame ended the turn) surfaces as an error
    /// and the caller falls back to the front of the queue.
    pub(super) async fn steer(
        &self,
        text: &str,
        attachments: &[crate::agent::AttachmentInput],
    ) -> Result<()> {
        self.send_user(text, attachments).await
    }

    pub(super) async fn compact(&self) -> Result<()> {
        self.send_user("/compact", &[]).await
    }

    async fn send_user(
        &self,
        text: &str,
        attachments: &[crate::agent::AttachmentInput],
    ) -> Result<()> {
        let frame = user_frame(text, attachments);
        let (ack, ack_rx) = oneshot::channel();
        self.stdin
            .send((frame, Some(ack)))
            .await
            .map_err(|_| Error::Closed)?;
        ack_rx.await.map_err(|_| Error::Closed)
    }

    pub(super) async fn kill(&self) -> ControlEffectState {
        self.lifecycle.request_termination().await
    }

    pub(super) fn lifecycle(&self) -> ProcessLifecycle {
        self.lifecycle.clone()
    }

    /// Switch the live turn's model/effort via the CLI's control channel.
    /// Persisted selections already apply to the next turn through argv;
    /// this forwards the switch to the running process as well, mirroring
    /// the legacy adapter's `setModel`/`applyFlagSettings`.
    pub(super) async fn apply_selection(&self, model: &str, effort: Option<&str>) -> Result<()> {
        self.control_request(serde_json::json!({"subtype": "set_model", "model": model}))
            .await?;
        if let Some(effort) = effort {
            self.control_request(serde_json::json!({
                "subtype": "apply_flag_settings",
                "settings": {"effortLevel": effort}
            }))
            .await?;
        }
        Ok(())
    }

    /// Writes one control request and waits for the correlated success
    /// `control_response` (the SDK correlates by request_id the same way).
    async fn control_request(&self, request: Value) -> Result<Value> {
        let request_id = uuid::Uuid::new_v4().to_string();
        let (reply, reply_rx) = oneshot::channel();
        self.controls.lock().await.insert(request_id.clone(), reply);
        let frame = serde_json::json!({
            "type": "control_request",
            "request_id": request_id,
            "request": request,
        })
        .to_string();
        let (ack, ack_rx) = oneshot::channel();
        if self.stdin.send((frame, Some(ack))).await.is_err() {
            self.controls.lock().await.remove(&request_id);
            return Err(Error::Closed);
        }
        if ack_rx.await.is_err() {
            self.controls.lock().await.remove(&request_id);
            return Err(Error::Closed);
        }
        let envelope = match tokio::time::timeout(CONTROL_TIMEOUT, reply_rx).await {
            Ok(Ok(envelope)) => envelope,
            Ok(Err(_)) => return Err(Error::Closed),
            Err(_) => {
                self.controls.lock().await.remove(&request_id);
                return Err(Error::Invalid("Claude 模型切换超时".into()));
            }
        };
        if envelope.get("subtype").and_then(Value::as_str) == Some("success") {
            Ok(envelope.get("response").cloned().unwrap_or(Value::Null))
        } else {
            let detail = envelope
                .get("message")
                .or_else(|| envelope.get("error"))
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
                .unwrap_or("Claude 拒绝了模型切换");
            Err(Error::Invalid(detail.chars().take(500).collect()))
        }
    }

    #[allow(dead_code)]
    pub(super) fn pid(&self) -> u32 {
        self.lifecycle.pid()
    }
}

/// Build a headless stream-json user frame. With attachments the content is
/// image-blocks-first array content; plain text stays a bare string so simple
/// turns keep the exact frame shape the CLI has always received.
fn user_frame(text: &str, attachments: &[crate::agent::AttachmentInput]) -> String {
    if attachments.is_empty() {
        serde_json::json!({"type":"user","message":{"role":"user","content":text}}).to_string()
    } else {
        let mut blocks: Vec<serde_json::Value> = attachments
            .iter()
            .map(|attachment| {
                serde_json::json!({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": attachment.mime_type,
                        "data": attachment.data_b64,
                    }
                })
            })
            .collect();
        if !text.is_empty() {
            blocks.push(serde_json::json!({"type": "text", "text": text}));
        }
        serde_json::json!({"type":"user","message":{"role":"user","content":blocks}}).to_string()
    }
}

#[derive(Default)]
struct Translator {
    native_id: Option<String>,
    blocks: HashMap<u32, String>,
    /// Content blocks streamed by a Task-tool subagent (`stream_event` frames
    /// only carry the block index; ownership comes from the parent id).
    block_owners: HashMap<u32, String>,
    tool_names: HashMap<String, String>,
    in_flight_tools: super::turn_stream::InFlightTools,
    /// Native task/tool-use ids -> public subagent id (mirrors the legacy
    /// adapter's taskAgents map).
    task_agents: HashMap<String, String>,
    /// Background tasks without `subagent_type` (e.g. shell tasks) are not
    /// subagents; their output stays on the main timeline.
    non_subagent_tasks: HashSet<String>,
    /// Subagents whose lifecycle events were already emitted this turn.
    known: HashSet<String>,
    interrupted: bool,
    aborted: bool,
    error: Option<String>,
    cost_usd: Option<f64>,
    input_tokens: Option<i64>,
    output_tokens: Option<i64>,
    /// A `result` frame marks the end of this turn. The real CLI keeps the
    /// stream-json process alive afterwards waiting for another prompt, so the
    /// reader must terminate the process rather than wait for exit.
    finished: bool,
}

fn summarize(mut value: String, maximum: usize) -> String {
    value.retain(|c| c != '\u{0}' && (c == '\n' || c == '\t' || !c.is_control()));
    if value.len() > maximum {
        let mut end = maximum;
        while !value.is_char_boundary(end) {
            end -= 1;
        }
        value.truncate(end);
        value.push('…');
    }
    value
}

fn tool_summary(input: &Value) -> String {
    let picked = input
        .get("command")
        .or_else(|| input.get("file_path"))
        .or_else(|| input.get("path"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    summarize(picked.to_owned(), 2000)
}

fn profile_tool_input(profile_model: bool, tool: &str, input: Value) -> Value {
    if !profile_model || !matches!(tool, "Task" | "Agent") {
        return input;
    }
    let Value::Object(mut object) = input else {
        return input;
    };
    object.remove("model");
    Value::Object(object)
}

/// Rebuild the tool input with the native `answers` map the CLI expects.
fn merge_answers(input: &Value, answers: &serde_json::Map<String, Value>) -> Value {
    let mut merged = match input {
        Value::Object(map) => map.clone(),
        _ => serde_json::Map::new(),
    };
    merged.insert("answers".into(), Value::Object(answers.clone()));
    Value::Object(merged)
}

impl Translator {
    /// Resolve the owning subagent of a frame, mirroring the legacy adapter:
    /// a native task id maps to a public tool-use id, and background tasks
    /// without `subagent_type` stay on the main timeline.
    fn agent_of(&self, message: &Value) -> Option<String> {
        let raw = message.get("parent_tool_use_id").and_then(Value::as_str)?;
        if raw.is_empty() {
            return None;
        }
        let id = self
            .task_agents
            .get(raw)
            .map_or(raw, |public| public.as_str());
        (!self.non_subagent_tasks.contains(id)).then(|| id.to_owned())
    }

    /// Translate one CLI frame into zero or more normalized events.
    fn feed(
        &mut self,
        message: Value,
        auto: bool,
        profile_model: bool,
        writer: &mpsc::Sender<(String, Option<oneshot::Sender<()>>)>,
    ) -> Vec<AdapterEvent> {
        let mut out = Vec::new();
        let frame_type = message.get("type").and_then(Value::as_str);
        // task_started/progress/notification arrive as system frames before
        // the subagent's own messages; init carries the native session id.
        if frame_type == Some("system") {
            self.translate_system(&message, &mut out);
            return out;
        }
        let agent = self.agent_of(&message);
        // First frame attributed to a subagent without a preceding task_started
        // still needs a card; task_started normally supplied name/task already.
        if let Some(id) = &agent
            && self.known.insert(id.clone())
        {
            out.push(AdapterEvent::SubagentStarted {
                subagent: id.clone(),
                name: String::new(),
                role: None,
                task: None,
            });
        }
        match frame_type {
            Some("stream_event") => {
                if let Some(event) = message.get("event") {
                    self.translate_stream(event, agent, &mut out);
                }
            }
            Some("assistant") => {
                if let Some(content) = message
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(Value::as_array)
                {
                    for block in content {
                        if block.get("type").and_then(Value::as_str) == Some("tool_use") {
                            let Some(call_id) = block.get("id").and_then(Value::as_str) else {
                                continue;
                            };
                            let name = block
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or("tool")
                                .to_owned();
                            self.tool_names.insert(call_id.to_owned(), name.clone());
                            self.in_flight_tools.record_start_with_subagent(
                                agent.as_deref(),
                                call_id,
                                &name,
                            );
                            let summary = block.get("input").map(tool_summary).unwrap_or_default();
                            out.push(AdapterEvent::ToolCall {
                                subagent: agent.clone(),
                                call_id: call_id.to_owned(),
                                name,
                                summary,
                                diff: None,
                            });
                        }
                    }
                }
            }
            Some("user") => {
                if let Some(content) = message.get("message").and_then(|m| m.get("content")) {
                    let blocks = match content {
                        Value::Array(blocks) => blocks.clone(),
                        Value::String(text) => {
                            vec![serde_json::json!({"type":"text","text":text})]
                        }
                        _ => Vec::new(),
                    };
                    for block in blocks {
                        if block.get("type").and_then(Value::as_str) == Some("tool_result") {
                            let call_id = block
                                .get("tool_use_id")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_owned();
                            let error = block
                                .get("is_error")
                                .and_then(Value::as_bool)
                                .unwrap_or(false);
                            let summary = match block.get("content") {
                                Some(Value::String(text)) => summarize(text.clone(), 2000),
                                Some(Value::Array(parts)) => summarize(
                                    parts
                                        .iter()
                                        .filter_map(|part| part.get("text").and_then(Value::as_str))
                                        .collect::<Vec<_>>()
                                        .join("\n"),
                                    2000,
                                ),
                                _ => String::new(),
                            };
                            self.in_flight_tools
                                .record_result_with_subagent(agent.as_deref(), &call_id);
                            out.push(AdapterEvent::ToolResult {
                                subagent: agent.clone(),
                                name: self
                                    .tool_names
                                    .get(&call_id)
                                    .cloned()
                                    .unwrap_or_else(|| "tool".into()),
                                call_id,
                                summary,
                                error,
                                diff: None,
                                has_more: false,
                            });
                        }
                    }
                }
            }
            Some("control_request") => {
                if let Some(request) = message.get("request")
                    && request.get("subtype").and_then(Value::as_str) == Some("can_use_tool")
                {
                    let request_id = message
                        .get("request_id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned();
                    let tool = request
                        .get("tool_name")
                        .and_then(Value::as_str)
                        .unwrap_or("tool")
                        .to_owned();
                    let input = profile_tool_input(
                        profile_model,
                        &tool,
                        request.get("input").cloned().unwrap_or(Value::Null),
                    );
                    if tool == "AskUserQuestion" {
                        // Questions are an interaction, not an approval: they
                        // surface even under auto-approval policy (mirrors the
                        // legacy adapter, which intercepts before policy).
                        self.translate_question(&mut out, writer, agent, request_id, input);
                    } else if auto {
                        let frame = serde_json::json!({
                            "type":"control_response",
                            "response":{"subtype":"success","request_id":request_id,
                                "response":{"behavior":"allow","updatedInput":input}}
                        })
                        .to_string();
                        let _ = writer.try_send((frame, None));
                    } else {
                        let (reply, receiver) = oneshot::channel();
                        let writer = writer.clone();
                        let rid = request_id.clone();
                        let response_input = input.clone();
                        tokio::spawn(async move {
                            let allow = receiver.await.unwrap_or(false);
                            // The CLI requires a deny response to carry a
                            // `message`; a bare deny is rejected as an invalid
                            // callback result and the model retries the tool.
                            let response = if allow {
                                serde_json::json!({"behavior":"allow","updatedInput":response_input})
                            } else {
                                serde_json::json!({"behavior":"deny",
                                    "message":"The user denied this action."})
                            };
                            let frame = serde_json::json!({
                                "type":"control_response",
                                "response":{"subtype":"success","request_id":rid,
                                    "response":response}
                            })
                            .to_string();
                            let _ = writer.send((frame, None)).await;
                        });
                        out.push(AdapterEvent::Permission {
                            subagent: agent,
                            request_id,
                            tool,
                            summary: tool_summary(&input),
                            reply,
                        });
                    }
                }
            }
            Some("result") => {
                self.finished = true;
                self.cost_usd = message
                    .get("total_cost_usd")
                    .and_then(Value::as_f64)
                    .filter(|value| *value >= 0.0);
                let usage = message.get("usage");
                self.input_tokens = usage
                    .and_then(|value| value.get("input_tokens"))
                    .and_then(Value::as_i64)
                    .filter(|value| *value >= 0);
                self.output_tokens = usage
                    .and_then(|value| value.get("output_tokens"))
                    .and_then(Value::as_i64)
                    .filter(|value| *value >= 0);
                let interrupted = message
                    .get("terminal_reason")
                    .and_then(Value::as_str)
                    .is_some_and(|reason| reason.contains("abort"));
                if interrupted {
                    self.interrupted = true;
                    self.aborted = true;
                }
                let is_error = message
                    .get("is_error")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if is_error && !interrupted {
                    let detail = message
                        .get("errors")
                        .and_then(Value::as_array)
                        .map(|errors| {
                            errors
                                .iter()
                                .filter_map(|error| error.as_str())
                                .collect::<Vec<_>>()
                                .join("; ")
                        })
                        .filter(|text| !text.is_empty())
                        .unwrap_or_else(|| "agent run failed".to_owned());
                    self.error = Some(detail);
                }
                let reason = if self.interrupted {
                    "工具调用已中断"
                } else {
                    self.error.as_deref().unwrap_or("工具调用未返回结果")
                };
                out.extend(self.in_flight_tools.drain_unfinished(reason));
            }
            _ => {}
        }
        out
    }

    /// Normalize an AskUserQuestion tool request and block the CLI on a
    /// oneshot until the user answers (mirrors the legacy adapter's
    /// `requestUserQuestion`).
    fn translate_question(
        &mut self,
        out: &mut Vec<AdapterEvent>,
        writer: &mpsc::Sender<(String, Option<oneshot::Sender<()>>)>,
        agent: Option<String>,
        request_id: String,
        input: Value,
    ) {
        let mut specs = Vec::new();
        if let Some(native) = input.get("questions").and_then(Value::as_array) {
            for (index, row) in native.iter().enumerate() {
                let Some(row) = row.as_object() else {
                    continue;
                };
                let native_question = row
                    .get("question")
                    .and_then(Value::as_str)
                    .unwrap_or("请选择")
                    .to_owned();
                let id = format!("q{}", index + 1);
                let options = row
                    .get("options")
                    .and_then(Value::as_array)
                    .map(|choices| {
                        choices
                            .iter()
                            .filter_map(|choice| {
                                let choice = choice.as_object()?;
                                let label = choice.get("label")?.as_str()?;
                                Some(QuestionOptionSpec {
                                    label: summarize(label.to_owned(), 500),
                                    description: choice
                                        .get("description")
                                        .and_then(Value::as_str)
                                        .map(|text| summarize(text.to_owned(), 2000)),
                                    preview: choice
                                        .get("preview")
                                        .and_then(Value::as_str)
                                        .map(|text| summarize(text.to_owned(), 2000)),
                                })
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                specs.push(QuestionSpec {
                    id,
                    header: row
                        .get("header")
                        .and_then(Value::as_str)
                        .unwrap_or("Agent 提问")
                        .to_owned(),
                    question: summarize(native_question.clone(), 2000),
                    native_question,
                    options,
                    multi_select: row.get("multiSelect").and_then(Value::as_bool) == Some(true),
                });
            }
        }
        if specs.is_empty() {
            // Nothing to ask: allow immediately with an empty answers map,
            // matching the legacy adapter.
            let frame = serde_json::json!({
                "type":"control_response",
                "response":{"subtype":"success","request_id":request_id,
                    "response":{"behavior":"allow",
                        "updatedInput": merge_answers(&input, &serde_json::Map::new())}}
            })
            .to_string();
            let _ = writer.try_send((frame, None));
            return;
        }
        let (reply, receiver) = oneshot::channel();
        let writer = writer.clone();
        let rid = request_id.clone();
        tokio::spawn(async move {
            let response = match receiver.await {
                // The user answered, or explicitly cancelled: either way the
                // tool call is allowed — with answers, or with an empty map.
                Ok(QuestionReply { answers, cancelled }) => {
                    let mut map = serde_json::Map::new();
                    if !cancelled {
                        for (question, value) in answers {
                            map.insert(question, Value::String(value));
                        }
                    }
                    serde_json::json!({"behavior":"allow",
                        "updatedInput": merge_answers(&input, &map)})
                }
                // The sender was dropped (interrupt/shutdown): deny so the
                // CLI does not keep blocking on a callback nobody will send.
                Err(_) => serde_json::json!({"behavior":"deny",
                    "message":"The user cancelled the question."}),
            };
            let frame = serde_json::json!({
                "type":"control_response",
                "response":{"subtype":"success","request_id":rid,
                    "response":response}
            })
            .to_string();
            let _ = writer.send((frame, None)).await;
        });
        out.push(AdapterEvent::Question {
            subagent: agent,
            request_id,
            questions: specs,
            reply,
        });
    }

    /// `system` frames: native init plus the Task-tool lifecycle.
    fn translate_system(&mut self, message: &Value, out: &mut Vec<AdapterEvent>) {
        let subtype = message.get("subtype").and_then(Value::as_str);
        match subtype {
            Some("status") => {
                if let Some(value) = message.get("compact_result").and_then(Value::as_str) {
                    out.push(AdapterEvent::Compact {
                        ok: value == "success",
                        message: message
                            .get("compact_error")
                            .and_then(Value::as_str)
                            .unwrap_or("Claude 上下文压缩失败")
                            .to_owned(),
                    });
                }
            }
            Some("init") if self.native_id.is_none() => {
                if let Some(id) = message.get("session_id").and_then(Value::as_str) {
                    self.native_id = Some(id.to_owned());
                    out.push(AdapterEvent::NativeId(id.to_owned()));
                }
            }
            Some("task_started") => {
                let Some(task_id) = message.get("task_id").and_then(Value::as_str) else {
                    return;
                };
                let public = message
                    .get("tool_use_id")
                    .and_then(Value::as_str)
                    .unwrap_or(task_id)
                    .to_owned();
                self.task_agents.insert(task_id.to_owned(), public.clone());
                if let Some(tool_use_id) = message.get("tool_use_id").and_then(Value::as_str) {
                    self.task_agents
                        .insert(tool_use_id.to_owned(), public.clone());
                }
                let subagent_type = message.get("subagent_type").and_then(Value::as_str);
                match subagent_type {
                    // A background task (e.g. a shell task) is not a subagent.
                    None => {
                        self.non_subagent_tasks.insert(public);
                    }
                    Some(name) => {
                        self.non_subagent_tasks.remove(&public);
                        if self.known.insert(public.clone()) {
                            let task = message
                                .get("prompt")
                                .or_else(|| message.get("description"))
                                .and_then(Value::as_str)
                                .map(str::to_owned);
                            out.push(AdapterEvent::SubagentStarted {
                                subagent: public.clone(),
                                name: name.to_owned(),
                                role: message
                                    .get("task_type")
                                    .and_then(Value::as_str)
                                    .map(str::to_owned),
                                task,
                            });
                        }
                        out.push(AdapterEvent::SubagentUpdate {
                            subagent: public,
                            status: "running",
                            can_message: true,
                            summary: message
                                .get("description")
                                .and_then(Value::as_str)
                                .map(str::to_owned),
                        });
                    }
                }
            }
            Some("task_progress") => {
                let Some(task_id) = message.get("task_id").and_then(Value::as_str) else {
                    return;
                };
                let public = match self.task_agents.get(task_id) {
                    Some(public) => public.clone(),
                    None => {
                        let Some(public) = message
                            .get("tool_use_id")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                        else {
                            return;
                        };
                        self.task_agents.insert(task_id.to_owned(), public.clone());
                        public
                    }
                };
                if !self.non_subagent_tasks.contains(&public) {
                    out.push(AdapterEvent::SubagentUpdate {
                        subagent: public,
                        status: "running",
                        can_message: true,
                        summary: message
                            .get("summary")
                            .or_else(|| message.get("description"))
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                    });
                }
            }
            Some("task_notification") => {
                let Some(task_id) = message.get("task_id").and_then(Value::as_str) else {
                    return;
                };
                let public = self
                    .task_agents
                    .get(task_id)
                    .cloned()
                    .or_else(|| {
                        message
                            .get("tool_use_id")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                    })
                    .unwrap_or_else(|| task_id.to_owned());
                if !self.non_subagent_tasks.contains(&public) {
                    let raw_status = message
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("completed");
                    let status = match raw_status {
                        "failed" => "failed",
                        "stopped" => "stopped",
                        _ => "completed",
                    };
                    out.push(AdapterEvent::SubagentUpdate {
                        subagent: public,
                        status,
                        can_message: false,
                        summary: message
                            .get("summary")
                            .or_else(|| message.get("description"))
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                    });
                }
            }
            _ => {}
        }
    }

    fn translate_stream(
        &mut self,
        event: &Value,
        owner: Option<String>,
        out: &mut Vec<AdapterEvent>,
    ) {
        let index = event.get("index").and_then(Value::as_u64).unwrap_or(0) as u32;
        match event.get("type").and_then(Value::as_str) {
            Some("content_block_start") => {
                self.blocks.insert(index, String::new());
                if let Some(owner) = owner {
                    self.block_owners.insert(index, owner);
                }
            }
            Some("content_block_delta") => {
                let Some(delta) = event.get("delta") else {
                    return;
                };
                match delta.get("type").and_then(Value::as_str) {
                    Some("text_delta") => {
                        if let Some(text) = delta.get("text").and_then(Value::as_str) {
                            self.blocks.entry(index).or_default().push_str(text);
                        }
                    }
                    Some("thinking_delta") => {
                        if let Some(text) = delta.get("thinking").and_then(Value::as_str) {
                            let entry = self.blocks.entry(index).or_default();
                            if entry.is_empty() {
                                entry.push_str("thinking:");
                            }
                            entry.push_str(text);
                        }
                    }
                    _ => {}
                }
            }
            Some("content_block_stop") => {
                if let Some(mut text) = self.blocks.remove(&index) {
                    let subagent = self.block_owners.remove(&index);
                    if text.starts_with("thinking:") {
                        text.drain(.."thinking:".len());
                        if !text.trim().is_empty() {
                            out.push(AdapterEvent::Thinking { subagent, text });
                        }
                    } else if !text.trim().is_empty() {
                        out.push(AdapterEvent::Text { subagent, text });
                    }
                }
            }
            _ => {}
        }
    }
}
