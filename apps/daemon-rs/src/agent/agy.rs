//! Direct Antigravity (`agy`) CLI driver.
//!
//! Runs `agy -p <prompt> --output-format stream-json` per turn using the local
//! Antigravity subscription session (`~/.gemini/antigravity-cli` / Keychain).

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

use super::claude::{AdapterEvent, TurnOptions};
use super::lifecycle::{ChildGuard, ProcessLifecycle, Quiescence, await_child_exit};
use super::store::PermissionMode;
use super::turn_stream::TurnStreamStateMachine;
use super::{LaunchModelCatalog, LaunchModelInfo};
use crate::error::{Error, Result};
use crate::orchestration::reliability::ControlEffectState;

const CATALOG_CACHE_TTL: Duration = Duration::from_secs(1800);
const CATALOG_CMD_TIMEOUT: Duration = Duration::from_secs(6);

pub(crate) fn binary() -> String {
    if let Ok(explicit) = std::env::var("PROSPERO_AGY_BIN") {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() {
            return trimmed.to_owned();
        }
    }
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        let candidate = home.join(".local/bin/agy");
        if candidate.is_file() {
            return candidate.to_string_lossy().into_owned();
        }
    }
    "agy".to_owned()
}

const KNOWN_EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];

pub(crate) fn split_model_effort_suffix(model_id: &str) -> (&str, Option<&str>) {
    let trimmed = model_id.trim();
    for &effort in KNOWN_EFFORTS {
        if let Some(base) = trimmed.strip_suffix(&format!("-{effort}"))
            && !base.is_empty()
        {
            return (base, Some(effort));
        }
    }
    (trimmed, None)
}

fn strip_label_effort_suffix(label: &str) -> String {
    let trimmed = label.trim();
    for suffix in [" (Low)", " (Medium)", " (High)", " (XHigh)", " (Max)"] {
        if let Some(base) = trimmed.strip_suffix(suffix) {
            return base.trim().to_owned();
        }
    }
    trimmed.to_owned()
}

fn default_effort_for_base(base_id: &str, supported: &[String]) -> String {
    let preferred = if base_id == "gemini-4-argon" || base_id == "gpt-oss-120b" {
        "medium"
    } else {
        "high"
    };
    if supported.iter().any(|item| item == preferred) {
        return preferred.to_owned();
    }
    if supported.iter().any(|item| item == "medium") {
        return "medium".to_owned();
    }
    supported
        .first()
        .cloned()
        .unwrap_or_else(|| "medium".to_owned())
}

fn clamp_effort_for_base(base_id: &str, effort: &str) -> String {
    let normalized = effort.trim().to_ascii_lowercase();
    if base_id == "gpt-oss-120b" {
        return "medium".to_owned();
    }
    match normalized.as_str() {
        "minimal" | "low" => "low".to_owned(),
        "medium" => "medium".to_owned(),
        "high" | "xhigh" | "max" | "ultra" => "high".to_owned(),
        _ => default_effort_for_base(
            base_id,
            &["low".to_owned(), "medium".to_owned(), "high".to_owned()],
        ),
    }
}

/// Resolves a `(model, effort)` selection into `(canonical_base_model, canonical_effort, cli_args)`
/// so that `agy` never receives a conflicting `--model <slug>-<effort1> --effort <effort2>` pair.
pub(crate) fn resolve_cli_model_and_effort(
    model: Option<&str>,
    effort: Option<&str>,
) -> (Option<String>, Option<String>, Vec<String>) {
    let clean_model = model.map(str::trim).filter(|s| !s.is_empty());
    let clean_effort = effort.map(str::trim).filter(|s| !s.is_empty());

    let Some(raw_model) = clean_model else {
        if let Some(raw_effort) = clean_effort {
            let clamped = clamp_effort_for_base("gemini-4-argon", raw_effort);
            return (
                None,
                Some(clamped.clone()),
                vec!["--effort".into(), clamped],
            );
        }
        return (None, None, Vec::new());
    };

    let (base_id, embedded_effort) = split_model_effort_suffix(raw_model);
    let effective_effort = match clean_effort.or(embedded_effort) {
        Some(chosen) => clamp_effort_for_base(base_id, chosen),
        None => default_effort_for_base(
            base_id,
            &["low".to_owned(), "medium".to_owned(), "high".to_owned()],
        ),
    };
    let concrete_slug = format!("{base_id}-{effective_effort}");
    (
        Some(base_id.to_owned()),
        Some(effective_effort),
        vec!["--model".into(), concrete_slug],
    )
}

pub(crate) fn fallback_models() -> Vec<LaunchModelInfo> {
    let std_efforts: Vec<String> = vec!["low".into(), "medium".into(), "high".into()];
    vec![
        LaunchModelInfo {
            id: "gemini-4-argon".into(),
            label: "Gemini 4 Argon".into(),
            description: Some("Antigravity 订阅模型".into()),
            supported_efforts: std_efforts.clone(),
            default_effort: Some("medium".into()),
            is_default: true,
        },
        LaunchModelInfo {
            id: "gemini-3.8-flash".into(),
            label: "Gemini 3.8 Flash".into(),
            description: Some("Antigravity 订阅模型".into()),
            supported_efforts: std_efforts.clone(),
            default_effort: Some("high".into()),
            is_default: false,
        },
        LaunchModelInfo {
            id: "claude-opus-5-5".into(),
            label: "Claude Opus 5.5".into(),
            description: Some("Antigravity 订阅模型".into()),
            supported_efforts: std_efforts.clone(),
            default_effort: Some("high".into()),
            is_default: false,
        },
        LaunchModelInfo {
            id: "claude-sonnet-5-5".into(),
            label: "Claude Sonnet 5.5".into(),
            description: Some("Antigravity 订阅模型".into()),
            supported_efforts: std_efforts,
            default_effort: Some("high".into()),
            is_default: false,
        },
        LaunchModelInfo {
            id: "gpt-oss-120b".into(),
            label: "GPT-OSS 120B".into(),
            description: Some("Antigravity 订阅模型".into()),
            supported_efforts: vec!["medium".into()],
            default_effort: Some("medium".into()),
            is_default: false,
        },
    ]
}

pub(crate) fn parse_models_output(output: &str) -> Vec<LaunchModelInfo> {
    let mut models: Vec<LaunchModelInfo> = Vec::new();
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty()
            || trimmed.starts_with("Available models")
            || trimmed.starts_with("Usage:")
        {
            continue;
        }
        // Each row looks like: `  gemini-4-argon-high              Gemini 4 Argon (High)`
        let mut parts = trimmed.splitn(2, char::is_whitespace);
        let Some(id) = parts.next().map(str::trim).filter(|s| !s.is_empty()) else {
            continue;
        };
        if !id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
        {
            continue;
        }
        let raw_label = parts
            .next()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(id);
        let (base_id, suffix_effort) = split_model_effort_suffix(id);
        let base_label = strip_label_effort_suffix(raw_label);
        if let Some(existing) = models.iter_mut().find(|model| model.id == base_id) {
            if let Some(effort) = suffix_effort
                && !existing.supported_efforts.iter().any(|item| item == effort)
            {
                existing.supported_efforts.push(effort.to_owned());
            }
            if id == "gemini-4-argon-medium" {
                existing.is_default = true;
            }
        } else {
            let mut supported_efforts = Vec::new();
            if let Some(effort) = suffix_effort {
                supported_efforts.push(effort.to_owned());
            } else {
                supported_efforts.extend(["low".to_owned(), "medium".to_owned(), "high".to_owned()]);
            }
            models.push(LaunchModelInfo {
                id: base_id.to_owned(),
                label: base_label,
                description: Some("Antigravity 订阅模型".into()),
                supported_efforts,
                default_effort: None,
                is_default: base_id == "gemini-4-argon",
            });
        }
    }
    for model in &mut models {
        model.supported_efforts.sort_by_key(|effort| {
            KNOWN_EFFORTS
                .iter()
                .position(|&known| known == effort)
                .unwrap_or(usize::MAX)
        });
        model.default_effort = Some(default_effort_for_base(&model.id, &model.supported_efforts));
    }
    if !models.is_empty() && !models.iter().any(|model| model.is_default) {
        models[0].is_default = true;
    }
    models
}

fn catalog_cache() -> &'static Mutex<Option<(Instant, Vec<LaunchModelInfo>)>> {
    static CACHE: OnceLock<Mutex<Option<(Instant, Vec<LaunchModelInfo>)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn refresh_catalog_in_background() {
    static REFRESHING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if REFRESHING
        .compare_exchange(
            false,
            true,
            std::sync::atomic::Ordering::SeqCst,
            std::sync::atomic::Ordering::SeqCst,
        )
        .is_err()
    {
        return;
    }
    tokio::spawn(async move {
        let mut command = Command::new(binary());
        command
            .arg("models")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        if let Ok(Ok(output)) = tokio::time::timeout(CATALOG_CMD_TIMEOUT, command.output()).await
            && output.status.success()
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let parsed = parse_models_output(&stdout);
            if !parsed.is_empty()
                && let Ok(mut guard) = catalog_cache().lock()
            {
                *guard = Some((Instant::now(), parsed));
            }
        }
        REFRESHING.store(false, std::sync::atomic::Ordering::SeqCst);
    });
}

pub(crate) async fn launch_catalog() -> Result<LaunchModelCatalog> {
    let models = {
        let cached = catalog_cache()
            .lock()
            .ok()
            .and_then(|guard| guard.clone());
        match cached {
            Some((updated_at, models)) if updated_at.elapsed() < CATALOG_CACHE_TTL => models,
            Some((_, models)) => {
                refresh_catalog_in_background();
                models
            }
            None => {
                refresh_catalog_in_background();
                fallback_models()
            }
        }
    };
    let default_model = models
        .iter()
        .find(|model| model.is_default)
        .or_else(|| models.first());
    let current_model = default_model.map(|model| model.id.clone());
    let current_effort = default_model.and_then(|model| model.default_effort.clone());
    Ok(LaunchModelCatalog {
        models,
        presets: Vec::new(),
        current_preset: None,
        current_model,
        current_effort,
    })
}

pub(super) struct AgyTurn {
    events: Option<mpsc::Receiver<AdapterEvent>>,
    lifecycle: ProcessLifecycle,
    interrupted: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl AgyTurn {
    pub(super) fn take_events(&mut self) -> Option<mpsc::Receiver<AdapterEvent>> {
        self.events.take()
    }

    pub(super) async fn interrupt(&self) -> ControlEffectState {
        self.interrupted
            .store(true, std::sync::atomic::Ordering::Release);
        self.lifecycle.request_termination().await
    }

    pub(super) async fn kill(&self) -> ControlEffectState {
        self.interrupted
            .store(true, std::sync::atomic::Ordering::Release);
        self.lifecycle.request_termination().await
    }

    pub(super) fn lifecycle(&self) -> ProcessLifecycle {
        self.lifecycle.clone()
    }
}

pub(super) async fn spawn_turn(
    workspace: &str,
    prompt: &str,
    attachments: &[crate::agent::AttachmentInput],
    native_id: Option<&str>,
    options: &TurnOptions,
) -> Result<AgyTurn> {
    let mut temp_files = Vec::new();
    for (idx, attachment) in attachments.iter().enumerate() {
        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(&attachment.data_b64) {
            let ext = match attachment.mime_type.as_str() {
                "image/png" => "png",
                "image/gif" => "gif",
                "image/webp" => "webp",
                _ => "jpg",
            };
            let file_path = std::env::temp_dir().join(format!(
                "prospero-agy-att-{}-{idx}.{ext}",
                uuid::Uuid::new_v4()
            ));
            if tokio::fs::write(&file_path, bytes).await.is_ok() {
                temp_files.push(file_path);
            }
        }
    }

    let effective_prompt = if prompt.trim().is_empty() && !temp_files.is_empty() {
        "Please inspect the attached image(s)."
    } else {
        prompt
    };

    let mut command = Command::new(binary());
    command
        .args(["-p", effective_prompt, "--output-format", "stream-json"])
        .current_dir(workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(false);

    for (key, value) in &options.environment {
        command.env(key, value);
    }
    if let Some(id) = native_id.map(str::trim).filter(|id| !id.is_empty()) {
        command.args(["--conversation", id]);
    }
    let (_, _, model_effort_args) =
        resolve_cli_model_and_effort(options.model.as_deref(), options.effort.as_deref());
    command.args(model_effort_args);
    if options.mode == PermissionMode::Plan {
        command.args(["--mode", "plan"]);
    } else {
        // Headless `agy -p --output-format stream-json` has no interactive stdin
        // permission channel; without `--dangerously-skip-permissions`, tool calls
        // block indefinitely waiting for terminal approval.
        command.arg("--dangerously-skip-permissions");
    }
    for file_path in &temp_files {
        command.arg("-f").arg(file_path);
    }

    super::lifecycle::configure_process_group(&mut command);
    let child = command.spawn().map_err(|err| {
        Error::Invalid(format!("无法启动 Antigravity CLI (agy): {err}"))
    })?;
    let mut guard = ChildGuard::new(child)?;
    let lifecycle = guard.lifecycle();
    let stdout = guard.child_mut().stdout.take().ok_or(Error::Closed)?;
    let stderr = guard.child_mut().stderr.take().ok_or(Error::Closed)?;

    let (events_tx, events_rx) = mpsc::channel::<AdapterEvent>(64);
    let reader_lifecycle = lifecycle.clone();
    let interrupted = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let reader_interrupted = interrupted.clone();
    let (mut child, _) = guard.into_child();

    tokio::spawn(async move {
        let stderr_task = tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            let mut buf = Vec::new();
            while let Ok(Some(line)) = lines.next_line().await {
                if buf.len() < 20 {
                    buf.push(line);
                }
            }
            buf.join("\n")
        });

        let mut lines = BufReader::new(stdout).lines();
        let mut translator = AgyTranslator::default();
        while let Ok(Some(line)) = lines.next_line().await {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(message) = serde_json::from_str::<Value>(trimmed) else {
                continue;
            };
            for outgoing in translator.feed(&message) {
                if events_tx.send(outgoing).await.is_err() {
                    reader_lifecycle.request_termination().await;
                    await_child_exit(&mut child, &reader_lifecycle).await;
                    cleanup_temp_files(&temp_files).await;
                    return;
                }
            }
            if translator.is_result_received() {
                let _ = reader_lifecycle.request_termination().await;
                break;
            }
        }

        if !translator.is_result_received() {
            reader_lifecycle.request_termination().await;
        }
        let quiescence = await_child_exit(&mut child, &reader_lifecycle).await;
        let stderr_text = stderr_task.await.unwrap_or_default();
        cleanup_temp_files(&temp_files).await;

        let interrupted = reader_interrupted.load(std::sync::atomic::Ordering::Acquire)
            && !translator.is_result_received();
        let wait_error = match quiescence {
            Quiescence::Confirmed | Quiescence::DirectChildExited
                if translator.is_result_received() || interrupted =>
            {
                None
            }
            Quiescence::Confirmed | Quiescence::DirectChildExited => {
                let detail = stderr_text.trim();
                if !detail.is_empty() {
                    Some(format!("Antigravity CLI 执行异常: {detail}"))
                } else {
                    Some("Antigravity CLI 事件流在返回结果前结束".into())
                }
            }
            Quiescence::Unknown => Some("Antigravity CLI 进程组退出状态未知".into()),
        };

        for outgoing in translator.finalize(interrupted, wait_error) {
            if events_tx.send(outgoing).await.is_err() {
                break;
            }
        }
    });

    Ok(AgyTurn {
        events: Some(events_rx),
        lifecycle,
        interrupted,
    })
}

async fn cleanup_temp_files(files: &[PathBuf]) {
    for path in files {
        let _ = tokio::fs::remove_file(path).await;
    }
}

#[derive(Default)]
struct AgyTranslator {
    sm: TurnStreamStateMachine,
}

impl AgyTranslator {
    fn is_result_received(&self) -> bool {
        self.sm.is_result_received()
    }

    fn finalize(&mut self, interrupted: bool, wait_error: Option<String>) -> Vec<AdapterEvent> {
        self.sm.finalize(interrupted, wait_error, Vec::new())
    }

    fn feed(&mut self, message: &Value) -> Vec<AdapterEvent> {
        let mut out = Vec::new();
        let event_kind = message
            .get("event")
            .or_else(|| message.get("type"))
            .and_then(Value::as_str)
            .unwrap_or("");

        if let Some(cid) = message
            .get("conversation_id")
            .or_else(|| message.get("conversationId"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            self.sm.observe_native_id(cid, &mut out);
        }

        match event_kind {
            "init" => {
                if let Some(cid) = message
                    .get("init")
                    .and_then(|init| {
                        init.get("conversation_id")
                            .or_else(|| init.get("conversationId"))
                    })
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    self.sm.observe_native_id(cid, &mut out);
                }
            }
            "step_update" => {
                if let Some(step) = message.get("step_update").or_else(|| message.get("stepUpdate"))
                {
                    self.feed_step_update(step, &mut out);
                }
            }
            "result" => {
                if let Some(result) = message.get("result") {
                    self.feed_result(result, &mut out);
                } else {
                    self.feed_result(message, &mut out);
                }
            }
            _ => {}
        }
        out
    }

    fn feed_step_update(&mut self, step: &Value, out: &mut Vec<AdapterEvent>) {
        if let Some(cid) = step
            .get("conversation_id")
            .or_else(|| step.get("conversationId"))
            .or_else(|| step.get("cascade_id"))
            .or_else(|| step.get("cascadeId"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            self.sm.observe_native_id(cid, out);
        }

        let step_index = step
            .get("step_index")
            .or_else(|| step.get("stepIndex"))
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let step_type = step
            .get("step_type")
            .or_else(|| step.get("stepType"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let source = step.get("source").and_then(Value::as_str).unwrap_or("");
        let state = step.get("state").and_then(Value::as_str).unwrap_or("");

        // Thinking delta or full thinking text
        if let Some(thinking_delta) = step
            .get("thinking_delta")
            .or_else(|| step.get("thinkingDelta"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            self.sm
                .append_step_thinking(step_index, thinking_delta, None, out);
        } else if let Some(thinking) = step
            .get("thinking")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            self.sm.set_step_thinking(step_index, thinking, None, out);
        }

        // Assistant text delta or full text (skip user_input echoes)
        let is_user_step = step_type.eq_ignore_ascii_case("user_input")
            || source.eq_ignore_ascii_case("SOURCE_USER")
            || source.eq_ignore_ascii_case("user");
        if !is_user_step {
            if let Some(text_delta) = step
                .get("text_delta")
                .or_else(|| step.get("textDelta"))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            {
                self.sm.append_step_text(step_index, text_delta, None, out);
            } else if let Some(text) = step
                .get("text")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            {
                self.sm.set_step_text(step_index, text, None, out);
            }
        }

        // Tool calls / results inside step_update
        if let Some((tool_name, call_summary, result_summary)) = extract_step_tool(step, step_type) {
            let call_id = format!("agy-step-{step_index}-{tool_name}");
            let is_done = state.contains("DONE") || state.contains("COMPLETE");
            let is_error = state.contains("ERROR") || state.contains("FAIL");
            self.sm
                .begin_tool_call(&call_id, &tool_name, &call_summary, None, None, out);
            if is_done || is_error {
                self.sm.finish_tool_call(
                    &call_id,
                    &tool_name,
                    &result_summary,
                    is_error,
                    None,
                    None,
                    false,
                    out,
                );
            }
        }
    }

    fn feed_result(&mut self, result: &Value, out: &mut Vec<AdapterEvent>) {
        if let Some(cid) = result
            .get("conversation_id")
            .or_else(|| result.get("conversationId"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            self.sm.observe_native_id(cid, out);
        }

        if let Some(usage) = result.get("usage") {
            let input_tokens = usage
                .get("input_tokens")
                .or_else(|| usage.get("inputTokens"))
                .and_then(Value::as_i64);
            let output_tokens = usage
                .get("output_tokens")
                .or_else(|| usage.get("outputTokens"))
                .and_then(Value::as_i64);
            self.sm.record_usage(None, input_tokens, output_tokens);
        }

        let status = result
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("SUCCESS");
        let response = result
            .get("response")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");

        if status.eq_ignore_ascii_case("ERROR") || status.eq_ignore_ascii_case("FAILED") {
            let err_msg = result
                .get("error")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .unwrap_or(if !response.is_empty() {
                    response
                } else {
                    "Antigravity CLI 返回错误状态"
                });
            self.sm.record_error(err_msg);
        } else if !response.is_empty() {
            self.sm.set_final_text(response, None, out);
        }

        self.sm.mark_result_received();
    }
}

fn extract_step_tool(step: &Value, step_type: &str) -> Option<(String, String, String)> {
    let tool_info = step.get("tool_info").or_else(|| step.get("toolInfo"));
    let raw_tool_name = step
        .get("tool_name")
        .or_else(|| step.get("toolName"))
        .and_then(Value::as_str)
        .or_else(|| tool_info.and_then(|info| info.get("name")).and_then(Value::as_str))
        .map(str::trim)
        .filter(|s| !s.is_empty());

    if let Some(raw_name) = raw_tool_name {
        let display_name = normalize_agy_tool_name(raw_name);
        let params = tool_info
            .and_then(|info| info.get("parameters").or_else(|| info.get("args")))
            .unwrap_or(step);
        let call_summary = summarize_tool_payload(params, &display_name);
        let result_summary = tool_info
            .and_then(|info| info.get("output").or_else(|| info.get("error")))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.chars().take(240).collect::<String>())
            .unwrap_or_else(|| call_summary.clone());
        return Some((display_name, call_summary, result_summary));
    }

    let candidates = [
        ("run_command", "runCommand", "Bash"),
        ("view_file", "viewFile", "Read"),
        ("edit_file", "editFile", "Edit"),
        ("create_file", "createFile", "Write"),
        ("delete_file", "deleteFile", "Delete"),
        ("list_directory", "listDirectory", "Ls"),
        ("find_file", "findFile", "Find"),
        ("search_directory", "searchDirectory", "Grep"),
        ("search_web", "searchWeb", "WebSearch"),
        ("read_url_content", "readUrlContent", "WebFetch"),
        ("mcp_tool", "mcpTool", "MCP"),
        ("custom_tool", "customTool", "Tool"),
        ("skill_lookup", "skillLookup", "Skill"),
        ("invoke_subagent", "invokeSubagent", "Subagent"),
    ];
    for (snake, camel, display_name) in candidates {
        if let Some(payload) = step.get(snake).or_else(|| step.get(camel)) {
            let summary = summarize_tool_payload(payload, display_name);
            return Some((display_name.to_owned(), summary.clone(), summary));
        }
    }
    if !step_type.is_empty()
        && !matches!(
            step_type,
            "user_input" | "agent_response" | "planner_response" | "thinking" | "text"
        )
    {
        return Some((
            step_type.to_owned(),
            step_type.to_owned(),
            step_type.to_owned(),
        ));
    }
    None
}

fn normalize_agy_tool_name(raw_name: &str) -> String {
    match raw_name {
        "run_command" | "send_command_input" | "command_status" => "Bash".into(),
        "read_file" | "view_file" | "read_resource" => "Read".into(),
        "edit_file" | "replace_file_content" | "multi_replace_file_content" | "sed_file" => {
            "Edit".into()
        }
        "write_file" | "write_to_file" | "create_file" => "Write".into(),
        "grep_search" | "search_directory" => "Grep".into(),
        "find_by_name" | "find_file" => "Find".into(),
        "list_dir" | "list_directory" | "list_resources" => "Ls".into(),
        "search_web" | "search_marketplace" => "WebSearch".into(),
        "read_url_content" => "WebFetch".into(),
        "call_mcp_tool" | "mcp_tool" => "MCP".into(),
        "invoke_subagent" | "manage_subagents" | "browser_subagent" => "Subagent".into(),
        other => other.to_owned(),
    }
}

fn summarize_tool_payload(payload: &Value, fallback: &str) -> String {
    for key in [
        "CommandLine",
        "command_line",
        "commandLine",
        "command",
        "Path",
        "TargetFile",
        "FilePath",
        "file_path",
        "filePath",
        "path",
        "DirectoryPath",
        "SearchPath",
        "directory_path",
        "directoryPath",
        "Query",
        "Pattern",
        "query",
        "Url",
        "url",
        "toolSummary",
        "tool_name",
        "toolName",
        "skill_name",
        "skillName",
        "Role",
        "Prompt",
        "summary",
    ] {
        if let Some(val) = payload
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return val.chars().take(240).collect();
        }
    }
    fallback.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_agy_models_table_output() {
        let sample = "\
Available models (13):

  gemini-4-argon-high              Gemini 4 Argon (High)
  gemini-4-argon-medium            Gemini 4 Argon (Medium)
  claude-opus-5-5-high             Claude Opus 5.5 (High)

Usage: agy --model <id> [prompt]
";
        let models = parse_models_output(sample);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "gemini-4-argon");
        assert_eq!(models[0].label, "Gemini 4 Argon");
        assert_eq!(models[0].default_effort.as_deref(), Some("medium"));
        assert_eq!(
            models[0].supported_efforts,
            vec!["medium".to_owned(), "high".to_owned()]
        );
        assert!(models[0].is_default);
        assert_eq!(models[1].id, "claude-opus-5-5");
        assert_eq!(models[1].label, "Claude Opus 5.5");
        assert_eq!(models[1].default_effort.as_deref(), Some("high"));
        assert!(!models[1].is_default);
    }

    #[test]
    fn resolves_cli_model_and_effort_without_conflict() {
        let (model, effort, args) =
            resolve_cli_model_and_effort(Some("gemini-4-argon-medium"), Some("max"));
        assert_eq!(model.as_deref(), Some("gemini-4-argon"));
        assert_eq!(effort.as_deref(), Some("high"));
        assert_eq!(args, vec!["--model", "gemini-4-argon-high"]);

        let (model, effort, args) =
            resolve_cli_model_and_effort(Some("gpt-oss-120b"), Some("high"));
        assert_eq!(model.as_deref(), Some("gpt-oss-120b"));
        assert_eq!(effort.as_deref(), Some("medium"));
        assert_eq!(args, vec!["--model", "gpt-oss-120b-medium"]);

        let (model, effort, args) = resolve_cli_model_and_effort(None, Some("max"));
        assert_eq!(model, None);
        assert_eq!(effort.as_deref(), Some("high"));
        assert_eq!(args, vec!["--effort", "high"]);
    }

    #[test]
    fn translates_stream_json_init_step_and_result() {
        let mut translator = AgyTranslator::default();
        let init: Value = serde_json::from_str(
            r#"{"event":"init","conversation_id":"f54fdff9-fc4a-4cf8-8cf8-be185b18c06c","init":{"model":"MODEL_PLACEHOLDER_M47","cwd":"/private/tmp"}}"#,
        )
        .unwrap();
        let events = translator.feed(&init);
        assert!(matches!(
            events.as_slice(),
            [AdapterEvent::NativeId(id)] if id == "f54fdff9-fc4a-4cf8-8cf8-be185b18c06c"
        ));

        let result: Value = serde_json::from_str(
            r#"{"event":"result","result":{"conversation_id":"f54fdff9-fc4a-4cf8-8cf8-be185b18c06c","status":"SUCCESS","response":"PONG","duration_seconds":2.5,"usage":{"input_tokens":10,"output_tokens":5}}}"#,
        )
        .unwrap();
        let events = translator.feed(&result);
        assert!(matches!(
            events.as_slice(),
            [AdapterEvent::Text { subagent: None, text }] if text == "PONG"
        ));
        assert!(translator.is_result_received());
        let final_events = translator.finalize(false, None);
        assert!(matches!(
            final_events.as_slice(),
            [AdapterEvent::Finish {
                interrupted: false,
                error: None,
                input_tokens: Some(10),
                output_tokens: Some(5),
                ..
            }]
        ));
    }

    #[test]
    fn translates_tool_call_and_agent_response_steps() {
        let mut translator = AgyTranslator::default();
        let step1: Value = serde_json::from_str(
            r#"{"event":"step_update","step_update":{"conversation_id":"0339b39c","step_index":1,"state":"DONE","step_type":"agent_response","duration_seconds":1.0}}"#,
        )
        .unwrap();
        let events = translator.feed(&step1);
        assert!(matches!(
            events.as_slice(),
            [AdapterEvent::NativeId(id)] if id == "0339b39c"
        ));

        let tool_active: Value = serde_json::from_str(
            r#"{"event":"step_update","step_update":{"conversation_id":"0339b39c","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"read_file","tool_info":{"name":"read_file","parameters":{"EndLine":5,"Path":"/workspace/Prospero/Cargo.toml","StartLine":1}}}}"#,
        )
        .unwrap();
        let events = translator.feed(&tool_active);
        assert!(matches!(
            events.as_slice(),
            [AdapterEvent::ToolCall { name, summary, .. }]
                if name == "Read" && summary == "/workspace/Prospero/Cargo.toml"
        ));

        let tool_done: Value = serde_json::from_str(
            r#"{"event":"step_update","step_update":{"conversation_id":"0339b39c","step_index":2,"state":"DONE","step_type":"tool","tool_name":"read_file","duration_seconds":0.11,"tool_info":{"name":"read_file","parameters":{"EndLine":5,"Path":"/workspace/Prospero/Cargo.toml","StartLine":1},"output":"21 lines, 362 bytes"}}}"#,
        )
        .unwrap();
        let events = translator.feed(&tool_done);
        assert!(matches!(
            events.as_slice(),
            [AdapterEvent::ToolResult { name, summary, error: false, .. }]
                if name == "Read" && summary == "21 lines, 362 bytes"
        ));

        let step3: Value = serde_json::from_str(
            r#"{"event":"step_update","step_update":{"conversation_id":"0339b39c","step_index":3,"state":"ACTIVE","step_type":"agent_response","text_delta":"OK"}}"#,
        )
        .unwrap();
        let events = translator.feed(&step3);
        assert!(matches!(
            events.as_slice(),
            [AdapterEvent::Text { subagent: None, text }] if text == "OK"
        ));
    }
}
