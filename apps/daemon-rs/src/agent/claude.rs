//! Direct Claude Code CLI driver.
//!
//! The CLI is spawned per turn in headless stream-json mode: prompts go to
//! stdin as JSONL user messages, normalized events come back on stdout.
//! Approvals use `--permission-prompt-tool stdio`: the CLI emits a
//! `control_request` and blocks until we answer on stdin. Multi-turn
//! conversations resume the native session id with `--resume`.

use std::collections::HashMap;
use std::process::Stdio;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};

use super::store::ApprovalPolicy;
use crate::error::{Error, Result};

/// Semantic events normalized from the CLI JSONL stream.
pub(super) enum AdapterEvent {
    NativeId(String),
    Text(String),
    Thinking(String),
    ToolCall {
        call_id: String,
        name: String,
        summary: String,
    },
    ToolResult {
        call_id: String,
        name: String,
        summary: String,
        error: bool,
    },
    Permission {
        request_id: String,
        tool: String,
        summary: String,
        reply: oneshot::Sender<bool>,
    },
    Finish {
        interrupted: bool,
        error: Option<String>,
    },
}

pub(super) struct ClaudeTurn {
    stdin: mpsc::Sender<String>,
    events: Option<mpsc::Receiver<AdapterEvent>>,
    child_pid: u32,
    kill: Box<dyn Fn() + Send + Sync>,
}

fn binary() -> String {
    std::env::var("PROSPERO_CLAUDE_BIN").unwrap_or_else(|_| "claude".into())
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

pub(super) fn spawn_turn(
    workspace: &str,
    prompt: &str,
    native_id: Option<&str>,
    policy: ApprovalPolicy,
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
    if let Some(id) = native_id {
        command.arg(format!("--resume={id}"));
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
    let mut child: Child = command.spawn()?;
    let child_pid = child.id().ok_or(Error::Closed)?;
    let mut stdin = child.stdin.take().ok_or(Error::Closed)?;
    let stdout = child.stdout.take().ok_or(Error::Closed)?;

    let (frames_tx, mut frames_rx) = mpsc::channel::<String>(32);
    let (events_tx, events_rx) = mpsc::channel::<AdapterEvent>(64);

    // Serialize stdin writes (prompts and permission responses).
    tokio::spawn(async move {
        while let Some(frame) = frames_rx.recv().await {
            if stdin.write_all(frame.as_bytes()).await.is_err()
                || stdin.write_all(b"\n").await.is_err()
            {
                break;
            }
            let _ = stdin.flush().await;
        }
    });

    // Channel the opening prompt once both tasks are running.
    let initial =
        serde_json::json!({"type":"user","message":{"role":"user","content":prompt}}).to_string();
    let prompt_writer = frames_tx.clone();
    tokio::spawn(async move {
        let _ = prompt_writer.send(initial).await;
    });

    // Read and translate the JSONL stream.
    let auto = policy == ApprovalPolicy::Auto;
    let reader_writer = frames_tx.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        let mut translator = Translator::default();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            for outgoing in translator.feed(message, auto, &reader_writer) {
                if events_tx.send(outgoing).await.is_err() {
                    return;
                }
            }
            if translator.finished {
                // The CLI delivered its result but would otherwise stay alive
                // waiting for another prompt on stdin; end the process group
                // (multi-turn conversations resume via --resume).
                kill_process_group(child_pid);
                break;
            }
        }
        let _ = child.wait().await;
        events_tx
            .send(AdapterEvent::Finish {
                interrupted: translator.interrupted,
                error: if translator.aborted {
                    None
                } else {
                    translator.error
                },
            })
            .await
            .ok();
    });

    let kill_group = { Box::new(move || kill_process_group(child_pid)) };

    Ok(ClaudeTurn {
        stdin: frames_tx,
        events: Some(events_rx),
        child_pid,
        kill: kill_group,
    })
}

impl ClaudeTurn {
    pub(super) fn take_events(&mut self) -> Option<mpsc::Receiver<AdapterEvent>> {
        self.events.take()
    }

    pub(super) fn interrupt(&self) {
        let frame = serde_json::json!({
            "type": "control_request",
            "request_id": uuid::Uuid::new_v4().to_string(),
            "request": {"subtype": "interrupt"}
        })
        .to_string();
        let _ = self.stdin.try_send(frame);
    }

    pub(super) fn kill(&self) {
        (self.kill)();
    }

    #[allow(dead_code)]
    pub(super) fn pid(&self) -> u32 {
        self.child_pid
    }
}

#[derive(Default)]
struct Translator {
    native_id: Option<String>,
    blocks: HashMap<u32, String>,
    tool_names: HashMap<String, String>,
    interrupted: bool,
    aborted: bool,
    error: Option<String>,
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

impl Translator {
    /// Translate one CLI frame into zero or more normalized events.
    fn feed(
        &mut self,
        message: Value,
        auto: bool,
        writer: &mpsc::Sender<String>,
    ) -> Vec<AdapterEvent> {
        let mut out = Vec::new();
        match message.get("type").and_then(Value::as_str) {
            Some("system")
                if message.get("subtype").and_then(Value::as_str) == Some("init")
                    && self.native_id.is_none() =>
            {
                if let Some(id) = message.get("session_id").and_then(Value::as_str) {
                    self.native_id = Some(id.to_owned());
                    out.push(AdapterEvent::NativeId(id.to_owned()));
                }
            }
            Some("stream_event") => {
                if let Some(event) = message.get("event") {
                    self.translate_stream(event, &mut out);
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
                            let summary = block.get("input").map(tool_summary).unwrap_or_default();
                            out.push(AdapterEvent::ToolCall {
                                call_id: call_id.to_owned(),
                                name,
                                summary,
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
                            out.push(AdapterEvent::ToolResult {
                                name: self
                                    .tool_names
                                    .get(&call_id)
                                    .cloned()
                                    .unwrap_or_else(|| "tool".into()),
                                call_id,
                                summary,
                                error,
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
                    let summary = request.get("input").map(tool_summary).unwrap_or_default();
                    if auto {
                        let input = request.get("input").cloned().unwrap_or(Value::Null);
                        let frame = serde_json::json!({
                            "type":"control_response",
                            "response":{"subtype":"success","request_id":request_id,
                                "response":{"behavior":"allow","updatedInput":input}}
                        })
                        .to_string();
                        let _ = writer.try_send(frame);
                    } else {
                        let (reply, receiver) = oneshot::channel();
                        let writer = writer.clone();
                        let rid = request_id.clone();
                        tokio::spawn(async move {
                            let allow = receiver.await.unwrap_or(false);
                            // The CLI requires a deny response to carry a
                            // `message`; a bare deny is rejected as an invalid
                            // callback result and the model retries the tool.
                            let response = if allow {
                                serde_json::json!({"behavior":"allow"})
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
                            let _ = writer.send(frame).await;
                        });
                        out.push(AdapterEvent::Permission {
                            request_id,
                            tool,
                            summary,
                            reply,
                        });
                    }
                }
            }
            Some("result") => {
                self.finished = true;
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
            }
            _ => {}
        }
        out
    }

    fn translate_stream(&mut self, event: &Value, out: &mut Vec<AdapterEvent>) {
        let index = event.get("index").and_then(Value::as_u64).unwrap_or(0) as u32;
        match event.get("type").and_then(Value::as_str) {
            Some("content_block_start") => {
                self.blocks.insert(index, String::new());
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
                    if text.starts_with("thinking:") {
                        text.drain(.."thinking:".len());
                        if !text.trim().is_empty() {
                            out.push(AdapterEvent::Thinking(text));
                        }
                    } else if !text.trim().is_empty() {
                        out.push(AdapterEvent::Text(text));
                    }
                }
            }
            _ => {}
        }
    }
}
