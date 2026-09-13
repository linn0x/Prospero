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

use super::claude::{AdapterEvent, TurnOptions};
use super::store::{ApprovalPolicy, PermissionMode};
use crate::error::{Error, Result};

const START_TIMEOUT: Duration = Duration::from_secs(30);
const CONTROL_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_LINE_BYTES: usize = 4 * 1024 * 1024;

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
    child_pid: u32,
}

struct StartingRpc {
    child: Child,
    stdin: tokio::process::ChildStdin,
    stdout: BufReader<tokio::process::ChildStdout>,
    next_id: u64,
}

impl StartingRpc {
    async fn start(workspace: &str, environment: &[(String, String)]) -> Result<Self> {
        let mut command = Command::new(binary());
        command
            .arg("app-server")
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
    if !options.environment.is_empty() {
        return Err(Error::Invalid(
            "Rust Codex structured runtime 当前仅支持本机 Codex 账号".into(),
        ));
    }
    let (_home, environment) = super::usage::native_codex_environment(data)?;
    let mut rpc = StartingRpc::start(workspace, &environment).await?;
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
    let _ = events_tx.try_send(AdapterEvent::NativeId(thread_id.clone()));
    let current_turn = Arc::new(Mutex::new(None));

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
    tokio::spawn(async move {
        read_notifications(rpc.stdout, events_tx, reader_current_turn).await;
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
    turn_params.insert("approvalPolicy".into(), policy.approval_policy_for_turn);
    turn_params.insert("sandboxPolicy".into(), policy.sandbox_policy);
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
        child_pid,
    })
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
    current_turn: Arc<Mutex<Option<String>>>,
) {
    let mut streamed: HashMap<String, String> = HashMap::new();
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
                })
                .await;
            sent_finish = true;
            break;
        }
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
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
                })
                .await;
            sent_finish = true;
            break;
        }
        let Some(method) = message.get("method").and_then(Value::as_str) else {
            continue;
        };
        let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
        match method {
            "turn/started" => {
                let turn_id = params
                    .get("turn")
                    .and_then(|turn| turn.get("id"))
                    .or_else(|| params.get("turnId"))
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                *current_turn.lock().await = turn_id;
                last_text = None;
                streamed.clear();
            }
            "item/agentMessage/delta" | "item/plan/delta" => {
                if let Some(delta) = params.get("delta").and_then(Value::as_str)
                    && !delta.is_empty()
                {
                    let msg_id = codex_item_id(&params, &current_turn).await;
                    last_text = Some(msg_id.clone());
                    let full = streamed.entry(msg_id.clone()).or_default();
                    full.push_str(delta);
                    let _ = events
                        .send(AdapterEvent::Text {
                            subagent: None,
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
                            subagent: None,
                            text: delta.to_owned(),
                        })
                        .await;
                }
            }
            "item/completed" => {
                let item = params.get("item").cloned().unwrap_or_else(|| json!({}));
                let item_type = item
                    .get("type")
                    .or_else(|| item.get("item_type"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
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
                                    subagent: None,
                                    text: text.to_owned(),
                                })
                                .await;
                        }
                    }
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
                let turn = params.get("turn").cloned().unwrap_or_else(|| json!({}));
                let status = turn
                    .get("status")
                    .or_else(|| params.get("status"))
                    .and_then(Value::as_str)
                    .unwrap_or("completed");
                let failed = matches!(status, "failed" | "error");
                let interrupted = matches!(status, "cancelled" | "canceled" | "interrupted");
                let _ = events
                    .send(AdapterEvent::Finish {
                        interrupted,
                        error: failed.then(|| format!("Codex turn {status}")),
                        cost_usd: None,
                        input_tokens: last_input_tokens,
                        output_tokens: last_output_tokens,
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
            })
            .await;
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

    pub(super) fn kill(&self) {
        kill_process_group(self.child_pid);
    }
}
