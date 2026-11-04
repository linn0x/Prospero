use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{Mutex, mpsc, oneshot};

use super::claude::{
    AdapterEvent, QuestionOptionSpec, QuestionReply, QuestionSpec, TurnOptions,
};
use super::lifecycle::{ChildGuard, ProcessLifecycle, Quiescence, await_child_exit};
use super::store::ApprovalPolicy;
use super::{AgentModelCatalog, LaunchModelCatalog, LaunchModelInfo};
use crate::error::{Error, Result};
use crate::orchestration::reliability::ControlEffectState;
use crate::protocol::FileDiff;

const START_TIMEOUT: Duration = Duration::from_secs(25);
const CONTROL_TIMEOUT: Duration = Duration::from_secs(15);

type StdinFrame = (String, Option<oneshot::Sender<()>>);
type PendingControls = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value>>>>>;

pub(super) struct PiTurn {
    stdin: mpsc::Sender<StdinFrame>,
    controls: PendingControls,
    events: Option<mpsc::Receiver<AdapterEvent>>,
    model: Option<String>,
    effort: Option<String>,
    lifecycle: ProcessLifecycle,
}

pub(crate) fn binary() -> String {
    if let Ok(bin) = std::env::var("PROSPERO_PI_BIN") {
        let trimmed = bin.trim();
        if !trimmed.is_empty() {
            return trimmed.to_owned();
        }
    }
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        for candidate in [
            home.join(".local/bin/pi"),
            home.join(".pi/agent/bin/pi"),
        ] {
            if candidate.is_file() {
                return candidate.to_string_lossy().into_owned();
            }
        }
    }
    "pi".into()
}

pub(crate) fn pi_agent_dir(environment: &[(String, String)]) -> PathBuf {
    if let Some((_, dir)) = environment
        .iter()
        .find(|(key, _)| key == "PI_CODING_AGENT_DIR")
    {
        return PathBuf::from(dir);
    }
    if let Some(dir) = std::env::var_os("PI_CODING_AGENT_DIR") {
        return PathBuf::from(dir);
    }
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(".pi/agent")
}

pub(crate) fn pi_sessions_dir(environment: &[(String, String)]) -> PathBuf {
    if let Some((_, dir)) = environment
        .iter()
        .find(|(key, _)| key == "PI_CODING_AGENT_SESSION_DIR")
    {
        return PathBuf::from(dir);
    }
    if let Some(dir) = std::env::var_os("PI_CODING_AGENT_SESSION_DIR") {
        return PathBuf::from(dir);
    }
    pi_agent_dir(environment).join("sessions")
}

pub(crate) fn find_session_file(
    environment: &[(String, String)],
    session_id: &str,
) -> Option<PathBuf> {
    let direct = Path::new(session_id);
    if direct.is_absolute() && direct.is_file() {
        return Some(direct.to_path_buf());
    }
    let sessions_root = pi_sessions_dir(environment);
    if !sessions_root.is_dir() {
        return None;
    }
    let suffix = format!("_{session_id}.jsonl");
    let exact = format!("{session_id}.jsonl");
    let mut stack = vec![sessions_root];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if file_type.is_dir() {
                stack.push(path);
            } else if file_type.is_file() {
                let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                    continue;
                };
                if name == exact || name.ends_with(&suffix) {
                    return Some(path);
                }
            }
        }
    }
    None
}

pub(crate) fn fork_session_file(
    environment: &[(String, String)],
    workspace: &str,
    source_native_id: &str,
) -> Result<String> {
    let source_path = find_session_file(environment, source_native_id).ok_or_else(|| {
        Error::Invalid(format!("未找到 Pi 原生会话文件: {source_native_id}"))
    })?;
    let raw = std::fs::read_to_string(&source_path)?;
    let mut lines = raw.lines();
    let header_line = lines
        .next()
        .ok_or_else(|| Error::Invalid("Pi 原生会话文件为空".into()))?;
    let mut header: Value = serde_json::from_str(header_line)
        .map_err(|_| Error::Invalid("Pi 原生会话头格式无效".into()))?;
    let forked_id = uuid::Uuid::new_v4().to_string();
    let now_ms = crate::database::now();
    let secs = (now_ms / 1000).max(0);
    let millis = (now_ms % 1000).max(0);
    let timestamp = format!("{secs}.{millis:03}Z");
    if let Some(obj) = header.as_object_mut() {
        obj.insert("type".into(), json!("session"));
        obj.insert("id".into(), json!(forked_id));
        obj.insert("timestamp".into(), json!(timestamp));
        obj.insert("cwd".into(), json!(workspace));
        obj.insert(
            "parentSession".into(),
            json!(source_path.to_string_lossy().as_ref()),
        );
    }
    let parent_dir = source_path
        .parent()
        .ok_or_else(|| Error::Invalid("Pi 会话目录无效".into()))?;
    let dest_path = parent_dir.join(format!("{now_ms}_{forked_id}.jsonl"));
    let mut output = serde_json::to_string(&header)?;
    output.push('\n');
    for line in lines {
        if !line.trim().is_empty() {
            output.push_str(line);
            output.push('\n');
        }
    }
    std::fs::write(&dest_path, output)?;
    Ok(forked_id)
}

fn normalize_thinking_level(effort: &str) -> Option<&'static str> {
    match effort.trim() {
        "off" | "none" => Some("off"),
        "minimal" => Some("minimal"),
        "low" => Some("low"),
        "medium" => Some("medium"),
        "high" => Some("high"),
        "xhigh" | "max" => Some("xhigh"),
        _ => None,
    }
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

fn safe_id(value: &str, fallback: &str) -> String {
    let out: String = value
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(120)
        .collect();
    if out.is_empty() {
        fallback.to_owned()
    } else {
        out
    }
}

fn tool_summary(args: &Value) -> String {
    if let Some(text) = args
        .get("command")
        .or_else(|| args.get("path"))
        .or_else(|| args.get("file_path"))
        .or_else(|| args.get("pattern"))
        .and_then(Value::as_str)
    {
        return summarize(text.to_owned(), 2000);
    }
    match args {
        Value::Null => String::new(),
        Value::String(s) => summarize(s.clone(), 2000),
        other => summarize(serde_json::to_string(other).unwrap_or_default(), 2000),
    }
}

fn extract_tool_result_text(result: &Value) -> String {
    if let Some(content) = result.get("content").and_then(Value::as_array) {
        let joined = content
            .iter()
            .filter_map(|item| item.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n");
        if !joined.is_empty() {
            return summarize(joined, 4000);
        }
    }
    if let Some(text) = result.as_str() {
        return summarize(text.to_owned(), 4000);
    }
    summarize(serde_json::to_string(result).unwrap_or_default(), 4000)
}

fn extract_tool_diff(args: &Value, result: &Value) -> Option<FileDiff> {
    let diff_text = result
        .get("details")
        .and_then(|details| details.get("diff"))
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())?;
    let path = args
        .get("path")
        .or_else(|| args.get("file_path"))
        .and_then(Value::as_str)
        .unwrap_or("file")
        .to_owned();
    let mut additions = 0i64;
    let mut deletions = 0i64;
    for line in diff_text.lines() {
        if line.starts_with('+') && !line.starts_with("+++") {
            additions += 1;
        } else if line.starts_with('-') && !line.starts_with("---") {
            deletions += 1;
        }
    }
    Some(FileDiff {
        path,
        patch: summarize(diff_text.to_owned(), 32_000),
        additions,
        deletions,
        truncated: diff_text.len() > 32_000,
    })
}

fn parse_models_list(models_value: &Value, current_model: Option<&str>) -> Vec<LaunchModelInfo> {
    let Some(items) = models_value.as_array() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in items {
        let Some(provider) = item.get("provider").and_then(Value::as_str) else {
            continue;
        };
        let Some(model_id) = item.get("id").and_then(Value::as_str) else {
            continue;
        };
        if provider.is_empty() || model_id.is_empty() {
            continue;
        }
        let id = format!("{provider}/{model_id}");
        let raw_name = item
            .get("name")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(model_id);
        let label = if raw_name == id {
            raw_name.chars().take(300).collect()
        } else {
            format!("{raw_name} ({provider})").chars().take(300).collect()
        };
        let reasoning = item
            .get("reasoning")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let supported_efforts = if reasoning {
            vec![
                "off".into(),
                "minimal".into(),
                "low".into(),
                "medium".into(),
                "high".into(),
                "xhigh".into(),
            ]
        } else {
            Vec::new()
        };
        let default_effort = reasoning.then(|| "medium".into());
        let is_default = current_model.is_some_and(|curr| curr == id);
        out.push(LaunchModelInfo {
            id,
            label,
            description: None,
            supported_efforts,
            default_effort,
            is_default,
        });
    }
    if !out.is_empty() && !out.iter().any(|m| m.is_default) {
        out[0].is_default = true;
    }
    out
}

pub(super) async fn launch_catalog(
    workspace: &Path,
    environment: &[(String, String)],
) -> Result<LaunchModelCatalog> {
    let mut command = Command::new(binary());
    command
        .args(["--mode", "rpc", "--no-session"])
        .current_dir(workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(false)
        .env("PI_SKIP_VERSION_CHECK", "1")
        .env("PI_TELEMETRY", "0");
    for (key, value) in environment {
        command.env(key, value);
    }
    super::lifecycle::configure_process_group(&mut command);
    let child = command.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            Error::Feature("agent_unavailable".into(), "未安装 pi CLI".into())
        } else {
            Error::Io(error)
        }
    })?;
    let mut guard = ChildGuard::new(child)?;
    let mut stdin = guard.child_mut().stdin.take().ok_or(Error::Closed)?;
    let stdout = guard.child_mut().stdout.take().ok_or(Error::Closed)?;
    let mut reader = BufReader::new(stdout);

    let result = tokio::time::timeout(START_TIMEOUT, async {
        stdin
            .write_all(
                b"{\"id\":\"state\",\"type\":\"get_state\"}\n{\"id\":\"models\",\"type\":\"get_available_models\"}\n",
            )
            .await?;
        stdin.flush().await?;

        let mut state_data: Option<Value> = None;
        let mut models_data: Option<Value> = None;
        let mut line = String::new();
        while state_data.is_none() || models_data.is_none() {
            line.clear();
            let n = reader.read_line(&mut line).await?;
            if n == 0 {
                return Err(Error::Invalid("pi --mode rpc 提前退出".into()));
            }
            let Ok(frame) = serde_json::from_str::<Value>(line.trim()) else {
                continue;
            };
            if frame.get("type").and_then(Value::as_str) != Some("response") {
                continue;
            }
            match frame.get("id").and_then(Value::as_str) {
                Some("state") => {
                    state_data = Some(frame.get("data").cloned().unwrap_or(Value::Null));
                }
                Some("models") => {
                    models_data = Some(
                        frame
                            .get("data")
                            .and_then(|d| d.get("models"))
                            .cloned()
                            .unwrap_or_else(|| json!([])),
                    );
                }
                _ => {}
            }
        }
        let state = state_data.unwrap_or(Value::Null);
        let current_model = state.get("model").and_then(|m| {
            let provider = m.get("provider")?.as_str()?;
            let id = m.get("id")?.as_str()?;
            Some(format!("{provider}/{id}"))
        });
        let current_effort = state
            .get("thinkingLevel")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let models = parse_models_list(&models_data.unwrap_or_else(|| json!([])), current_model.as_deref());
        let resolved_current = current_model.or_else(|| {
            models
                .iter()
                .find(|m| m.is_default)
                .map(|m| m.id.clone())
        });
        Ok(LaunchModelCatalog {
            models,
            current_model: resolved_current,
            current_effort,
            presets: Vec::new(),
            current_preset: None,
        })
    })
    .await;

    let _ = guard.terminate(Duration::from_secs(2)).await;
    match result {
        Ok(inner) => inner,
        Err(_) => Err(Error::Invalid("pi 模型列表读取超时".into())),
    }
}

pub(super) async fn spawn_turn(
    workspace: &str,
    prompt: &str,
    attachments: &[crate::agent::AttachmentInput],
    native_id: Option<&str>,
    options: &TurnOptions,
) -> Result<PiTurn> {
    let profile_model = options
        .environment
        .iter()
        .find_map(|(key, value)| (key == "PROSPERO_API_PROFILE_MODEL").then_some(value.as_str()));
    let profile_vision = options
        .environment
        .iter()
        .find_map(|(key, value)| (key == "PROSPERO_API_PROFILE_VISION").then_some(value.as_str()));
    if !attachments.is_empty() && profile_vision == Some("0") {
        return Err(Error::Feature(
            "account_vision_disabled".into(),
            "当前模型配置未开启图片理解能力".into(),
        ));
    }

    let effective_model = profile_model
        .map(str::to_owned)
        .or_else(|| options.model.clone());
    let effective_effort = options
        .effort
        .as_deref()
        .and_then(normalize_thinking_level)
        .map(str::to_owned);

    let mut command = Command::new(binary());
    command
        .args(["--mode", "rpc"])
        .current_dir(workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(false)
        .env("PI_SKIP_VERSION_CHECK", "1")
        .env("PI_TELEMETRY", "0");

    if let Some(session_ref) = native_id {
        if let Some(existing_path) = find_session_file(&options.environment, session_ref) {
            command.arg("--session").arg(existing_path);
        } else if uuid::Uuid::parse_str(session_ref).is_ok() {
            command.args(["--session-id", session_ref]);
        } else {
            command.args(["--session", session_ref]);
        }
    }

    if let Some(model) = effective_model.as_deref() {
        command.args(["--model", model]);
    }
    if let Some(thinking) = effective_effort.as_deref() {
        command.args(["--thinking", thinking]);
    }

    for (key, value) in &options.environment {
        command.env(key, value);
    }

    super::lifecycle::configure_process_group(&mut command);
    let child = command.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            Error::Feature("agent_unavailable".into(), "未安装 pi CLI".into())
        } else {
            Error::Io(error)
        }
    })?;
    let guard = ChildGuard::new(child)?;
    let lifecycle = guard.lifecycle();
    let (mut child, _) = guard.into_child();
    let mut stdin = child.stdin.take().ok_or(Error::Closed)?;
    let stdout = child.stdout.take().ok_or(Error::Closed)?;
    let stderr = child.stderr.take().ok_or(Error::Closed)?;

    let stderr_tail = Arc::new(Mutex::new(String::new()));
    let stderr_capture = stderr_tail.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut line = String::new();
        while let Ok(n) = reader.read_line(&mut line).await {
            if n == 0 {
                break;
            }
            let mut tail = stderr_capture.lock().await;
            tail.push_str(&line);
            if tail.len() > 8192 {
                let mut drain = tail.len() - 8192;
                while !tail.is_char_boundary(drain) {
                    drain += 1;
                }
                tail.drain(..drain);
            }
            line.clear();
        }
    });

    let (frames_tx, mut frames_rx) = mpsc::channel::<StdinFrame>(32);
    let (events_tx, events_rx) = mpsc::channel::<AdapterEvent>(64);
    let controls: PendingControls = Arc::new(Mutex::new(HashMap::new()));

    let state_frame = json!({
        "id": "init-state",
        "type": "get_state",
    })
    .to_string();
    let images: Vec<Value> = attachments
        .iter()
        .map(|att| {
            json!({
                "type": "image",
                "data": att.data_b64,
                "mimeType": att.mime_type,
            })
        })
        .collect();
    let prompt_frame = if images.is_empty() {
        json!({
            "id": "turn-prompt",
            "type": "prompt",
            "message": prompt,
        })
        .to_string()
    } else {
        json!({
            "id": "turn-prompt",
            "type": "prompt",
            "message": prompt,
            "images": images,
        })
        .to_string()
    };
    let _ = frames_tx.try_send((state_frame, None));
    let _ = frames_tx.try_send((prompt_frame, None));

    tokio::spawn(async move {
        while let Some((frame, ack)) = frames_rx.recv().await {
            if stdin.write_all(frame.as_bytes()).await.is_err() {
                break;
            }
            if stdin.write_all(b"\n").await.is_err() {
                break;
            }
            if stdin.flush().await.is_err() {
                break;
            }
            if let Some(ack) = ack {
                let _ = ack.send(());
            }
        }
    });

    let reader_writer = frames_tx.clone();
    let reader_controls = controls.clone();
    let reader_lifecycle = lifecycle.clone();
    let auto_approve = options.policy == ApprovalPolicy::Auto;

    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        let mut accumulated_text = String::new();
        let mut accumulated_thinking = String::new();
        let mut needs_paragraph_break = false;
        let mut tool_args: HashMap<String, Value> = HashMap::new();
        let mut total_input_tokens: i64 = 0;
        let mut total_output_tokens: i64 = 0;
        let mut total_cost_usd: f64 = 0.0;
        let mut has_usage = false;
        let mut has_cost = false;
        let mut interrupted = false;
        let mut aborted = false;
        let mut turn_error: Option<String> = None;
        let mut finished = false;
        let mut diffs: Vec<FileDiff> = Vec::new();

        loop {
            line.clear();
            let Ok(read) = reader.read_line(&mut line).await else {
                break;
            };
            if read == 0 {
                break;
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(frame) = serde_json::from_str::<Value>(trimmed) else {
                continue;
            };
            let Some(frame_type) = frame.get("type").and_then(Value::as_str) else {
                continue;
            };

            match frame_type {
                "response" => {
                    let req_id = frame.get("id").and_then(Value::as_str).unwrap_or_default();
                    let command = frame
                        .get("command")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let ok = frame
                        .get("success")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    if !req_id.is_empty()
                        && let Some(waiter) = reader_controls.lock().await.remove(req_id)
                    {
                        if ok {
                            let _ = waiter
                                .send(Ok(frame.get("data").cloned().unwrap_or(Value::Null)));
                        } else {
                            let msg = frame
                                .get("error")
                                .and_then(Value::as_str)
                                .unwrap_or("Pi RPC 请求失败");
                            let _ = waiter.send(Err(Error::Invalid(msg.to_owned())));
                        }
                    }
                    if command == "get_state"
                        && ok
                        && let Some(sid) = frame
                            .get("data")
                            .and_then(|d| d.get("sessionId"))
                            .and_then(Value::as_str)
                        && !sid.is_empty()
                    {
                        let _ = events_tx
                            .send(AdapterEvent::NativeId(sid.to_owned()))
                            .await;
                    } else if command == "prompt" && !ok {
                        let msg = frame
                            .get("error")
                            .and_then(Value::as_str)
                            .unwrap_or("Pi prompt 执行失败");
                        turn_error = Some(msg.to_owned());
                        finished = true;
                        let _ = reader_lifecycle.request_termination().await;
                        break;
                    }
                }
                "message_start" => {
                    if frame
                        .get("message")
                        .and_then(|m| m.get("role"))
                        .and_then(Value::as_str)
                        == Some("assistant")
                        && !accumulated_text.is_empty()
                    {
                        needs_paragraph_break = true;
                    }
                }
                "message_update" => {
                    if let Some(evt) = frame.get("assistantMessageEvent") {
                        match evt.get("type").and_then(Value::as_str) {
                            Some("text_delta") => {
                                if let Some(delta) = evt.get("delta").and_then(Value::as_str)
                                    && !delta.is_empty()
                                {
                                    if needs_paragraph_break {
                                        accumulated_text.push_str("\n\n");
                                        needs_paragraph_break = false;
                                    }
                                    accumulated_text.push_str(delta);
                                    if events_tx
                                        .send(AdapterEvent::Text {
                                            subagent: None,
                                            text: accumulated_text.clone(),
                                        })
                                        .await
                                        .is_err()
                                    {
                                        reader_lifecycle.request_termination().await;
                                        await_child_exit(&mut child, &reader_lifecycle).await;
                                        return;
                                    }
                                }
                            }
                            Some("thinking_delta") => {
                                if let Some(delta) = evt.get("delta").and_then(Value::as_str)
                                    && !delta.is_empty()
                                {
                                    if !accumulated_thinking.is_empty()
                                        && needs_paragraph_break
                                    {
                                        accumulated_thinking.push_str("\n\n");
                                    }
                                    accumulated_thinking.push_str(delta);
                                    let _ = events_tx
                                        .send(AdapterEvent::Thinking {
                                            subagent: None,
                                            text: accumulated_thinking.clone(),
                                        })
                                        .await;
                                }
                            }
                            _ => {}
                        }
                    }
                }
                "message_end" => {
                    if let Some(msg) = frame.get("message")
                        && msg.get("role").and_then(Value::as_str) == Some("assistant")
                    {
                        if let Some(usage) = msg.get("usage") {
                            if let Some(inp) = usage.get("input").and_then(Value::as_i64) {
                                total_input_tokens += inp.max(0);
                                has_usage = true;
                            }
                            if let Some(out) = usage.get("output").and_then(Value::as_i64) {
                                total_output_tokens += out.max(0);
                                has_usage = true;
                            }
                            if let Some(cost) = usage
                                .get("cost")
                                .and_then(|c| c.get("total"))
                                .and_then(Value::as_f64)
                                && cost >= 0.0
                            {
                                total_cost_usd += cost;
                                has_cost = true;
                            }
                        }
                        if accumulated_text.is_empty()
                            && let Some(content) = msg.get("content").and_then(Value::as_array)
                        {
                            let fallback = content
                                .iter()
                                .filter(|c| c.get("type").and_then(Value::as_str) == Some("text"))
                                .filter_map(|c| c.get("text").and_then(Value::as_str))
                                .collect::<Vec<_>>()
                                .join("\n");
                            if !fallback.is_empty() {
                                accumulated_text = fallback;
                                let _ = events_tx
                                    .send(AdapterEvent::Text {
                                        subagent: None,
                                        text: accumulated_text.clone(),
                                    })
                                    .await;
                            }
                        }
                        match msg.get("stopReason").and_then(Value::as_str) {
                            Some("aborted") => {
                                interrupted = true;
                                aborted = true;
                            }
                            Some("error") => {
                                let err_text = msg
                                    .get("errorMessage")
                                    .and_then(Value::as_str)
                                    .filter(|s| !s.trim().is_empty())
                                    .unwrap_or("Pi 模型请求失败");
                                turn_error = Some(err_text.to_owned());
                            }
                            _ => {}
                        }
                    }
                }
                "tool_execution_start" => {
                    let raw_id = frame
                        .get("toolCallId")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let call_id = safe_id(raw_id, "pi-tool");
                    let name = frame
                        .get("toolName")
                        .and_then(Value::as_str)
                        .unwrap_or("tool")
                        .chars()
                        .take(128)
                        .collect::<String>();
                    let args = frame.get("args").cloned().unwrap_or(Value::Null);
                    let summary = tool_summary(&args);
                    tool_args.insert(call_id.clone(), args);
                    let _ = events_tx
                        .send(AdapterEvent::ToolCall {
                            subagent: None,
                            call_id,
                            name,
                            summary,
                            diff: None,
                        })
                        .await;
                }
                "tool_execution_end" => {
                    let raw_id = frame
                        .get("toolCallId")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let call_id = safe_id(raw_id, "pi-tool");
                    let name = frame
                        .get("toolName")
                        .and_then(Value::as_str)
                        .unwrap_or("tool")
                        .chars()
                        .take(128)
                        .collect::<String>();
                    let is_error = frame
                        .get("isError")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let result = frame.get("result").cloned().unwrap_or(Value::Null);
                    let args = tool_args.remove(&call_id).unwrap_or(Value::Null);
                    let summary = extract_tool_result_text(&result);
                    let diff = extract_tool_diff(&args, &result);
                    if let Some(d) = &diff {
                        diffs.push(d.clone());
                    }
                    let _ = events_tx
                        .send(AdapterEvent::ToolResult {
                            subagent: None,
                            call_id,
                            name,
                            summary,
                            error: is_error,
                            diff,
                            has_more: false,
                        })
                        .await;
                }
                "compaction_end" => {
                    let aborted = frame
                        .get("aborted")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let error_message = frame
                        .get("errorMessage")
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                    let _ = events_tx
                        .send(AdapterEvent::Compact {
                            ok: !aborted && error_message.is_none(),
                            message: error_message
                                .unwrap_or_else(|| "已完成上下文压缩".to_owned()),
                        })
                        .await;
                }
                "extension_ui_request" => {
                    let req_id = frame
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned();
                    let method = frame
                        .get("method")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    match method {
                        "confirm" => {
                            let title = frame
                                .get("title")
                                .and_then(Value::as_str)
                                .unwrap_or("confirm")
                                .to_owned();
                            let message = frame
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_owned();
                            if auto_approve {
                                let reply_frame = json!({
                                    "type": "extension_ui_response",
                                    "id": req_id,
                                    "confirmed": true,
                                })
                                .to_string();
                                let _ = reader_writer.try_send((reply_frame, None));
                            } else {
                                let (reply, receiver) = oneshot::channel();
                                let writer = reader_writer.clone();
                                let rid = req_id.clone();
                                tokio::spawn(async move {
                                    let allow = receiver.await.unwrap_or(false);
                                    let reply_frame = json!({
                                        "type": "extension_ui_response",
                                        "id": rid,
                                        "confirmed": allow,
                                    })
                                    .to_string();
                                    let _ = writer.send((reply_frame, None)).await;
                                });
                                let _ = events_tx
                                    .send(AdapterEvent::Permission {
                                        subagent: None,
                                        request_id: safe_id(&req_id, "pi-perm"),
                                        tool: summarize(title, 128),
                                        summary: summarize(message, 2000),
                                        reply,
                                    })
                                    .await;
                            }
                        }
                        "select" | "input" | "editor" => {
                            let title = frame
                                .get("title")
                                .and_then(Value::as_str)
                                .unwrap_or("输入")
                                .to_owned();
                            let options = frame
                                .get("options")
                                .and_then(Value::as_array)
                                .map(|arr| {
                                    arr.iter()
                                        .filter_map(Value::as_str)
                                        .map(|opt| QuestionOptionSpec {
                                            label: opt.to_owned(),
                                            description: None,
                                            preview: None,
                                        })
                                        .collect::<Vec<_>>()
                                })
                                .unwrap_or_default();
                            let q_id = "q1".to_owned();
                            let native_question = title.clone();
                            let question = QuestionSpec {
                                id: q_id.clone(),
                                header: summarize(title.clone(), 60),
                                native_question: native_question.clone(),
                                question: title,
                                options,
                                multi_select: false,
                            };
                            let (reply, receiver) = oneshot::channel::<QuestionReply>();
                            let writer = reader_writer.clone();
                            let rid = req_id.clone();
                            tokio::spawn(async move {
                                let response = match receiver.await {
                                    Ok(reply) if !reply.cancelled => {
                                        let picked = reply
                                            .answers
                                            .get(&native_question)
                                            .or_else(|| reply.answers.get(&q_id))
                                            .cloned()
                                            .unwrap_or_default();
                                        json!({
                                            "type": "extension_ui_response",
                                            "id": rid,
                                            "value": picked,
                                        })
                                    }
                                    _ => json!({
                                        "type": "extension_ui_response",
                                        "id": rid,
                                        "cancelled": true,
                                    }),
                                };
                                let _ = writer.send((response.to_string(), None)).await;
                            });
                            let _ = events_tx
                                .send(AdapterEvent::Question {
                                    subagent: None,
                                    request_id: safe_id(&req_id, "pi-question"),
                                    questions: vec![question],
                                    reply,
                                })
                                .await;
                        }
                        _ => {}
                    }
                }
                "agent_settled" | "agent_end" => {
                    finished = true;
                    let _ = reader_lifecycle.request_termination().await;
                    break;
                }
                _ => {}
            }
        }

        if !finished {
            reader_lifecycle.request_termination().await;
        }
        let wait_error = match await_child_exit(&mut child, &reader_lifecycle).await {
            Quiescence::Confirmed | Quiescence::DirectChildExited if finished => None,
            Quiescence::Confirmed | Quiescence::DirectChildExited => {
                let stderr_msg = stderr_tail.lock().await.trim().to_owned();
                if stderr_msg.is_empty() {
                    Some("Pi 事件流在完成前关闭".into())
                } else {
                    Some(summarize(stderr_msg, 1000))
                }
            }
            Quiescence::Unknown => Some("Pi 进程组退出状态未知".into()),
        };

        let _ = events_tx
            .send(AdapterEvent::Finish {
                interrupted,
                error: if aborted {
                    None
                } else {
                    turn_error.or(wait_error)
                },
                cost_usd: has_cost.then_some(total_cost_usd),
                input_tokens: has_usage.then_some(total_input_tokens),
                output_tokens: has_usage.then_some(total_output_tokens),
                diffs,
            })
            .await;
    });

    Ok(PiTurn {
        stdin: frames_tx,
        controls,
        events: Some(events_rx),
        model: effective_model,
        effort: effective_effort,
        lifecycle,
    })
}

impl PiTurn {
    pub(super) fn take_events(&mut self) -> Option<mpsc::Receiver<AdapterEvent>> {
        self.events.take()
    }

    pub(super) fn interrupt(&self) -> ControlEffectState {
        let frame = json!({
            "id": uuid::Uuid::new_v4().to_string(),
            "type": "abort",
        })
        .to_string();
        if self.stdin.try_send((frame, None)).is_ok() {
            ControlEffectState::Received
        } else {
            ControlEffectState::Failed
        }
    }

    pub(super) async fn steer(
        &self,
        text: &str,
        attachments: &[crate::agent::AttachmentInput],
    ) -> Result<()> {
        let images: Vec<Value> = attachments
            .iter()
            .map(|att| {
                json!({
                    "type": "image",
                    "data": att.data_b64,
                    "mimeType": att.mime_type,
                })
            })
            .collect();
        let payload = if images.is_empty() {
            json!({
                "type": "steer",
                "message": text,
            })
        } else {
            json!({
                "type": "steer",
                "message": text,
                "images": images,
            })
        };
        let _ = self.control_request(payload).await?;
        Ok(())
    }

    pub(super) async fn compact(&self) -> Result<()> {
        let _ = self
            .control_request(json!({
                "type": "compact",
            }))
            .await?;
        Ok(())
    }

    #[allow(dead_code)]
    pub(super) async fn models(&self) -> Result<AgentModelCatalog> {
        let data = self
            .control_request(json!({
                "type": "get_available_models",
            }))
            .await?;
        let models_val = data.get("models").cloned().unwrap_or_else(|| json!([]));
        let models = parse_models_list(&models_val, self.model.as_deref());
        Ok(AgentModelCatalog {
            models,
            current_model: self.model.clone(),
            current_effort: self.effort.clone(),
        })
    }

    pub(super) async fn apply_selection(
        &mut self,
        model: &str,
        effort: Option<&str>,
    ) -> Result<()> {
        if let Some((provider, model_id)) = model.split_once('/') {
            let _ = self
                .control_request(json!({
                    "type": "set_model",
                    "provider": provider,
                    "modelId": model_id,
                }))
                .await?;
        }
        self.model = Some(model.to_owned());
        if let Some(effort) = effort {
            let level = normalize_thinking_level(effort)
                .ok_or_else(|| Error::Invalid("Pi 思考强度无效".into()))?;
            let _ = self
                .control_request(json!({
                    "type": "set_thinking_level",
                    "level": level,
                }))
                .await?;
            self.effort = Some(level.to_owned());
        }
        Ok(())
    }

    async fn control_request(&self, mut command: Value) -> Result<Value> {
        let request_id = uuid::Uuid::new_v4().to_string();
        if let Some(obj) = command.as_object_mut() {
            obj.insert("id".into(), json!(request_id));
        }
        let (reply_tx, reply_rx) = oneshot::channel();
        self.controls
            .lock()
            .await
            .insert(request_id.clone(), reply_tx);
        let (ack_tx, ack_rx) = oneshot::channel();
        if self
            .stdin
            .send((command.to_string(), Some(ack_tx)))
            .await
            .is_err()
        {
            self.controls.lock().await.remove(&request_id);
            return Err(Error::Closed);
        }
        if ack_rx.await.is_err() {
            self.controls.lock().await.remove(&request_id);
            return Err(Error::Closed);
        }
        match tokio::time::timeout(CONTROL_TIMEOUT, reply_rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(Error::Closed),
            Err(_) => {
                self.controls.lock().await.remove(&request_id);
                Err(Error::Invalid("Pi RPC 控制指令超时".into()))
            }
        }
    }

    pub(super) async fn kill(&self) -> ControlEffectState {
        self.lifecycle.request_termination().await
    }

    pub(super) fn lifecycle(&self) -> ProcessLifecycle {
        self.lifecycle.clone()
    }
}
