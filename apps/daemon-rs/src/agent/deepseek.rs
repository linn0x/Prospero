use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use futures_util::StreamExt;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

use super::claude::{AdapterEvent, QuestionOptionSpec, QuestionSpec, TurnOptions};
use super::{AgentModelCatalog, AgentPresetInfo, LaunchModelCatalog, LaunchModelInfo};
use crate::error::{Error, Result};

const START_TIMEOUT: Duration = Duration::from_secs(30);
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_EVENT_BYTES: usize = 4 * 1024 * 1024;

pub(super) struct DeepseekTurn {
    client: reqwest::Client,
    base_url: String,
    events: Option<mpsc::Receiver<AdapterEvent>>,
    control_events: mpsc::Sender<AdapterEvent>,
    session_id: String,
    current_model: Option<String>,
    current_effort: Option<String>,
    child_pid: u32,
}

struct EventLoop {
    url: String,
    session_id: String,
    events: mpsc::Sender<AdapterEvent>,
    client: reqwest::Client,
    base_url: String,
    auto: bool,
    ready: oneshot::Sender<Result<()>>,
    child: Child,
}

fn binary() -> String {
    std::env::var("PROSPERO_DEEPSEEK_BIN").unwrap_or_else(|_| "dsh".into())
}

fn summarize(value: impl Into<Value>) -> String {
    let value = value.into();
    let mut text = match value {
        Value::String(text) => text,
        other => serde_json::to_string(&other).unwrap_or_default(),
    };
    text.retain(|c| c != '\u{0}' && (c == '\n' || c == '\t' || !c.is_control()));
    if text.len() > 2000 {
        let mut end = 2000;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }
    text
}

fn record(value: &Value) -> &serde_json::Map<String, Value> {
    value.as_object().unwrap_or_else(|| {
        static EMPTY: std::sync::OnceLock<serde_json::Map<String, Value>> =
            std::sync::OnceLock::new();
        EMPTY.get_or_init(serde_json::Map::new)
    })
}

fn finite(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
        .or_else(|| value.as_f64().map(|value| value.round() as i64))
        .filter(|value| *value >= 0)
}

fn safe_id(value: &str, fallback: &str) -> String {
    let mut out: String = value
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(120)
        .collect();
    if out.is_empty() {
        out.push_str(fallback);
    }
    out
}

fn clean_text(value: &str, maximum: usize) -> String {
    let mut out = value
        .chars()
        .filter(|c| *c == '\n' || *c == '\t' || !c.is_control())
        .collect::<String>();
    if out.len() > maximum {
        let mut end = maximum;
        while !out.is_char_boundary(end) {
            end -= 1;
        }
        out.truncate(end);
    }
    out
}

async fn start_process(workspace: &str, environment: &[(String, String)]) -> Result<(Child, u16)> {
    let mut command = Command::new(binary());
    command
        .args(["web", "--host", "127.0.0.1", "--port", "0"])
        .current_dir(workspace)
        .stdin(Stdio::null())
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
            Error::Feature("agent_unavailable".into(), "未安装 dsh".into())
        } else {
            Error::Io(error)
        }
    })?;
    let stdout = child.stdout.take().ok_or(Error::Closed)?;
    let stderr = child.stderr.take().ok_or(Error::Closed)?;
    let (ports_tx, mut ports_rx) = mpsc::unbounded_channel();
    tokio::spawn(drain_deepseek_output(
        BufReader::new(stdout),
        ports_tx.clone(),
    ));
    tokio::spawn(drain_deepseek_output(BufReader::new(stderr), ports_tx));
    let port = tokio::time::timeout(START_TIMEOUT, async {
        tokio::select! {
            port = ports_rx.recv() => port.ok_or(Error::Closed),
            status = child.wait() => Err(Error::Invalid(format!("dsh web 启动时退出: {:?}", status.ok()))),
        }
    })
    .await
    .map_err(|_| Error::Timeout)??;
    Ok((child, port))
}

async fn drain_deepseek_output<R>(mut reader: BufReader<R>, ports: mpsc::UnboundedSender<u16>)
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut output = String::new();
    let mut sent = false;
    loop {
        let mut line = String::new();
        let Ok(n) = reader.read_line(&mut line).await else {
            return;
        };
        if n == 0 {
            return;
        }
        output.push_str(&line);
        if output.len() > 8000 {
            let drain = output.len() - 8000;
            output.drain(..drain);
        }
        if !sent && let Some(port) = parse_port(&output) {
            let _ = ports.send(port);
            sent = true;
        }
    }
}

fn parse_port(output: &str) -> Option<u16> {
    let marker = "dsh web:";
    let index = output.to_ascii_lowercase().find(marker)?;
    let rest = output[index + marker.len()..].trim_start();
    let rest = rest.strip_prefix("http://127.0.0.1:")?;
    let digits = rest
        .chars()
        .take_while(|value| value.is_ascii_digit())
        .collect::<String>();
    digits.parse().ok()
}

async fn call_rpc<T: serde::de::DeserializeOwned>(
    client: &reqwest::Client,
    base_url: &str,
    method: &str,
    payload: Value,
) -> Result<T> {
    let rpc_id = uuid::Uuid::new_v4().to_string();
    let response = client
        .post(format!("{base_url}/api/{method}"))
        .json(&json!({"type":"client-request","rpcId":rpc_id,"method":method,"payload":payload}))
        .timeout(HTTP_TIMEOUT)
        .send()
        .await
        .map_err(|error| Error::Invalid(format!("DeepSeek Harness HTTP failed: {error}")))?;
    if !response.status().is_success() {
        return Err(Error::Invalid(format!(
            "DeepSeek Harness HTTP {}",
            response.status()
        )));
    }
    let envelope = response
        .json::<Value>()
        .await
        .map_err(|error| Error::Invalid(format!("DeepSeek Harness response invalid: {error}")))?;
    if envelope.get("type").and_then(Value::as_str) != Some("server-response")
        || envelope.get("rpcId").and_then(Value::as_str) != Some(rpc_id.as_str())
    {
        return Err(Error::Invalid(
            "DeepSeek Harness 返回了无效 RPC 响应".into(),
        ));
    }
    let result = envelope.get("result").cloned().unwrap_or_else(|| json!({}));
    if result.get("ok").and_then(Value::as_bool) != Some(true) {
        let message = result
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("未知错误");
        return Err(Error::Invalid(format!(
            "DeepSeek Harness {method} 失败: {message}"
        )));
    }
    serde_json::from_value(result.get("value").cloned().unwrap_or(Value::Null))
        .map_err(|_| Error::Invalid(format!("DeepSeek Harness {method} 响应无效")))
}

async fn respond_rpc(client: &reqwest::Client, base_url: &str, rpc_id: String, result: Value) {
    let _ = client
        .post(format!("{base_url}/api/respond"))
        .json(&json!({"type":"client-response","rpcId":rpc_id,"result":result}))
        .timeout(HTTP_TIMEOUT)
        .send()
        .await;
}

async fn wait_ready(client: &reqwest::Client, base_url: &str) -> Result<()> {
    let deadline = tokio::time::Instant::now() + START_TIMEOUT;
    loop {
        match call_rpc::<Value>(client, base_url, "host.describe", json!({})).await {
            Ok(_) => return Ok(()),
            Err(error) if tokio::time::Instant::now() < deadline => {
                let _ = error;
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            Err(error) => return Err(Error::Invalid(format!("dsh web RPC 未就绪: {error}"))),
        }
    }
}

pub(super) async fn spawn_turn(
    workspace: &str,
    prompt: &str,
    attachments: &[crate::agent::AttachmentInput],
    native_id: Option<&str>,
    options: &TurnOptions,
) -> Result<DeepseekTurn> {
    let (mut child, port) = start_process(workspace, &options.environment).await?;
    let child_pid = child.id().ok_or(Error::Closed)?;
    let client = reqwest::Client::new();
    let base_url = format!("http://127.0.0.1:{port}");
    if let Err(error) = wait_ready(&client, &base_url).await {
        kill_process_group(child_pid);
        let _ = child.start_kill();
        let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
        return Err(error);
    }
    let mut create = serde_json::Map::new();
    create.insert("cwd".into(), json!(workspace));
    if let Some(session_id) = native_id {
        create.insert("sessionId".into(), json!(session_id));
    } else if let Some(preset) = options.agent_preset.as_ref() {
        create.insert("agentPreset".into(), json!(preset));
    }
    let session =
        call_rpc::<Value>(&client, &base_url, "session.create", Value::Object(create)).await?;
    let session_id = session
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| Error::Invalid("DeepSeek Harness 未返回 sessionId".into()))?
        .to_owned();
    let (events_tx, events_rx) = mpsc::channel::<AdapterEvent>(64);
    let _ = events_tx.try_send(AdapterEvent::NativeId(session_id.clone()));
    let websocket = format!("ws://127.0.0.1:{port}/api/events.mux");
    let auto = options.policy == super::store::ApprovalPolicy::Auto;
    let (ready_tx, ready_rx) = oneshot::channel();
    tokio::spawn(run_events(EventLoop {
        url: websocket,
        session_id: session_id.clone(),
        events: events_tx.clone(),
        client: client.clone(),
        base_url: base_url.clone(),
        auto,
        ready: ready_tx,
        child,
    }));
    match tokio::time::timeout(START_TIMEOUT, ready_rx).await {
        Ok(Ok(Ok(()))) => {}
        Ok(Ok(Err(error))) => return Err(error),
        Ok(Err(_)) => return Err(Error::Closed),
        Err(_) => return Err(Error::Timeout),
    }
    let _ = call_rpc::<Value>(
        &client,
        &base_url,
        "session.history",
        json!({"sessionId": session_id, "maxMessages": 50}),
    )
    .await;
    if let Some(model) = options.model.as_ref() {
        select_model(
            &client,
            &base_url,
            &session_id,
            model,
            options.effort.as_deref(),
        )
        .await?;
    }
    call_rpc::<Value>(
        &client,
        &base_url,
        "session.prompt",
        json!({"sessionId":session_id,"mode":"queue","content":prompt_content(prompt, attachments)}),
    )
    .await?;
    Ok(DeepseekTurn {
        client,
        base_url,
        events: Some(events_rx),
        control_events: events_tx,
        session_id,
        current_model: options.model.clone(),
        current_effort: options.effort.clone(),
        child_pid,
    })
}

async fn run_events(loop_state: EventLoop) {
    let EventLoop {
        url,
        session_id,
        events,
        client,
        base_url,
        auto,
        ready,
        mut child,
    } = loop_state;
    let mut socket = match tokio_tungstenite::connect_async(url).await {
        Ok((socket, _)) => {
            let _ = ready.send(Ok(()));
            socket
        }
        Err(_) => {
            let _ = ready.send(Err(Error::Invalid(
                "DeepSeek Harness 事件连接不可用".into(),
            )));
            let child_pid = child.id().unwrap_or(0);
            kill_process_group(child_pid);
            let _ = child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
            return;
        }
    };
    let mut seen_finish = false;
    let mut current_turn = 0;
    let mut text_by_message: HashMap<String, (String, String)> = HashMap::new();
    let mut usage_by_turn: HashMap<i64, (i64, i64)> = HashMap::new();
    let mut tool_names: HashMap<String, String> = HashMap::new();
    while let Some(frame) = socket.next().await {
        let text = match frame {
            Ok(Message::Text(text)) => text.to_string(),
            Ok(Message::Binary(bytes)) => match String::from_utf8(bytes.to_vec()) {
                Ok(text) => text,
                Err(_) => continue,
            },
            Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => continue,
            Ok(Message::Close(_)) | Err(_) => break,
            _ => continue,
        };
        if text.len() > MAX_EVENT_BYTES {
            break;
        }
        let Ok(envelope) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if envelope.get("type").and_then(Value::as_str) != Some("server-request") {
            continue;
        }
        let Some(rpc_id) = envelope
            .get("rpcId")
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            continue;
        };
        let frame = envelope
            .get("payload")
            .cloned()
            .unwrap_or_else(|| json!({}));
        if frame.get("sessionId").and_then(Value::as_str) != Some(session_id.as_str()) {
            continue;
        }
        match frame.get("type").and_then(Value::as_str) {
            Some("approval/requested") => {
                handle_approval(
                    &events,
                    &client,
                    &base_url,
                    &session_id,
                    rpc_id,
                    &frame,
                    auto,
                )
                .await;
            }
            Some("question/requested") => {
                handle_question(&events, &client, &base_url, &session_id, rpc_id, &frame).await;
            }
            Some("session/event") => {
                let event = frame.get("event").cloned().unwrap_or_else(|| json!({}));
                if consume_event(
                    &events,
                    &mut current_turn,
                    &mut text_by_message,
                    &mut usage_by_turn,
                    &mut tool_names,
                    event,
                )
                .await
                {
                    seen_finish = true;
                    break;
                }
            }
            _ => {}
        }
    }
    if !seen_finish {
        let _ = events
            .send(AdapterEvent::Finish {
                interrupted: false,
                error: Some("DeepSeek Harness 事件连接已关闭".into()),
                cost_usd: None,
                input_tokens: None,
                output_tokens: None,
                diffs: Vec::new(),
            })
            .await;
    }
    let child_pid = child.id().unwrap_or(0);
    kill_process_group(child_pid);
    let _ = child.start_kill();
    let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
}

async fn handle_approval(
    events: &mpsc::Sender<AdapterEvent>,
    client: &reqwest::Client,
    base_url: &str,
    session_id: &str,
    rpc_id: String,
    frame: &Value,
    auto: bool,
) {
    let approval_id = frame
        .get("approvalId")
        .and_then(Value::as_str)
        .unwrap_or("deepseek-approval")
        .to_owned();
    let request_id = safe_id(&approval_id, "deepseek-approval");
    let tool = frame
        .get("toolName")
        .and_then(Value::as_str)
        .unwrap_or("tool")
        .chars()
        .take(128)
        .collect::<String>();
    let tool = clean_text(&tool, 128);
    let reason = frame.get("reason").and_then(Value::as_str).unwrap_or("");
    if auto {
        respond_rpc(
            client,
            base_url,
            rpc_id,
            json!({"ok":true,"value":{"sessionId":session_id,"approvalId":approval_id,"outcome":"allowed-once"}}),
        )
        .await;
        return;
    }
    let (reply, receiver) = oneshot::channel();
    if events
        .send(AdapterEvent::Permission {
            subagent: None,
            request_id,
            tool,
            summary: summarize(reason),
            reply,
        })
        .await
        .is_err()
    {
        return;
    }
    let client = client.clone();
    let base_url = base_url.to_owned();
    let session_id = session_id.to_owned();
    tokio::spawn(async move {
        let allow = receiver.await.unwrap_or(false);
        respond_rpc(
            &client,
            &base_url,
            rpc_id,
            json!({"ok":true,"value":{"sessionId":session_id,"approvalId":approval_id,"outcome": if allow { "allowed-once" } else { "rejected" }}}),
        )
        .await;
    });
}

async fn handle_question(
    events: &mpsc::Sender<AdapterEvent>,
    client: &reqwest::Client,
    base_url: &str,
    session_id: &str,
    rpc_id: String,
    frame: &Value,
) {
    let questions = frame
        .get("questions")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .enumerate()
                .filter_map(|(index, row)| deepseek_question(index, row))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if questions.is_empty() {
        return;
    }
    let (reply, receiver) = oneshot::channel();
    if events
        .send(AdapterEvent::Question {
            subagent: None,
            request_id: rpc_id.clone(),
            questions,
            reply,
        })
        .await
        .is_err()
    {
        return;
    }
    let client = client.clone();
    let base_url = base_url.to_owned();
    let session_id = session_id.to_owned();
    tokio::spawn(async move {
        let response = match receiver.await {
            Ok(reply) if reply.cancelled => {
                json!({"ok":false,"error":{"code":"cancelled","message":"the user closed this question request","details":{}}})
            }
            Ok(reply) => {
                json!({"ok":true,"value":{"sessionId":session_id,"answer":{"answers": reply.answers.into_iter().map(|(id, values)| {
                json!({"id":id,"selected":values.split(", ").filter(|value| !value.is_empty()).collect::<Vec<_>>()})
            }).collect::<Vec<_>>()}}})
            }
            Err(_) => {
                json!({"ok":false,"error":{"code":"cancelled","message":"the question was cancelled","details":{}}})
            }
        };
        respond_rpc(&client, &base_url, rpc_id, response).await;
    });
}

async fn consume_event(
    events: &mpsc::Sender<AdapterEvent>,
    current_turn: &mut i64,
    text_by_message: &mut HashMap<String, (String, String)>,
    usage_by_turn: &mut HashMap<i64, (i64, i64)>,
    tool_names: &mut HashMap<String, String>,
    event: Value,
) -> bool {
    let typ = event
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let data = event.get("data").cloned().unwrap_or_else(|| json!({}));
    match typ {
        "turn/start" => {
            *current_turn =
                finite(data.get("turn").unwrap_or(&Value::Null)).unwrap_or(*current_turn + 1);
            text_by_message.clear();
        }
        "assistant/chunk" => {
            let chunk = data.get("chunk").cloned().unwrap_or_else(|| json!({}));
            let message_id = message_id(&data, *current_turn);
            let entry = text_by_message.entry(message_id).or_default();
            match chunk.get("type").and_then(Value::as_str) {
                Some("text-delta") => {
                    if let Some(text) = chunk.get("text").and_then(Value::as_str)
                        && !text.is_empty()
                    {
                        entry.0.push_str(text);
                        let _ = events
                            .send(AdapterEvent::Text {
                                subagent: None,
                                text: entry.0.clone(),
                            })
                            .await;
                    }
                }
                Some("reasoning-delta") => {
                    if let Some(text) = chunk.get("text").and_then(Value::as_str)
                        && !text.is_empty()
                    {
                        entry.1.push_str(text);
                        let _ = events
                            .send(AdapterEvent::Thinking {
                                subagent: None,
                                text: entry.1.clone(),
                            })
                            .await;
                    }
                }
                _ => {}
            }
        }
        "assistant/message" => {
            let turn = finite(data.get("turn").unwrap_or(&Value::Null)).unwrap_or(*current_turn);
            let message_id = message_id(&data, *current_turn);
            let assembled = assistant_content(
                data.get("message")
                    .and_then(|message| message.get("content"))
                    .unwrap_or(&Value::Null),
            );
            let streamed = text_by_message.entry(message_id).or_default();
            if !assembled.1.is_empty() && assembled.1 != streamed.1 {
                if !assembled.1.is_empty() {
                    let _ = events
                        .send(AdapterEvent::Thinking {
                            subagent: None,
                            text: assembled.1.clone(),
                        })
                        .await;
                }
                streamed.1 = assembled.1;
            }
            if !assembled.0.is_empty() && assembled.0 != streamed.0 {
                let text = assembled.0.clone();
                let _ = events
                    .send(AdapterEvent::Text {
                        subagent: None,
                        text: text.clone(),
                    })
                    .await;
                streamed.0 = text;
            }
            let usage = data.get("usage").cloned().unwrap_or_else(|| json!({}));
            let entry = usage_by_turn.entry(turn).or_default();
            entry.0 += finite(usage.get("inputTokens").unwrap_or(&Value::Null)).unwrap_or(0);
            entry.1 += finite(usage.get("outputTokens").unwrap_or(&Value::Null)).unwrap_or(0);
        }
        "tool/call" => {
            let call_id = safe_id(
                data.get("callId").and_then(Value::as_str).unwrap_or(""),
                "deepseek-tool",
            );
            let name = data
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("tool")
                .chars()
                .take(128)
                .collect::<String>();
            tool_names.insert(call_id.clone(), name.clone());
            let _ = events
                .send(AdapterEvent::ToolCall {
                    subagent: None,
                    call_id,
                    name,
                    summary: summarize(data.get("arguments").cloned().unwrap_or(Value::Null)),
                    diff: None,
                })
                .await;
        }
        "tool/result" => {
            let message = data.get("message").cloned().unwrap_or_else(|| json!({}));
            let call_id = safe_id(
                record(&message)
                    .get("source")
                    .and_then(|source| source.get("callId"))
                    .or_else(|| data.get("callId"))
                    .and_then(Value::as_str)
                    .unwrap_or(""),
                "deepseek-tool",
            );
            let output = content_text(
                record(&message)
                    .get("content")
                    .unwrap_or_else(|| data.get("output").unwrap_or(&Value::Null)),
            );
            let failed = data.get("error").is_some_and(|error| !error.is_null())
                || first_tool_result_error(record(&message).get("content"));
            let summary = if output.trim().is_empty() {
                summarize(
                    data.get("error")
                        .cloned()
                        .unwrap_or_else(|| json!(if failed { "失败" } else { "完成" })),
                )
            } else {
                summarize(output.clone())
            };
            let _ = events
                .send(AdapterEvent::ToolResult {
                    subagent: None,
                    call_id: call_id.clone(),
                    name: tool_names.remove(&call_id).unwrap_or_else(|| "tool".into()),
                    summary,
                    error: failed,
                    diff: None,
                    has_more: output.len() > 2000,
                })
                .await;
        }
        "turn/end" => {
            let turn = finite(data.get("turn").unwrap_or(&Value::Null)).unwrap_or(*current_turn);
            let reason = data.get("reason").cloned().unwrap_or_else(|| json!({}));
            let finish = reason
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("completed");
            let usage = usage_by_turn.remove(&turn);
            let failed = finish == "error";
            let interrupted = matches!(finish, "cancelled" | "canceled" | "interrupted");
            let error = failed.then(|| {
                summarize(
                    reason
                        .get("error")
                        .and_then(|error| error.get("message"))
                        .cloned()
                        .unwrap_or_else(|| json!("DeepSeek Harness 运行失败")),
                )
            });
            let _ = events
                .send(AdapterEvent::Finish {
                    interrupted,
                    error,
                    cost_usd: None,
                    input_tokens: usage.map(|tokens| tokens.0),
                    output_tokens: usage.map(|tokens| tokens.1),
                    diffs: Vec::new(),
                })
                .await;
            return true;
        }
        _ => {}
    }
    false
}

fn deepseek_question(index: usize, row: &Value) -> Option<QuestionSpec> {
    let row = row.as_object()?;
    let native_id = row
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("question_{}", index + 1));
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
        .unwrap_or("DeepSeek")
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
        id: safe_id(&native_id, &format!("question_{}", index + 1)),
        native_question: native_id,
        header,
        question,
        options,
        multi_select: row.get("multiSelect").and_then(Value::as_bool) == Some(true),
    })
}

fn prompt_content(text: &str, attachments: &[crate::agent::AttachmentInput]) -> Value {
    let mut items = Vec::new();
    if !text.is_empty() {
        items.push(json!({"type":"text","text":text}));
    }
    items.extend(attachments.iter().map(|attachment| {
        let mut item = serde_json::Map::new();
        item.insert("type".into(), json!("image"));
        item.insert("mediaType".into(), json!(attachment.mime_type));
        item.insert("data".into(), json!(attachment.data_b64));
        if let Some(name) = attachment.name.as_ref() {
            item.insert("name".into(), json!(name));
        }
        Value::Object(item)
    }));
    Value::Array(items)
}

fn message_id(data: &Value, current_turn: i64) -> String {
    let id = data
        .get("message")
        .and_then(|message| message.get("id"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            let turn = finite(data.get("turn").unwrap_or(&Value::Null)).unwrap_or(current_turn);
            let step = finite(data.get("step").unwrap_or(&Value::Null)).unwrap_or(0);
            format!("deepseek_{turn}_{step}")
        });
    safe_id(&id, "deepseek-message")
}

fn content_text(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.to_owned();
    }
    let Some(items) = value.as_array() else {
        return summarize(value.clone());
    };
    items
        .iter()
        .filter_map(|item| {
            let item = record(item);
            match item.get("type").and_then(Value::as_str) {
                Some("text") | Some("reasoning") => {
                    item.get("text").and_then(Value::as_str).map(str::to_owned)
                }
                Some("tool-result") => {
                    Some(content_text(item.get("content").unwrap_or(&Value::Null)))
                }
                _ => None,
            }
        })
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn assistant_content(value: &Value) -> (String, String) {
    let Some(items) = value.as_array() else {
        return (String::new(), String::new());
    };
    let mut text = Vec::new();
    let mut reasoning = Vec::new();
    for item in items {
        let item = record(item);
        match item.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(value) = item.get("text").and_then(Value::as_str) {
                    text.push(value.to_owned());
                }
            }
            Some("reasoning") => {
                if let Some(value) = item.get("text").and_then(Value::as_str) {
                    reasoning.push(value.to_owned());
                }
            }
            _ => {}
        }
    }
    (text.join("\n"), reasoning.join("\n"))
}

fn first_tool_result_error(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .is_some_and(|item| item.get("isError").and_then(Value::as_bool) == Some(true))
}

async fn select_model(
    client: &reqwest::Client,
    base_url: &str,
    session_id: &str,
    model: &str,
    effort: Option<&str>,
) -> Result<Value> {
    let (provider, model_id) = model
        .split_once('/')
        .ok_or_else(|| Error::Invalid("DeepSeek 模型 ID 格式无效".into()))?;
    if provider.is_empty() || model_id.is_empty() {
        return Err(Error::Invalid("DeepSeek 模型 ID 格式无效".into()));
    }
    let mut payload = serde_json::Map::new();
    payload.insert("sessionId".into(), json!(session_id));
    payload.insert("provider".into(), json!(provider));
    payload.insert("model".into(), json!(model_id));
    if let Some(effort) = effort {
        payload.insert("reasoningEffort".into(), json!(effort));
    }
    call_rpc(
        client,
        base_url,
        "session.selectModel",
        Value::Object(payload),
    )
    .await
}

async fn read_catalog(
    client: &reqwest::Client,
    base_url: &str,
    session_id: Option<&str>,
    current_preset: Option<&str>,
) -> Result<LaunchModelCatalog> {
    let models_raw = if let Some(session_id) = session_id {
        call_rpc::<Value>(
            client,
            base_url,
            "session.models",
            json!({"sessionId":session_id}),
        )
        .await?
    } else {
        call_rpc::<Value>(client, base_url, "llm.models", json!({})).await?
    };
    let current = models_raw
        .get("current")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let current_model = current
        .get("provider")
        .and_then(Value::as_str)
        .zip(current.get("model").and_then(Value::as_str))
        .map(|(provider, model)| format!("{provider}/{model}"))
        .filter(|value| value != "/");
    let current_effort = current
        .get("reasoningEffort")
        .and_then(Value::as_str)
        .map(|value| clean_text(value, 100));
    let mut models = Vec::new();
    for group in models_raw
        .get("groups")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let group = record(group);
        let provider = group.get("id").and_then(Value::as_str).unwrap_or_default();
        if provider.is_empty() {
            continue;
        }
        let provider_name = group
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(provider);
        for raw_model in group
            .get("models")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let raw_model = record(raw_model);
            let model = raw_model
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if model.is_empty() {
                continue;
            }
            let id = format!("{provider}/{model}");
            let name = raw_model
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(model);
            let reasoning = raw_model
                .get("reasoning")
                .map(record)
                .unwrap_or_else(|| record(&Value::Null));
            let supported_efforts = reasoning
                .get("efforts")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| record(item).get("id").and_then(Value::as_str))
                        .map(|value| clean_text(value, 100))
                        .filter(|value| !value.is_empty())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let default_effort = reasoning
                .get("defaultEffort")
                .and_then(Value::as_str)
                .map(|value| clean_text(value, 100));
            models.push(LaunchModelInfo {
                id: clean_text(&id, 300),
                label: clean_text(&format!("{provider_name} · {name}"), 300),
                description: raw_model
                    .get("description")
                    .and_then(Value::as_str)
                    .map(|value| clean_text(value, 2000)),
                supported_efforts,
                default_effort,
                is_default: current_model.as_deref() == Some(id.as_str()),
            });
        }
    }
    if models.is_empty() {
        return Err(Error::Invalid("DeepSeek 没有返回可选模型".into()));
    }
    let preset_raw = call_rpc::<Value>(client, base_url, "agentPreset.list", json!({}))
        .await
        .unwrap_or_else(|_| json!({}));
    let presets = preset_raw
        .get("presets")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let item = record(item);
                    if item
                        .get("broken")
                        .and_then(Value::as_str)
                        .is_some_and(|value| !value.is_empty())
                    {
                        return None;
                    }
                    let id = item.get("id")?.as_str()?.trim();
                    if id.is_empty() {
                        return None;
                    }
                    Some(AgentPresetInfo {
                        id: clean_text(id, 300),
                        name: clean_text(
                            item.get("name").and_then(Value::as_str).unwrap_or(id),
                            300,
                        ),
                        description: item
                            .get("description")
                            .and_then(Value::as_str)
                            .map(|value| clean_text(value, 2000)),
                        is_default: item.get("isDefault").and_then(Value::as_bool) == Some(true),
                        custom: item.get("trust").and_then(Value::as_str) == Some("user"),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let current_preset = current_preset.map(str::to_owned).or_else(|| {
        presets
            .iter()
            .find(|preset| preset.is_default)
            .or_else(|| presets.first())
            .map(|preset| preset.id.clone())
    });
    let current_model = current_model.or_else(|| models.first().map(|model| model.id.clone()));
    Ok(LaunchModelCatalog {
        models,
        current_model,
        current_effort,
        presets,
        current_preset,
    })
}

async fn transient_catalog(workspace: &str, native_id: Option<&str>) -> Result<LaunchModelCatalog> {
    let (mut child, port) = start_process(workspace, &[]).await?;
    let child_pid = child.id().unwrap_or(0);
    let result = async {
        let client = reqwest::Client::new();
        let base_url = format!("http://127.0.0.1:{port}");
        wait_ready(&client, &base_url).await?;
        let session_id = if let Some(native_id) = native_id {
            let created = call_rpc::<Value>(
                &client,
                &base_url,
                "session.create",
                json!({"cwd":workspace,"sessionId":native_id}),
            )
            .await?;
            created
                .get("sessionId")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| Some(native_id.to_owned()))
        } else {
            None
        };
        read_catalog(&client, &base_url, session_id.as_deref(), None).await
    }
    .await;
    kill_process_group(child_pid);
    let _ = child.start_kill();
    let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
    result
}

pub(super) async fn launch_catalog() -> Result<LaunchModelCatalog> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
    transient_catalog(&home, None).await
}

pub(super) async fn session_catalog(
    workspace: &str,
    native_id: Option<&str>,
    current_model: Option<&str>,
    current_effort: Option<&str>,
) -> Result<AgentModelCatalog> {
    let catalog = transient_catalog(workspace, native_id).await?;
    Ok(AgentModelCatalog {
        models: catalog.models,
        current_model: current_model.map(str::to_owned).or(catalog.current_model),
        current_effort: current_effort.map(str::to_owned).or(catalog.current_effort),
    })
}

pub(super) async fn search_conversations(
    query: String,
    limit: Option<usize>,
) -> Result<Vec<crate::agent::ResumableConversation>> {
    if query.chars().count() > 300 || query.chars().any(char::is_control) {
        return Err(Error::Invalid("对话搜索词无效".into()));
    }
    let limit = limit.unwrap_or(20).clamp(1, 50);
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
    let (mut child, port) = start_process(&home, &[]).await?;
    let child_pid = child.id().unwrap_or(0);
    let result = async {
        let client = reqwest::Client::new();
        let base_url = format!("http://127.0.0.1:{port}");
        wait_ready(&client, &base_url).await?;
        let listed = if query.trim().is_empty() {
            call_rpc::<Value>(&client, &base_url, "session.list", json!({})).await?
        } else {
            call_rpc::<Value>(&client, &base_url, "session.search", json!({"query":query})).await?
        };
        let items = listed
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        Ok(items
            .into_iter()
            .filter_map(|item| deepseek_conversation(&item))
            .take(limit)
            .collect::<Vec<_>>())
    }
    .await;
    kill_process_group(child_pid);
    let _ = child.start_kill();
    let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
    result
}

fn deepseek_conversation(item: &Value) -> Option<crate::agent::ResumableConversation> {
    if item.get("blank").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let id = item
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())?;
    let cwd = item
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("/");
    let values = item
        .get("projections")
        .and_then(|value| value.get("values"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    let title = values
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| item.get("title").and_then(Value::as_str))
        .filter(|value| !value.is_empty())
        .or_else(|| item.get("snippet").and_then(Value::as_str))
        .filter(|value| !value.is_empty())
        .map(|value| clean_text(value, 500))
        .unwrap_or_else(|| {
            let name = Path::new(cwd)
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("DeepSeek");
            format!("DeepSeek · {}", clean_text(name, 120))
        });
    let preview = item
        .get("snippet")
        .and_then(Value::as_str)
        .map(|value| clean_text(value, 4000));
    Some(crate::agent::ResumableConversation {
        id: clean_text(id, 256),
        agent: crate::protocol::AgentKind::Deepseek,
        title,
        preview,
        cwd: clean_text(cwd, 4096),
        created_at: item
            .get("createdAt")
            .or_else(|| item.get("created_at"))
            .and_then(finite),
        updated_at: item
            .get("updatedAt")
            .or_else(|| item.get("updated_at"))
            .and_then(finite)
            .unwrap_or_else(crate::database::now),
    })
}

impl DeepseekTurn {
    pub(super) fn take_events(&mut self) -> Option<mpsc::Receiver<AdapterEvent>> {
        self.events.take()
    }

    pub(super) fn interrupt(&self) {
        let client = self.client.clone();
        let base_url = self.base_url.clone();
        let session_id = self.session_id.clone();
        tokio::spawn(async move {
            let _ = call_rpc::<Value>(
                &client,
                &base_url,
                "session.cancel",
                json!({"sessionId":session_id}),
            )
            .await;
        });
    }

    pub(super) async fn steer(
        &self,
        text: &str,
        attachments: &[crate::agent::AttachmentInput],
    ) -> Result<()> {
        call_rpc::<Value>(
            &self.client,
            &self.base_url,
            "session.prompt",
            json!({"sessionId":self.session_id,"mode":"steer","content":prompt_content(text, attachments)}),
        )
        .await
        .map(|_| ())
    }

    pub(super) async fn compact(&self) -> Result<()> {
        call_rpc::<Value>(
            &self.client,
            &self.base_url,
            "session.prompt",
            json!({"sessionId":self.session_id,"mode":"queue","content":[{"type":"text","text":"/compact"}]}),
        )
        .await?;
        self.control_events
            .send(AdapterEvent::Compact {
                ok: true,
                message: String::new(),
            })
            .await
            .map_err(|_| Error::Closed)
    }

    pub(super) async fn apply_selection(
        &mut self,
        model: &str,
        effort: Option<&str>,
    ) -> Result<()> {
        let selected = select_model(
            &self.client,
            &self.base_url,
            &self.session_id,
            model,
            effort,
        )
        .await?;
        let selected = selected
            .get("selected")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let provider = selected
            .get("provider")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let model_id = selected
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or_default();
        self.current_model = if !provider.is_empty() && !model_id.is_empty() {
            Some(format!("{provider}/{model_id}"))
        } else {
            Some(model.to_owned())
        };
        self.current_effort = selected
            .get("reasoningEffort")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| effort.map(str::to_owned));
        Ok(())
    }

    pub(super) async fn models(&self) -> Result<AgentModelCatalog> {
        let catalog =
            read_catalog(&self.client, &self.base_url, Some(&self.session_id), None).await?;
        Ok(AgentModelCatalog {
            models: catalog.models,
            current_model: self.current_model.clone().or(catalog.current_model),
            current_effort: self.current_effort.clone().or(catalog.current_effort),
        })
    }

    pub(super) fn kill(&self) {
        kill_process_group(self.child_pid);
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn read_http_json(stream: &std::net::TcpStream) -> Value {
        let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
        use std::io::{BufRead, Read};
        let mut headers = String::new();
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            if line == "\r\n" || line.is_empty() {
                break;
            }
            headers.push_str(&line);
        }
        let length = headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().ok())
                    .flatten()
            })
            .unwrap_or(0);
        let mut body = vec![0; length];
        reader.read_exact(&mut body).unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    fn write_http_json(stream: &std::net::TcpStream, value: Value) {
        use std::io::Write;
        let mut writer = stream.try_clone().unwrap();
        let body = value.to_string();
        write!(
            writer,
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nconnection: close\r\ncontent-length: {}\r\n\r\n",
            body.len()
        )
        .unwrap();
        writer.write_all(body.as_bytes()).unwrap();
    }

    #[test]
    fn parses_deepseek_model_and_preset_catalog() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let request = read_http_json(&stream);
            write_http_json(
                &stream,
                json!({
                    "type": "server-response",
                    "rpcId": request["rpcId"],
                    "result": {"ok": true, "value": {
                        "current": {
                            "provider": "deepseek-official",
                            "model": "deepseek-v4-flash",
                            "reasoningEffort": "high"
                        },
                        "groups": [{
                            "id": "deepseek-official",
                            "name": "DeepSeek",
                            "models": [{
                                "id": "deepseek-v4-flash",
                                "name": "V4 Flash",
                                "description": "fast",
                                "reasoning": {
                                    "efforts": [{"id": "low"}, {"id": "high"}],
                                    "defaultEffort": "high"
                                }
                            }]
                        }]
                    }}
                }),
            );
            let (stream, _) = listener.accept().unwrap();
            let request = read_http_json(&stream);
            write_http_json(
                &stream,
                json!({
                    "type": "server-response",
                    "rpcId": request["rpcId"],
                    "result": {"ok": true, "value": {
                        "presets": [
                            {"id": "default", "name": "Default", "isDefault": true},
                            {"id": "reviewer", "name": "Reviewer", "trust": "user"},
                            {"id": "broken", "name": "Broken", "broken": "bad"}
                        ]
                    }}
                }),
            );
        });
        let client = reqwest::Client::new();
        let catalog = runtime
            .block_on(read_catalog(
                &client,
                &format!("http://{address}"),
                None,
                None,
            ))
            .unwrap();
        assert_eq!(
            catalog.current_model.as_deref(),
            Some("deepseek-official/deepseek-v4-flash")
        );
        assert_eq!(catalog.current_effort.as_deref(), Some("high"));
        assert_eq!(catalog.models[0].default_effort.as_deref(), Some("high"));
        assert_eq!(catalog.presets.len(), 2);
        assert_eq!(catalog.current_preset.as_deref(), Some("default"));
        assert!(
            catalog
                .presets
                .iter()
                .any(|preset| preset.id == "reviewer" && preset.custom)
        );
    }

    #[tokio::test]
    async fn maps_deepseek_events_to_timeline_adapter_events() {
        let (tx, mut rx) = mpsc::channel(16);
        let mut current_turn = 0;
        let mut text_by_message = HashMap::new();
        let mut usage_by_turn = HashMap::new();
        let mut tool_names = HashMap::new();

        assert!(
            !consume_event(
                &tx,
                &mut current_turn,
                &mut text_by_message,
                &mut usage_by_turn,
                &mut tool_names,
                json!({"type":"turn/start","data":{"turn":2}})
            )
            .await
        );
        assert!(
            !consume_event(
                &tx,
                &mut current_turn,
                &mut text_by_message,
                &mut usage_by_turn,
                &mut tool_names,
                json!({"type":"assistant/chunk","data":{"turn":2,"step":1,"chunk":{"type":"text-delta","text":"hello"}}})
            )
            .await
        );
        assert!(
            !consume_event(
                &tx,
                &mut current_turn,
                &mut text_by_message,
                &mut usage_by_turn,
                &mut tool_names,
                json!({"type":"assistant/message","data":{"turn":2,"step":1,"message":{"id":"msg:unsafe","content":[{"type":"reasoning","text":"think"},{"type":"text","text":"hello world"}]},"usage":{"inputTokens":3,"outputTokens":5}}})
            )
            .await
        );
        assert!(
            consume_event(
                &tx,
                &mut current_turn,
                &mut text_by_message,
                &mut usage_by_turn,
                &mut tool_names,
                json!({"type":"turn/end","data":{"turn":2,"reason":{"kind":"completed"}}})
            )
            .await
        );
        drop(tx);

        assert!(
            matches!(rx.recv().await.unwrap(), AdapterEvent::Text { text, .. } if text == "hello")
        );
        assert!(
            matches!(rx.recv().await.unwrap(), AdapterEvent::Thinking { text, .. } if text == "think")
        );
        assert!(
            matches!(rx.recv().await.unwrap(), AdapterEvent::Text { text, .. } if text == "hello world")
        );
        assert!(matches!(
            rx.recv().await.unwrap(),
            AdapterEvent::Finish {
                input_tokens: Some(3),
                output_tokens: Some(5),
                error: None,
                ..
            }
        ));
    }
}
