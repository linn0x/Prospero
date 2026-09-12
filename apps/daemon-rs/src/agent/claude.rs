//! Direct Claude Code CLI driver.
//!
//! The CLI is spawned per turn in headless stream-json mode: prompts go to
//! stdin as JSONL user messages, normalized events come back on stdout.
//! Approvals use `--permission-prompt-tool stdio`: the CLI emits a
//! `control_request` and blocks until we answer on stdin. Multi-turn
//! conversations resume the native session id with `--resume`.

use std::collections::{HashMap, HashSet};
use std::process::Stdio;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};

use super::store::{ApprovalPolicy, PermissionMode};
use crate::error::{Error, Result};

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
    },
    ToolResult {
        subagent: Option<String>,
        call_id: String,
        name: String,
        summary: String,
        error: bool,
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
    mode: PermissionMode,
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
    if mode == PermissionMode::Plan {
        // Plan mode: the CLI investigates and plans but does not apply edits.
        command.args(["--permission-mode", "plan"]);
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
    /// Content blocks streamed by a Task-tool subagent (`stream_event` frames
    /// only carry the block index; ownership comes from the parent id).
    block_owners: HashMap<u32, String>,
    tool_names: HashMap<String, String>,
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
        writer: &mpsc::Sender<String>,
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
                            let summary = block.get("input").map(tool_summary).unwrap_or_default();
                            out.push(AdapterEvent::ToolCall {
                                subagent: agent.clone(),
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
                                subagent: agent.clone(),
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
                    let input = request.get("input").cloned().unwrap_or(Value::Null);
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

    /// Normalize an AskUserQuestion tool request and block the CLI on a
    /// oneshot until the user answers (mirrors the legacy adapter's
    /// `requestUserQuestion`).
    fn translate_question(
        &mut self,
        out: &mut Vec<AdapterEvent>,
        writer: &mpsc::Sender<String>,
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
            let _ = writer.try_send(frame);
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
            let _ = writer.send(frame).await;
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
