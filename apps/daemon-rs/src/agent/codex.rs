//! Direct Codex app-server structured driver.
//!
//! This is the Rust daemon's native counterpart for the TS Codex adapter's
//! JSON-RPC-over-stdio path.  The first slice intentionally focuses on the
//! core session lifecycle (initialize, thread start/resume, turn start,
//! streamed assistant/reasoning text and completion) so Codex structured
//! sessions no longer fall back to the legacy daemon boundary.

use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, mpsc, oneshot};

use super::claude::{AdapterEvent, QuestionOptionSpec, QuestionReply, QuestionSpec, TurnOptions};
use super::store::{ApprovalPolicy, PermissionMode};
use crate::error::{Error, Result};

const START_TIMEOUT: Duration = Duration::from_secs(30);
const CONTROL_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_LINE_BYTES: usize = 4 * 1024 * 1024;

type PendingResponses =
    Arc<Mutex<HashMap<String, oneshot::Sender<std::result::Result<Value, String>>>>>;

struct NotificationState {
    current_turn: Arc<Mutex<Option<String>>>,
    current_turns: Arc<Mutex<HashMap<String, String>>>,
    responses: PendingResponses,
}

fn binary() -> String {
    std::env::var("PROSPERO_CODEX_BIN").unwrap_or_else(|_| "codex".into())
}

#[cfg(unix)]
fn kill_process_group(pid: u32) {
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
        libc::kill(pid as i32, libc::SIGKILL);
    }
}

#[cfg(not(unix))]
fn kill_process_group(pid: u32) {
    let _ = pid;
}

pub(super) struct CodexTurn {
    stdin: mpsc::Sender<(Value, Option<oneshot::Sender<()>>)>,
    events: Option<mpsc::Receiver<AdapterEvent>>,
    thread_id: String,
    current_turn: Arc<Mutex<Option<String>>>,
    current_turns: Arc<Mutex<HashMap<String, String>>>,
    approval_policy: Value,
    sandbox_policy: Value,
    model: Option<String>,
    effort: Option<String>,
    mode: PermissionMode,
    child_pid: u32,
    responses: PendingResponses,
}

struct StartingRpc {
    child: Child,
    stdin: tokio::process::ChildStdin,
    stdout: BufReader<tokio::process::ChildStdout>,
    next_id: u64,
}

impl StartingRpc {
    async fn start(
        workspace: &str,
        environment: &[(String, String)],
        app_server_args: &[String],
    ) -> Result<Self> {
        let mut command = Command::new(binary());
        command
            .arg("app-server")
            .args(app_server_args)
            .current_dir(workspace)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(false);
        for (key, value) in environment {
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
        if let Some(mut stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut sink = Vec::new();
                let _ = tokio::io::AsyncReadExt::read_to_end(&mut stderr, &mut sink).await;
            });
        }
        let stdin = child.stdin.take().ok_or(Error::Closed)?;
        let stdout = child.stdout.take().ok_or(Error::Closed)?;
        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 1,
        })
    }

    async fn notify(&mut self, method: &str, params: Value) -> Result<()> {
        write_frame(
            &mut self.stdin,
            &json!({ "jsonrpc": "2.0", "method": method, "params": params }),
        )
        .await
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        write_frame(
            &mut self.stdin,
            &json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }),
        )
        .await?;
        tokio::time::timeout(START_TIMEOUT, read_response(&mut self.stdout, id))
            .await
            .map_err(|_| Error::Timeout)?
    }
}

async fn write_frame(stdin: &mut tokio::process::ChildStdin, frame: &Value) -> Result<()> {
    let mut bytes = serde_json::to_vec(frame)?;
    bytes.push(b'\n');
    stdin.write_all(&bytes).await?;
    stdin.flush().await?;
    Ok(())
}

async fn read_response(
    stdout: &mut BufReader<tokio::process::ChildStdout>,
    id: u64,
) -> Result<Value> {
    loop {
        let mut line = String::new();
        let n = stdout.read_line(&mut line).await?;
        if n == 0 {
            return Err(Error::Closed);
        }
        if line.len() > MAX_LINE_BYTES {
            return Err(Error::Invalid("codex response too large".into()));
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

pub(super) async fn spawn_turn(
    data: &Path,
    workspace: &str,
    prompt: &str,
    native_id: Option<&str>,
    options: &TurnOptions,
) -> Result<CodexTurn> {
    let (environment, app_server_args) = if let Some(profile) = options.api_profile.as_ref() {
        if profile.protocol() != "openai_responses" {
            return Err(Error::Invalid(
                "Codex structured runtime 仅支持 OpenAI Responses Profile".into(),
            ));
        }
        (
            options.environment.clone(),
            crate::accounts::profile::codex_app_server_args(profile),
        )
    } else {
        let (_home, environment) = super::usage::native_codex_environment(data)?;
        (environment, Vec::new())
    };
    let mut rpc = StartingRpc::start(workspace, &environment, &app_server_args).await?;
    let child_pid = rpc.child.id().ok_or(Error::Closed)?;
    rpc.request(
        "initialize",
        json!({
            "clientInfo": { "name": "prospero", "title": "Prospero", "version": env!("CARGO_PKG_VERSION") },
            "capabilities": { "experimentalApi": true, "requestAttestation": false },
        }),
    )
    .await?;
    rpc.notify("initialized", json!({})).await?;

    let policy = execution_policy(workspace, options.policy);
    let mut base = serde_json::Map::new();
    base.insert("cwd".into(), json!(workspace));
    base.insert("approvalPolicy".into(), policy.approval_policy);
    base.insert("sandbox".into(), policy.sandbox);
    base.insert(
        "developerInstructions".into(),
        json!(crate::cross_model_tool::CODEX_DEVELOPER_INSTRUCTIONS),
    );
    if let Some(model) = options.model.as_ref() {
        base.insert("model".into(), json!(model));
    }
    let started = if let Some(thread_id) = native_id {
        let mut params = base.clone();
        params.insert("threadId".into(), json!(thread_id));
        match rpc.request("thread/resume", Value::Object(params)).await {
            Ok(value) => value,
            Err(Error::Invalid(message))
                if message.to_ascii_lowercase().contains("no rollout found") =>
            {
                rpc.request("thread/start", Value::Object(base)).await?
            }
            Err(error) => return Err(error),
        }
    } else {
        rpc.request("thread/start", Value::Object(base)).await?
    };
    let thread_id = started
        .get("thread")
        .and_then(|thread| thread.get("id"))
        .or_else(|| started.get("threadId"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| Error::Invalid("codex thread/start 未返回 threadId".into()))?
        .to_owned();

    let (frames_tx, mut frames_rx) = mpsc::channel::<(Value, Option<oneshot::Sender<()>>)>(32);
    let (events_tx, events_rx) = mpsc::channel::<AdapterEvent>(64);
    let responses: PendingResponses = Arc::new(Mutex::new(HashMap::new()));
    let _ = events_tx.try_send(AdapterEvent::NativeId(thread_id.clone()));
    let current_turn = Arc::new(Mutex::new(None));
    let current_turns = Arc::new(Mutex::new(HashMap::new()));

    let mut stdin = rpc.stdin;
    tokio::spawn(async move {
        while let Some((frame, ack)) = frames_rx.recv().await {
            if write_frame(&mut stdin, &frame).await.is_err() {
                break;
            }
            if let Some(ack) = ack {
                let _ = ack.send(());
            }
        }
    });

    let reader_current_turn = current_turn.clone();
    let reader_current_turns = current_turns.clone();
    let reader_frames = frames_tx.clone();
    let reader_thread_id = thread_id.clone();
    let reader_responses = responses.clone();
    let auto_approve = options.policy == ApprovalPolicy::Auto;
    tokio::spawn(async move {
        read_notifications(
            rpc.stdout,
            events_tx,
            reader_frames,
            auto_approve,
            reader_thread_id,
            NotificationState {
                current_turn: reader_current_turn,
                current_turns: reader_current_turns,
                responses: reader_responses,
            },
        )
        .await;
        let _ = rpc.child.start_kill();
        let _ = tokio::time::timeout(Duration::from_secs(2), rpc.child.wait()).await;
    });

    let turn_start_id = 1_000_000_u64;
    let mut turn_params = serde_json::Map::new();
    turn_params.insert("threadId".into(), json!(thread_id));
    turn_params.insert(
        "input".into(),
        json!([{ "type": "text", "text": prompt, "text_elements": [] }]),
    );
    turn_params.insert(
        "approvalPolicy".into(),
        policy.approval_policy_for_turn.clone(),
    );
    turn_params.insert("sandboxPolicy".into(), policy.sandbox_policy.clone());
    if let Some(model) = options.model.as_ref() {
        turn_params.insert("model".into(), json!(model));
        turn_params.insert("collaborationMode".into(), collaboration_mode(options));
    }
    if let Some(effort) = options.effort.as_ref() {
        turn_params.insert("effort".into(), json!(effort));
    }
    frames_tx
        .try_send((
            json!({ "jsonrpc": "2.0", "id": turn_start_id, "method": "turn/start", "params": Value::Object(turn_params) }),
            None,
        ))
        .map_err(|_| Error::Closed)?;

    Ok(CodexTurn {
        stdin: frames_tx,
        events: Some(events_rx),
        thread_id,
        current_turn,
        current_turns,
        approval_policy: policy.approval_policy_for_turn,
        sandbox_policy: policy.sandbox_policy,
        model: options.model.clone(),
        effort: options.effort.clone(),
        mode: options.mode,
        child_pid,
        responses,
    })
}

pub(super) async fn read_subagent_history_once(
    data: &Path,
    workspace: &str,
    parent_thread_id: &str,
    subagent_id: &str,
) -> Result<Option<Vec<Value>>> {
    let (_home, environment) = super::usage::native_codex_environment(data)?;
    let mut rpc = StartingRpc::start(workspace, &environment, &[]).await?;
    let result = async {
        rpc.request(
            "initialize",
            json!({
                "clientInfo": { "name": "prospero", "title": "Prospero", "version": env!("CARGO_PKG_VERSION") },
                "capabilities": { "experimentalApi": true, "requestAttestation": false },
            }),
        )
        .await?;
        rpc.notify("initialized", json!({})).await?;
        let _ = rpc
            .request(
                "thread/resume",
                json!({
                    "threadId": parent_thread_id,
                    "cwd": workspace,
                    "approvalPolicy": "untrusted",
                    "sandbox": "workspace-write",
                }),
            )
            .await?;
        let raw = rpc
            .request(
                "thread/read",
                json!({ "threadId": subagent_id, "includeTurns": true }),
            )
            .await?;
        let Some(thread) = raw.get("thread").and_then(Value::as_object) else {
            return Ok(None);
        };
        if thread.get("id").and_then(Value::as_str) != Some(subagent_id)
            || thread.get("parentThreadId").and_then(Value::as_str) != Some(parent_thread_id)
        {
            return Err(Error::Invalid("Codex 返回的线程不属于当前父会话".into()));
        }
        Ok(Some(history_events(thread, subagent_id)))
    }
    .await;
    let _ = rpc.child.start_kill();
    let _ = tokio::time::timeout(Duration::from_secs(2), rpc.child.wait()).await;
    result
}

struct ExecutionPolicy {
    approval_policy: Value,
    approval_policy_for_turn: Value,
    sandbox: Value,
    sandbox_policy: Value,
}

fn execution_policy(workspace: &str, policy: ApprovalPolicy) -> ExecutionPolicy {
    if policy == ApprovalPolicy::Auto {
        ExecutionPolicy {
            approval_policy: json!("never"),
            approval_policy_for_turn: json!("never"),
            sandbox: json!("danger-full-access"),
            sandbox_policy: json!({ "type": "dangerFullAccess" }),
        }
    } else {
        ExecutionPolicy {
            approval_policy: json!("untrusted"),
            approval_policy_for_turn: json!("untrusted"),
            sandbox: json!("workspace-write"),
            sandbox_policy: json!({ "type": "workspaceWrite", "writableRoots": [workspace] }),
        }
    }
}

fn collaboration_mode(options: &TurnOptions) -> Value {
    json!({
        "mode": if options.mode == PermissionMode::Plan { "plan" } else { "default" },
        "settings": {
            "model": options.model.as_deref().unwrap_or(""),
            "reasoning_effort": options.effort,
            "developer_instructions": null,
        }
    })
}

async fn read_notifications(
    mut stdout: BufReader<tokio::process::ChildStdout>,
    events: mpsc::Sender<AdapterEvent>,
    writer: mpsc::Sender<(Value, Option<oneshot::Sender<()>>)>,
    auto_approve: bool,
    root_thread_id: String,
    state: NotificationState,
) {
    let mut streamed: HashMap<String, String> = HashMap::new();
    let mut subagents: HashMap<String, bool> = HashMap::new();
    let mut pending_diffs: HashMap<String, crate::protocol::FileDiff> = HashMap::new();
    let mut turn_diffs: HashMap<String, crate::protocol::FileDiff> = HashMap::new();
    let mut aggregate_diffs: Option<Vec<crate::protocol::FileDiff>> = None;
    let mut last_text: Option<String> = None;
    let mut last_input_tokens: Option<i64> = None;
    let mut last_output_tokens: Option<i64> = None;
    let mut sent_finish = false;
    loop {
        let mut line = String::new();
        let Ok(n) = stdout.read_line(&mut line).await else {
            break;
        };
        if n == 0 {
            break;
        }
        if line.len() > MAX_LINE_BYTES {
            let _ = events
                .send(AdapterEvent::Finish {
                    interrupted: false,
                    error: Some("codex response too large".into()),
                    cost_usd: None,
                    input_tokens: last_input_tokens,
                    output_tokens: last_output_tokens,
                    diffs: Vec::new(),
                })
                .await;
            sent_finish = true;
            break;
        }
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if message.get("method").is_none() {
            if let Some(id) = rpc_id_key(message.get("id"))
                && let Some(tx) = state.responses.lock().await.remove(&id)
            {
                let result = if let Some(error) = message.get("error") {
                    Err(error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("codex RPC failed")
                        .chars()
                        .take(1000)
                        .collect::<String>())
                } else {
                    Ok(message.get("result").cloned().unwrap_or_else(|| json!({})))
                };
                let _ = tx.send(result);
            }
            continue;
        }
        if let Some(error) = message.get("error") {
            let text = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("codex RPC failed")
                .chars()
                .take(1000)
                .collect::<String>();
            let _ = events
                .send(AdapterEvent::Finish {
                    interrupted: false,
                    error: Some(text),
                    cost_usd: None,
                    input_tokens: last_input_tokens,
                    output_tokens: last_output_tokens,
                    diffs: Vec::new(),
                })
                .await;
            sent_finish = true;
            break;
        }
        let Some(method) = message.get("method").and_then(Value::as_str) else {
            continue;
        };
        let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
        let notification_thread = params
            .get("threadId")
            .and_then(Value::as_str)
            .unwrap_or(&root_thread_id);
        let agent_id = (notification_thread != root_thread_id
            && subagents.contains_key(notification_thread))
        .then(|| notification_thread.to_owned());
        if message.get("id").is_some() {
            handle_request(
                message.get("id").cloned().unwrap_or(Value::Null),
                method,
                &params,
                &events,
                &writer,
                auto_approve,
            )
            .await;
            continue;
        }
        match method {
            "thread/started" => {
                let thread = params.get("thread").cloned().unwrap_or_else(|| json!({}));
                let id = thread.get("id").and_then(Value::as_str).unwrap_or_default();
                let parent = thread
                    .get("parentThreadId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !id.is_empty() && parent == root_thread_id {
                    subagents.insert(id.to_owned(), true);
                    let name = thread
                        .get("agentNickname")
                        .or_else(|| thread.get("name"))
                        .and_then(Value::as_str)
                        .unwrap_or("Codex subagent")
                        .chars()
                        .take(120)
                        .collect::<String>();
                    let role = thread
                        .get("agentRole")
                        .and_then(Value::as_str)
                        .map(|value| value.chars().take(200).collect::<String>());
                    let task = thread
                        .get("preview")
                        .and_then(Value::as_str)
                        .map(|value| value.chars().take(1000).collect::<String>());
                    let _ = events
                        .send(AdapterEvent::SubagentStarted {
                            subagent: id.to_owned(),
                            name,
                            role,
                            task,
                        })
                        .await;
                }
            }
            "thread/status/changed" => {
                let id = params
                    .get("threadId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !id.is_empty() && subagents.contains_key(id) {
                    let (status, can_message) = subagent_status(params.get("status"));
                    let _ = events
                        .send(AdapterEvent::SubagentUpdate {
                            subagent: id.to_owned(),
                            status,
                            can_message,
                            summary: None,
                        })
                        .await;
                }
            }
            "turn/started" => {
                let turn_id = params
                    .get("turn")
                    .and_then(|turn| turn.get("id"))
                    .or_else(|| params.get("turnId"))
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                if notification_thread == root_thread_id {
                    *state.current_turn.lock().await = turn_id;
                    last_text = None;
                    streamed.clear();
                } else if let Some(turn_id) = turn_id {
                    state
                        .current_turns
                        .lock()
                        .await
                        .insert(notification_thread.to_owned(), turn_id);
                }
            }
            "item/agentMessage/delta" | "item/plan/delta" => {
                if let Some(delta) = params.get("delta").and_then(Value::as_str)
                    && !delta.is_empty()
                {
                    let msg_id = codex_item_id(&params, &state.current_turn).await;
                    last_text = Some(msg_id.clone());
                    let full = streamed.entry(msg_id.clone()).or_default();
                    full.push_str(delta);
                    let _ = events
                        .send(AdapterEvent::Text {
                            subagent: agent_id.clone(),
                            text: full.clone(),
                        })
                        .await;
                }
            }
            "item/reasoning/textDelta" | "item/reasoning/summaryTextDelta" => {
                if let Some(delta) = params.get("delta").and_then(Value::as_str)
                    && !delta.is_empty()
                {
                    let _ = events
                        .send(AdapterEvent::Thinking {
                            subagent: agent_id.clone(),
                            text: delta.to_owned(),
                        })
                        .await;
                }
            }
            "item/started" => {
                let item = params.get("item").cloned().unwrap_or_else(|| json!({}));
                let item_type = item_type(&item);
                let item_id = codex_item_id_from_item(&params, &item).unwrap_or_else(|| {
                    futures_current_turn(&state.current_turn).unwrap_or_else(|| "codex-tool".into())
                });
                if item_type == "collabAgentToolCall" {
                    // The item names the child thread before thread/started
                    // carries richer metadata. Remember it now so attributed
                    // deltas route to the subagent; a later status/completion
                    // update will create a minimal card if thread/started does
                    // not arrive on this app-server version.
                    for receiver in receiver_thread_ids(&item) {
                        subagents.insert(receiver, true);
                    }
                    continue;
                }
                if let Some((tool, summary)) = tool_start_summary(&item_type, &item) {
                    let diff = codex_file_changes(&item).into_iter().next();
                    let _ = events
                        .send(AdapterEvent::ToolCall {
                            subagent: agent_id.clone(),
                            call_id: item_id,
                            name: tool,
                            summary,
                            diff,
                        })
                        .await;
                }
            }
            "item/fileChange/patchUpdated" => {
                let item_id = params
                    .get("itemId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                if !item_id.is_empty()
                    && let Some(diff) = extract_diff(&params)
                {
                    pending_diffs.insert(item_id, diff);
                }
            }
            "turn/diff/updated" => {
                if let Some(patch) = params.get("diff").and_then(Value::as_str)
                    && !patch.is_empty()
                {
                    aggregate_diffs = Some(codex_turn_diffs(patch));
                }
            }
            "item/completed" => {
                let item = params.get("item").cloned().unwrap_or_else(|| json!({}));
                let item_type = item_type(&item);
                if item_type == "agentMessage" || item_type == "plan" {
                    let msg_id = item
                        .get("id")
                        .or_else(|| params.get("itemId"))
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                        .unwrap_or_else(|| {
                            last_text.clone().unwrap_or_else(|| "codex-message".into())
                        });
                    last_text = Some(msg_id.clone());
                    if let Some(text) = item.get("text").and_then(Value::as_str) {
                        let seen = streamed.remove(&msg_id).unwrap_or_default();
                        if text != seen {
                            let _ = events
                                .send(AdapterEvent::Text {
                                    subagent: agent_id.clone(),
                                    text: text.to_owned(),
                                })
                                .await;
                        }
                    }
                } else if item_type == "collabAgentToolCall" {
                    let raw = item
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("completed");
                    let status = if raw == "failed" {
                        "failed"
                    } else {
                        "completed"
                    };
                    for receiver in receiver_thread_ids(&item) {
                        if subagents.contains_key(&receiver) {
                            let _ = events
                                .send(AdapterEvent::SubagentUpdate {
                                    subagent: receiver,
                                    status,
                                    can_message: false,
                                    summary: None,
                                })
                                .await;
                        }
                    }
                } else if let Some((tool, summary, error, has_more)) =
                    tool_result_summary(&item_type, &item)
                {
                    let item_id = codex_item_id_from_item(&params, &item).unwrap_or_else(|| {
                        futures_current_turn(&state.current_turn)
                            .unwrap_or_else(|| "codex-tool".into())
                    });
                    let changes = codex_file_changes(&item);
                    let diff = changes
                        .first()
                        .cloned()
                        .or_else(|| pending_diffs.remove(&item_id));
                    if item_type == "fileChange" && !error {
                        for change in changes.into_iter().chain(diff.clone()) {
                            turn_diffs.insert(change.path.clone(), change);
                        }
                    }
                    let _ = events
                        .send(AdapterEvent::ToolResult {
                            subagent: agent_id.clone(),
                            call_id: item_id,
                            name: tool,
                            summary,
                            error,
                            diff,
                            has_more,
                        })
                        .await;
                }
            }
            "thread/tokenUsage/updated" => {
                let last = params
                    .get("tokenUsage")
                    .and_then(|value| value.get("last"))
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                last_input_tokens = last.get("inputTokens").and_then(Value::as_i64);
                last_output_tokens = last.get("outputTokens").and_then(Value::as_i64);
            }
            "turn/completed" => {
                if notification_thread != root_thread_id {
                    state.current_turns.lock().await.remove(notification_thread);
                    continue;
                }
                let turn = params.get("turn").cloned().unwrap_or_else(|| json!({}));
                let status = turn
                    .get("status")
                    .or_else(|| params.get("status"))
                    .and_then(Value::as_str)
                    .unwrap_or("completed");
                let failed = matches!(status, "failed" | "error");
                let interrupted = matches!(status, "cancelled" | "canceled" | "interrupted");
                let diffs = aggregate_diffs
                    .take()
                    .unwrap_or_else(|| turn_diffs.values().cloned().collect());
                let _ = events
                    .send(AdapterEvent::Finish {
                        interrupted,
                        error: failed.then(|| format!("Codex turn {status}")),
                        cost_usd: None,
                        input_tokens: last_input_tokens,
                        output_tokens: last_output_tokens,
                        diffs,
                    })
                    .await;
                sent_finish = true;
                break;
            }
            _ => {}
        }
    }
    if !sent_finish {
        let _ = events
            .send(AdapterEvent::Finish {
                interrupted: false,
                error: Some("codex stream closed".into()),
                cost_usd: None,
                input_tokens: last_input_tokens,
                output_tokens: last_output_tokens,
                diffs: Vec::new(),
            })
            .await;
    }
}

fn rpc_id_key(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) if !text.is_empty() => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

async fn handle_request(
    rpc_id: Value,
    method: &str,
    params: &Value,
    events: &mpsc::Sender<AdapterEvent>,
    writer: &mpsc::Sender<(Value, Option<oneshot::Sender<()>>)>,
    auto_approve: bool,
) {
    if method == "item/tool/requestUserInput" {
        handle_question_request(rpc_id, params, events, writer).await;
        return;
    }
    let Some(kind) = approval_kind(method) else {
        respond_error(writer, rpc_id, -32601, format!("prospero 不支持 {method}")).await;
        return;
    };
    let item_id = params
        .get("itemId")
        .and_then(Value::as_str)
        .or_else(|| {
            params
                .get("item")
                .and_then(|item| item.get("id"))
                .and_then(Value::as_str)
        })
        .or_else(|| params.get("callId").and_then(Value::as_str))
        .unwrap_or("codex-approval")
        .chars()
        .take(120)
        .collect::<String>();
    let (tool, action, subject) = approval_summary(method, params);
    if auto_approve {
        respond_result(writer, rpc_id, approval_response(kind, true, params)).await;
        return;
    }
    let (reply, reply_rx) = oneshot::channel();
    if events
        .send(AdapterEvent::Permission {
            subagent: None,
            request_id: item_id,
            tool,
            summary: format!("{action}:{subject}"),
            reply,
        })
        .await
        .is_err()
    {
        respond_result(writer, rpc_id, approval_response(kind, false, params)).await;
        return;
    }
    let writer = writer.clone();
    let params = params.clone();
    tokio::spawn(async move {
        let allow = reply_rx.await.unwrap_or(false);
        respond_result(&writer, rpc_id, approval_response(kind, allow, &params)).await;
    });
}

async fn handle_question_request(
    rpc_id: Value,
    params: &Value,
    events: &mpsc::Sender<AdapterEvent>,
    writer: &mpsc::Sender<(Value, Option<oneshot::Sender<()>>)>,
) {
    let item_id = params
        .get("approvalId")
        .and_then(Value::as_str)
        .or_else(|| params.get("itemId").and_then(Value::as_str))
        .or_else(|| params.get("callId").and_then(Value::as_str))
        .unwrap_or("codex-question")
        .chars()
        .take(120)
        .collect::<String>();
    let questions = params
        .get("questions")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .enumerate()
                .filter_map(|(index, row)| codex_question(row, index))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if questions.is_empty() {
        respond_result(writer, rpc_id, json!({ "answers": {} })).await;
        return;
    }
    let (reply, reply_rx) = oneshot::channel();
    if events
        .send(AdapterEvent::Question {
            subagent: None,
            request_id: item_id,
            questions,
            reply,
        })
        .await
        .is_err()
    {
        respond_result(writer, rpc_id, json!({ "answers": {} })).await;
        return;
    }
    let writer = writer.clone();
    tokio::spawn(async move {
        let mut answers = serde_json::Map::new();
        if let Ok(QuestionReply {
            answers: native,
            cancelled: false,
        }) = reply_rx.await
        {
            for (question_id, answer) in native {
                let values = answer
                    .split(", ")
                    .filter(|value| !value.is_empty())
                    .map(|value| Value::String(value.to_owned()))
                    .collect::<Vec<_>>();
                answers.insert(question_id, json!({ "answers": values }));
            }
        }
        respond_result(&writer, rpc_id, json!({ "answers": answers })).await;
    });
}

fn codex_question(row: &Value, index: usize) -> Option<QuestionSpec> {
    let row = row.as_object()?;
    let id = row
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("question-{}", index + 1));
    let question = row
        .get("question")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("请选择")
        .chars()
        .take(1000)
        .collect::<String>();
    let header = row
        .get("header")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("Agent 提问")
        .chars()
        .take(120)
        .collect::<String>();
    let options = row
        .get("options")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|option| {
                    let option = option.as_object()?;
                    let label = option.get("label")?.as_str()?.chars().take(200).collect();
                    let description = option
                        .get("description")
                        .and_then(Value::as_str)
                        .map(|value| value.chars().take(1000).collect());
                    Some(QuestionOptionSpec {
                        label,
                        description,
                        preview: None,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Some(QuestionSpec {
        native_question: id.clone(),
        id,
        header,
        question,
        options,
        multi_select: row.get("multiSelect").and_then(Value::as_bool) == Some(true),
    })
}

#[derive(Clone, Copy)]
enum ApprovalKind {
    V2CommandOrFile,
    V2Permissions,
    Legacy,
}

fn approval_kind(method: &str) -> Option<ApprovalKind> {
    match method {
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
            Some(ApprovalKind::V2CommandOrFile)
        }
        "item/permissions/requestApproval" => Some(ApprovalKind::V2Permissions),
        "execCommandApproval" | "applyPatchApproval" => Some(ApprovalKind::Legacy),
        _ => None,
    }
}

fn approval_summary(method: &str, params: &Value) -> (String, &'static str, String) {
    match method {
        "item/commandExecution/requestApproval" | "execCommandApproval" => {
            let command = params
                .get("command")
                .or_else(|| params.get("parsedCommand"))
                .or_else(|| params.get("argv"));
            ("commandExecution".into(), "运行命令", summarize(command))
        }
        "item/fileChange/requestApproval" | "applyPatchApproval" => {
            let reason = params
                .get("reason")
                .or_else(|| params.get("grantRoot"))
                .or_else(|| params.get("changes"))
                .or_else(|| params.get("fileChanges"));
            ("fileChange".into(), "修改文件", summarize(reason))
        }
        "item/permissions/requestApproval" => {
            let reason = params.get("reason");
            ("permissions".into(), "请求额外权限", summarize(reason))
        }
        _ => ("tool".into(), "执行操作", summarize(Some(params))),
    }
}

fn approval_response(kind: ApprovalKind, allow: bool, params: &Value) -> Value {
    match kind {
        ApprovalKind::V2CommandOrFile => {
            json!({ "decision": if allow { "accept" } else { "decline" } })
        }
        ApprovalKind::V2Permissions => {
            if !allow {
                json!({ "permissions": {}, "scope": "turn" })
            } else {
                let mut permissions = serde_json::Map::new();
                if let Some(network) = params.get("permissions").and_then(|p| p.get("network"))
                    && !network.is_null()
                {
                    permissions.insert("network".into(), network.clone());
                }
                if let Some(file_system) =
                    params.get("permissions").and_then(|p| p.get("fileSystem"))
                    && !file_system.is_null()
                {
                    permissions.insert("fileSystem".into(), file_system.clone());
                }
                json!({ "permissions": permissions, "scope": "turn" })
            }
        }
        ApprovalKind::Legacy => {
            if allow {
                json!({ "decision": "approved" })
            } else {
                json!({ "decision": { "denied": { "rejection": "用户拒绝了此操作" } } })
            }
        }
    }
}

async fn respond_result(
    writer: &mpsc::Sender<(Value, Option<oneshot::Sender<()>>)>,
    id: Value,
    result: Value,
) {
    let _ = writer
        .send((
            json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            None,
        ))
        .await;
}

async fn respond_error(
    writer: &mpsc::Sender<(Value, Option<oneshot::Sender<()>>)>,
    id: Value,
    code: i64,
    message: String,
) {
    let _ = writer
        .send((
            json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }),
            None,
        ))
        .await;
}

fn item_type(item: &Value) -> String {
    item.get("type")
        .or_else(|| item.get("item_type"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn codex_item_id_from_item(params: &Value, item: &Value) -> Option<String> {
    item.get("id")
        .or_else(|| params.get("itemId"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(120).collect())
}

fn tool_start_summary(item_type: &str, item: &Value) -> Option<(String, String)> {
    match item_type {
        "commandExecution" => Some(("bash".into(), summarize(item.get("command")))),
        "fileChange" => Some(("edit".into(), summarize(item.get("changes")))),
        "mcpToolCall" => Some((
            item.get("server")
                .and_then(Value::as_str)
                .unwrap_or("mcp")
                .to_owned(),
            summarize(Some(item)),
        )),
        _ => None,
    }
}

fn tool_result_summary(item_type: &str, item: &Value) -> Option<(String, String, bool, bool)> {
    match item_type {
        "commandExecution" => Some((
            "bash".into(),
            summarize(
                item.get("aggregatedOutput")
                    .or_else(|| item.get("exitCode"))
                    .or_else(|| item.get("status")),
            ),
            item_failed(item),
            full_text_len(item) > 400,
        )),
        "fileChange" => Some((
            "edit".into(),
            summarize(item.get("status")),
            item_failed(item),
            false,
        )),
        "mcpToolCall" => Some((
            item.get("server")
                .and_then(Value::as_str)
                .unwrap_or("mcp")
                .to_owned(),
            summarize(
                item.get("error")
                    .or_else(|| item.get("result"))
                    .or_else(|| item.get("status")),
            ),
            item_failed(item),
            full_text_len(item) > 400,
        )),
        _ => None,
    }
}

fn receiver_thread_ids(item: &Value) -> Vec<String> {
    let mut out = Vec::new();
    for key in ["receiverThreadId", "agentThreadId", "threadId"] {
        if let Some(value) = item.get(key).and_then(Value::as_str)
            && !value.is_empty()
        {
            out.push(value.chars().take(120).collect());
        }
    }
    for key in ["receiverThreadIds", "agentThreadIds"] {
        if let Some(items) = item.get(key).and_then(Value::as_array) {
            out.extend(items.iter().filter_map(|value| {
                value
                    .as_str()
                    .filter(|id| !id.is_empty())
                    .map(|id| id.chars().take(120).collect::<String>())
            }));
        }
    }
    if let Some(states) = item.get("agentsStates").and_then(Value::as_object) {
        out.extend(
            states
                .keys()
                .map(|key| key.chars().take(120).collect::<String>()),
        );
    }
    out.sort();
    out.dedup();
    out
}

fn subagent_status(value: Option<&Value>) -> (&'static str, bool) {
    let status = value
        .and_then(|value| {
            value.as_str().or_else(|| {
                value
                    .as_object()
                    .and_then(|map| map.get("type"))
                    .and_then(Value::as_str)
            })
        })
        .unwrap_or_default();
    match status {
        "active" | "running" | "pendingInit" => ("running", true),
        "idle" => ("idle", true),
        "completed" => ("completed", false),
        "systemError" | "errored" | "notFound" => ("failed", false),
        "interrupted" | "shutdown" | "notLoaded" => ("stopped", false),
        _ => ("starting", true),
    }
}

fn codex_file_changes(item: &Value) -> Vec<crate::protocol::FileDiff> {
    item.get("changes")
        .and_then(Value::as_array)
        .map(|changes| {
            changes
                .iter()
                .filter_map(|change| {
                    let path = change.get("path")?.as_str()?;
                    let patch = change
                        .get("patch")
                        .or_else(|| change.get("unifiedDiff"))
                        .or_else(|| change.get("diff"))
                        .and_then(Value::as_str)?;
                    Some(from_unified_patch(path, patch))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn extract_diff(params: &Value) -> Option<crate::protocol::FileDiff> {
    let path = params
        .get("path")
        .or_else(|| params.get("file"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    if let Some(patch) = params
        .get("patch")
        .or_else(|| params.get("unifiedDiff"))
        .or_else(|| params.get("diff"))
        .and_then(Value::as_str)
        && !patch.is_empty()
    {
        return Some(from_unified_patch(path, patch));
    }
    let changes = params.get("changes")?.as_object()?;
    for (path, inner) in changes {
        let patch = inner
            .get("patch")
            .or_else(|| inner.get("unifiedDiff"))
            .or_else(|| inner.get("diff"))
            .and_then(Value::as_str);
        if let Some(patch) = patch
            && !patch.is_empty()
        {
            return Some(from_unified_patch(path, patch));
        }
    }
    None
}

fn codex_turn_diffs(patch: &str) -> Vec<crate::protocol::FileDiff> {
    let mut diffs = Vec::new();
    let mut current = String::new();
    for line in patch.lines() {
        if line.starts_with("diff --git ") && !current.is_empty() {
            if let Some(diff) = diff_from_section(&current) {
                diffs.push(diff);
            }
            current.clear();
        }
        current.push_str(line);
        current.push('\n');
    }
    if !current.is_empty()
        && let Some(diff) = diff_from_section(&current)
    {
        diffs.push(diff);
    }
    diffs
}

fn diff_from_section(section: &str) -> Option<crate::protocol::FileDiff> {
    let mut target = None;
    let mut binary_target = None;
    for line in section.lines() {
        if let Some(rest) = line.strip_prefix("+++ ")
            && rest != "/dev/null"
        {
            target = Some(diff_path(rest));
        } else if let Some(rest) = line.strip_prefix("--- ")
            && rest != "/dev/null"
            && target.is_none()
        {
            target = Some(diff_path(rest));
        } else if let Some(rest) = line.strip_prefix("diff --git ") {
            binary_target = rest.split_whitespace().last().map(diff_path);
        }
    }
    let path = target.or(binary_target)?.trim().to_owned();
    if path.is_empty() || path == "/dev/null" {
        None
    } else {
        Some(from_unified_patch(&path, section))
    }
}

fn diff_path(value: &str) -> String {
    value
        .split('\t')
        .next()
        .unwrap_or(value)
        .trim()
        .trim_matches('"')
        .trim_start_matches("a/")
        .trim_start_matches("b/")
        .to_owned()
}

fn from_unified_patch(path: &str, patch_text: &str) -> crate::protocol::FileDiff {
    const MAX_PATCH_CHARS: usize = 8000;
    let mut additions = 0_i64;
    let mut deletions = 0_i64;
    let mut lines = Vec::new();
    for line in patch_text.lines() {
        if line.starts_with("---")
            || line.starts_with("+++")
            || line.starts_with("diff ")
            || line.starts_with("index ")
        {
            continue;
        }
        if line.starts_with('+') {
            additions += 1;
        } else if line.starts_with('-') {
            deletions += 1;
        }
        lines.push(line);
    }
    let mut patch = lines.join("\n");
    let truncated = patch.len() > MAX_PATCH_CHARS;
    if truncated {
        patch.truncate(MAX_PATCH_CHARS);
    }
    crate::protocol::FileDiff {
        path: path.chars().take(4096).collect(),
        patch,
        additions,
        deletions,
        truncated,
    }
}

fn full_text_len(item: &Value) -> usize {
    item.get("output")
        .or_else(|| item.get("aggregatedOutput"))
        .or_else(|| item.get("result"))
        .map(|value| match value {
            Value::String(text) => text.len(),
            value => serde_json::to_string(value).unwrap_or_default().len(),
        })
        .unwrap_or(0)
}

fn item_failed(item: &Value) -> bool {
    matches!(
        item.get("status").and_then(Value::as_str),
        Some("failed" | "error" | "declined" | "cancelled" | "canceled")
    ) || item.get("error").is_some_and(|error| !error.is_null())
}

fn summarize(value: Option<&Value>) -> String {
    let text = match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| summarize(Some(item)))
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join(" "),
        Some(Value::Null) | None => String::new(),
        Some(value) => serde_json::to_string(value).unwrap_or_default(),
    };
    let text = text.trim();
    if text.is_empty() {
        "操作".into()
    } else {
        text.chars().take(400).collect()
    }
}

async fn codex_item_id(params: &Value, current_turn: &Arc<Mutex<Option<String>>>) -> String {
    params
        .get("itemId")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| futures_current_turn(current_turn))
        .unwrap_or_else(|| "codex-message".into())
}

fn futures_current_turn(current_turn: &Arc<Mutex<Option<String>>>) -> Option<String> {
    current_turn.try_lock().ok().and_then(|guard| guard.clone())
}

fn history_events(thread: &serde_json::Map<String, Value>, subagent_id: &str) -> Vec<Value> {
    let mut events = Vec::new();
    let turns = thread
        .get("turns")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for turn_value in turns {
        let Some(turn) = turn_value.as_object() else {
            continue;
        };
        let turn_id = turn
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| format!("turn-{}", events.len()));
        let mut last_message_id = turn_id.clone();
        let mut final_message_id = None;
        let mut diffs: HashMap<String, crate::protocol::FileDiff> = HashMap::new();
        let items = turn
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for item_value in items {
            let Some(item) = item_value.as_object() else {
                continue;
            };
            let item_id = item
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| format!("{}-{}", turn_id, events.len()));
            events.extend(history_item_events(item, &item_id, &turn_id, subagent_id));
            let typ = item.get("type").and_then(Value::as_str).unwrap_or_default();
            if typ == "agentMessage" || typ == "plan" {
                last_message_id = item_id.clone();
                if item.get("phase").and_then(Value::as_str) == Some("final_answer")
                    || typ == "plan"
                {
                    final_message_id = Some(item_id.clone());
                }
            }
            if typ == "fileChange"
                && item.get("status").and_then(Value::as_str) == Some("completed")
            {
                for diff in codex_file_changes(&Value::Object(item.clone())) {
                    diffs.insert(diff.path.clone(), diff);
                }
            }
        }
        let status = turn
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("completed");
        if status == "failed" && turn.get("error").is_some_and(|error| !error.is_null()) {
            events.push(json!({
                "kind": "agent.error",
                "message": summarize(turn.get("error")),
                "agentId": subagent_id,
            }));
        }
        if status != "inProgress" {
            let mut end = serde_json::Map::new();
            end.insert("kind".into(), json!("turn.end"));
            end.insert(
                "msgId".into(),
                json!(final_message_id.unwrap_or(last_message_id)),
            );
            end.insert("turnId".into(), json!(turn_id));
            end.insert("finish".into(), json!(status));
            end.insert("agentId".into(), json!(subagent_id));
            if !diffs.is_empty() {
                end.insert(
                    "diffs".into(),
                    serde_json::to_value(diffs.into_values().collect::<Vec<_>>())
                        .unwrap_or_else(|_| json!([])),
                );
            }
            events.push(Value::Object(end));
        }
    }
    events
}

fn history_item_events(
    item: &serde_json::Map<String, Value>,
    item_id: &str,
    turn_id: &str,
    subagent_id: &str,
) -> Vec<Value> {
    let typ = item.get("type").and_then(Value::as_str).unwrap_or_default();
    match typ {
        "userMessage" => {
            let text = history_user_content(item.get("content"));
            if text.is_empty() {
                Vec::new()
            } else {
                vec![
                    json!({ "kind": "user.message", "msgId": item_id, "text": text, "agentId": subagent_id }),
                ]
            }
        }
        "agentMessage" | "plan" => item
            .get("text")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(|text| {
                let mut event = serde_json::Map::new();
                event.insert("kind".into(), json!("assistant.text"));
                event.insert("msgId".into(), json!(item_id));
                event.insert("text".into(), json!(text));
                event.insert("agentId".into(), json!(subagent_id));
                if let Some(phase) = item.get("phase").and_then(Value::as_str) {
                    if phase == "commentary" || phase == "final_answer" {
                        event.insert("phase".into(), json!(phase));
                    }
                } else if typ == "plan" {
                    event.insert("phase".into(), json!("final_answer"));
                }
                vec![Value::Object(event)]
            })
            .unwrap_or_default(),
        "reasoning" => {
            let text = [item.get("summary"), item.get("content")]
                .into_iter()
                .flatten()
                .flat_map(|value| value.as_array().into_iter().flatten())
                .filter_map(Value::as_str)
                .filter(|text| !text.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
            if text.trim().is_empty() {
                Vec::new()
            } else {
                vec![
                    json!({ "kind": "reasoning", "msgId": item_id, "text": text, "agentId": subagent_id }),
                ]
            }
        }
        "commandExecution" => history_tool_events(HistoryTool {
            item,
            item_id,
            turn_id,
            subagent_id,
            tool: "bash".into(),
            input: summarize(item.get("command")),
            output: summarize(
                item.get("aggregatedOutput")
                    .or_else(|| item.get("exitCode"))
                    .or_else(|| item.get("status")),
            ),
            diff: None,
        }),
        "fileChange" => {
            let changes = item
                .get("changes")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let paths = changes
                .iter()
                .filter_map(|change| change.get("path").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join(", ");
            let diff = codex_file_changes(&Value::Object(item.clone()))
                .into_iter()
                .next();
            history_tool_events(HistoryTool {
                item,
                item_id,
                turn_id,
                subagent_id,
                tool: "edit".into(),
                input: if paths.is_empty() {
                    summarize(item.get("changes"))
                } else {
                    paths
                },
                output: summarize(item.get("status")),
                diff,
            })
        }
        "mcpToolCall" => {
            let server = item.get("server").and_then(Value::as_str).unwrap_or("mcp");
            let tool = item.get("tool").and_then(Value::as_str).unwrap_or("tool");
            history_tool_events(HistoryTool {
                item,
                item_id,
                turn_id,
                subagent_id,
                tool: format!("{server}.{tool}"),
                input: summarize(item.get("arguments")),
                output: summarize(
                    item.get("error")
                        .or_else(|| item.get("result"))
                        .or_else(|| item.get("status")),
                ),
                diff: None,
            })
        }
        "dynamicToolCall" => {
            let namespace = item
                .get("namespace")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(|value| format!("{value}."))
                .unwrap_or_default();
            let tool = item.get("tool").and_then(Value::as_str).unwrap_or("tool");
            history_tool_events(HistoryTool {
                item,
                item_id,
                turn_id,
                subagent_id,
                tool: format!("{namespace}{tool}"),
                input: summarize(item.get("arguments")),
                output: summarize(
                    item.get("contentItems")
                        .or_else(|| item.get("success"))
                        .or_else(|| item.get("status")),
                ),
                diff: None,
            })
        }
        "collabAgentToolCall" => history_tool_events(HistoryTool {
            item,
            item_id,
            turn_id,
            subagent_id,
            tool: format!(
                "agent.{}",
                item.get("tool")
                    .and_then(Value::as_str)
                    .unwrap_or("collaborate")
            ),
            input: summarize(item.get("prompt").or_else(|| item.get("receiverThreadIds"))),
            output: summarize(item.get("agentsStates").or_else(|| item.get("status"))),
            diff: None,
        }),
        "webSearch" => history_tool_events(HistoryTool {
            item,
            item_id,
            turn_id,
            subagent_id,
            tool: "web.search".into(),
            input: summarize(item.get("query").or_else(|| item.get("action"))),
            output: {
                let action = summarize(item.get("action"));
                if action.trim().is_empty() {
                    "completed".into()
                } else {
                    action
                }
            },
            diff: None,
        }),
        "subAgentActivity" | "imageView" | "imageGeneration" => history_tool_events(HistoryTool {
            item,
            item_id,
            turn_id,
            subagent_id,
            tool: if typ == "subAgentActivity" {
                "agent.activity".into()
            } else {
                typ.into()
            },
            input: item
                .get("agentThreadId")
                .or_else(|| item.get("path"))
                .map(|value| summarize(Some(value)))
                .unwrap_or_else(|| serde_json::to_string(item).unwrap_or_default()),
            output: {
                let kind = summarize(item.get("kind"));
                if kind.trim().is_empty() {
                    "completed".into()
                } else {
                    kind
                }
            },
            diff: None,
        }),
        _ => Vec::new(),
    }
}

struct HistoryTool<'a> {
    item: &'a serde_json::Map<String, Value>,
    item_id: &'a str,
    turn_id: &'a str,
    subagent_id: &'a str,
    tool: String,
    input: String,
    output: String,
    diff: Option<crate::protocol::FileDiff>,
}

fn history_tool_events(input: HistoryTool<'_>) -> Vec<Value> {
    let summary = input.input;
    let mut start = serde_json::Map::new();
    start.insert("kind".into(), json!("tool.start"));
    start.insert("msgId".into(), json!(input.turn_id));
    start.insert("callId".into(), json!(input.item_id));
    start.insert("tool".into(), json!(input.tool));
    start.insert(
        "summary".into(),
        json!(if summary.is_empty() {
            input.tool.clone()
        } else {
            summary
        }),
    );
    start.insert("agentId".into(), json!(input.subagent_id));
    if let Some(diff) = input.diff.clone() {
        start.insert(
            "diff".into(),
            serde_json::to_value(diff).unwrap_or_else(|_| json!({})),
        );
    }
    let mut events = vec![Value::Object(start)];
    let status = input
        .item
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("completed");
    if status == "inProgress" || status == "running" {
        return events;
    }
    let failed = matches!(status, "failed" | "declined" | "error");
    let mut end = serde_json::Map::new();
    end.insert("kind".into(), json!("tool.end"));
    end.insert("callId".into(), json!(input.item_id));
    end.insert(
        "state".into(),
        json!(if failed { "failed" } else { "success" }),
    );
    let output = input.output;
    end.insert(
        "summary".into(),
        json!(if output.is_empty() {
            status.into()
        } else {
            output
        }),
    );
    end.insert("agentId".into(), json!(input.subagent_id));
    if let Some(diff) = input.diff {
        end.insert(
            "diff".into(),
            serde_json::to_value(diff).unwrap_or_else(|_| json!({})),
        );
    }
    events.push(Value::Object(end));
    events
}

fn history_user_content(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|input| {
                    let typ = input.get("type").and_then(Value::as_str)?;
                    match typ {
                        "text" => input.get("text").and_then(Value::as_str).map(str::to_owned),
                        "skill" => input
                            .get("name")
                            .and_then(Value::as_str)
                            .map(|name| format!("${name}")),
                        "mention" => input
                            .get("name")
                            .and_then(Value::as_str)
                            .map(|name| format!("@{name}")),
                        "image" | "localImage" => input
                            .get("url")
                            .or_else(|| input.get("path"))
                            .and_then(Value::as_str)
                            .map(|path| format!("[图片] {path}")),
                        _ => None,
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
        .trim()
        .to_owned()
}

impl CodexTurn {
    pub(super) fn take_events(&mut self) -> Option<mpsc::Receiver<AdapterEvent>> {
        self.events.take()
    }

    pub(super) async fn steer(&self, text: &str) -> Result<()> {
        let Some(turn_id) = self.current_turn.lock().await.clone() else {
            return Err(Error::Conflict);
        };
        self.send_request(
            "turn/steer",
            json!({
                "threadId": self.thread_id,
                "expectedTurnId": turn_id,
                "input": [{ "type": "text", "text": text, "text_elements": [] }],
            }),
        )
        .await
    }

    pub(super) async fn send_to_subagent(&self, subagent_id: &str, text: &str) -> Result<()> {
        let input = json!([{ "type": "text", "text": text, "text_elements": [] }]);
        if let Some(turn_id) = self.current_turns.lock().await.get(subagent_id).cloned() {
            let steer = self
                .send_request_value(
                    "turn/steer",
                    json!({
                        "threadId": subagent_id,
                        "expectedTurnId": turn_id,
                        "input": input.clone(),
                    }),
                )
                .await;
            if steer.is_ok() {
                return Ok(());
            }
            self.current_turns.lock().await.remove(subagent_id);
        }
        let mut params = serde_json::Map::new();
        params.insert("threadId".into(), json!(subagent_id));
        params.insert("input".into(), input);
        params.insert("approvalPolicy".into(), self.approval_policy.clone());
        params.insert("sandboxPolicy".into(), self.sandbox_policy.clone());
        if let Some(model) = self.model.as_ref() {
            params.insert("model".into(), json!(model));
            params.insert(
                "collaborationMode".into(),
                json!({
                    "mode": if self.mode == PermissionMode::Plan { "plan" } else { "default" },
                    "settings": {
                        "model": model,
                        "reasoning_effort": self.effort,
                        "developer_instructions": null,
                    }
                }),
            );
        }
        if let Some(effort) = self.effort.as_ref() {
            params.insert("effort".into(), json!(effort));
        }
        self.send_request("turn/start", Value::Object(params)).await
    }

    pub(super) async fn read_subagent_history(
        &self,
        subagent_id: &str,
    ) -> Result<Option<Vec<Value>>> {
        let raw = self
            .send_request_value(
                "thread/read",
                json!({ "threadId": subagent_id, "includeTurns": true }),
            )
            .await?;
        let Some(thread) = raw.get("thread").and_then(Value::as_object) else {
            return Ok(None);
        };
        if thread.get("id").and_then(Value::as_str) != Some(subagent_id)
            || thread.get("parentThreadId").and_then(Value::as_str) != Some(self.thread_id.as_str())
        {
            return Err(Error::Invalid("Codex 返回的线程不属于当前父会话".into()));
        }
        Ok(Some(history_events(thread, subagent_id)))
    }

    pub(super) async fn compact(&self) -> Result<()> {
        self.send_request(
            "thread/compact/start",
            json!({ "threadId": self.thread_id }),
        )
        .await
    }

    pub(super) async fn apply_selection(&self, model: &str, effort: Option<&str>) -> Result<()> {
        self.send_request(
            "thread/settings/update",
            json!({
                "threadId": self.thread_id,
                "collaborationMode": {
                    "mode": "default",
                    "settings": {
                        "model": model,
                        "reasoning_effort": effort,
                        "developer_instructions": null,
                    }
                }
            }),
        )
        .await
    }

    async fn send_request(&self, method: &str, params: Value) -> Result<()> {
        let (ack, ack_rx) = oneshot::channel();
        self.stdin
            .send((
                json!({
                    "jsonrpc": "2.0",
                    "id": uuid::Uuid::new_v4().as_u128().to_string(),
                    "method": method,
                    "params": params,
                }),
                Some(ack),
            ))
            .await
            .map_err(|_| Error::Closed)?;
        tokio::time::timeout(CONTROL_TIMEOUT, ack_rx)
            .await
            .map_err(|_| Error::Timeout)?
            .map_err(|_| Error::Closed)
    }

    async fn send_request_value(&self, method: &str, params: Value) -> Result<Value> {
        let id = uuid::Uuid::new_v4().as_u128().to_string();
        let (reply_tx, reply_rx) = oneshot::channel();
        self.responses.lock().await.insert(id.clone(), reply_tx);
        let (ack, ack_rx) = oneshot::channel();
        let send_result = self
            .stdin
            .send((
                json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "method": method,
                    "params": params,
                }),
                Some(ack),
            ))
            .await;
        if send_result.is_err() {
            self.responses.lock().await.remove(&id);
            return Err(Error::Closed);
        }
        match tokio::time::timeout(CONTROL_TIMEOUT, ack_rx).await {
            Ok(Ok(())) => {}
            Ok(Err(_)) => {
                self.responses.lock().await.remove(&id);
                return Err(Error::Closed);
            }
            Err(_) => {
                self.responses.lock().await.remove(&id);
                return Err(Error::Timeout);
            }
        }
        let result = match tokio::time::timeout(CONTROL_TIMEOUT, reply_rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => return Err(Error::Closed),
            Err(_) => {
                self.responses.lock().await.remove(&id);
                return Err(Error::Timeout);
            }
        };
        result.map_err(Error::Invalid)
    }

    pub(super) fn kill(&self) {
        kill_process_group(self.child_pid);
    }
}
