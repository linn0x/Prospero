use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use futures_util::StreamExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};

use super::claude::{AdapterEvent, TurnOptions};
use super::store::ApprovalPolicy;
use super::{AgentModelCatalog, LaunchModelCatalog, LaunchModelInfo};
use crate::error::{Error, Result};

const START_TIMEOUT: Duration = Duration::from_secs(30);
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_EVENT_BYTES: usize = 4 * 1024 * 1024;
const OUTPUT_LIMIT: usize = 64 * 1024;

pub(super) struct OpencodeTurn {
    client: reqwest::Client,
    base_url: String,
    events: Option<mpsc::Receiver<AdapterEvent>>,
    session_id: String,
    workspace: String,
    model: Option<String>,
    isolated: bool,
    child_pid: u32,
}

struct EventLoop {
    client: reqwest::Client,
    base_url: String,
    event_url: String,
    session_id: String,
    auto_approve: bool,
    events: mpsc::Sender<AdapterEvent>,
    ready: oneshot::Sender<Result<()>>,
    child: Child,
}

struct EventContext<'a> {
    events: &'a mpsc::Sender<AdapterEvent>,
    client: &'a reqwest::Client,
    base_url: &'a str,
    session_id: &'a str,
    auto_approve: bool,
}

fn binary() -> String {
    std::env::var("PROSPERO_OPENCODE_BIN").unwrap_or_else(|_| "opencode".into())
}

fn location_query(directory: &str) -> String {
    format!("location[directory]={}", url_encode(directory))
}

fn url_encode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn parse_port(output: &str) -> Option<u16> {
    let marker = "listening on ";
    let index = output.to_ascii_lowercase().find(marker)?;
    let rest = &output[index + marker.len()..];
    let (_, port) = rest.rsplit_once(':')?;
    let digits = port
        .chars()
        .take_while(|value| value.is_ascii_digit())
        .collect::<String>();
    digits.parse().ok()
}

async fn start_process(workspace: &str, environment: &[(String, String)]) -> Result<(Child, u16)> {
    let isolated = environment
        .iter()
        .any(|(key, _)| key == "PROSPERO_API_PROFILE_CONFIG");
    let mut command = Command::new(binary());
    command
        .args(["serve", "--hostname", "127.0.0.1", "--port", "0"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(false);
    if isolated {
        command
            .arg("--pure")
            .current_dir(workspace)
            .env_remove("OPENCODE_CONFIG")
            .env_remove("OPENCODE_CONFIG_CONTENT")
            .env_remove("OPENCODE_CONFIG_DIR");
    }
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
            Error::Feature("agent_unavailable".into(), "未安装 opencode".into())
        } else {
            Error::Io(error)
        }
    })?;
    let stdout = child.stdout.take().ok_or(Error::Closed)?;
    let stderr = child.stderr.take().ok_or(Error::Closed)?;
    let (ports_tx, mut ports_rx) = mpsc::unbounded_channel();
    tokio::spawn(drain_output(BufReader::new(stdout), ports_tx.clone()));
    tokio::spawn(drain_output(BufReader::new(stderr), ports_tx));
    let port = tokio::time::timeout(START_TIMEOUT, async {
        tokio::select! {
            port = ports_rx.recv() => port.ok_or(Error::Closed),
            status = child.wait() => Err(Error::Invalid(format!("opencode serve 启动时退出: {:?}", status.ok()))),
        }
    })
    .await
    .map_err(|_| Error::Timeout)??;
    Ok((child, port))
}

async fn drain_output<R>(mut reader: BufReader<R>, ports: mpsc::UnboundedSender<u16>)
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
        if output.len() > OUTPUT_LIMIT {
            let drain = output.len() - OUTPUT_LIMIT;
            output.drain(..drain);
        }
        if !sent && let Some(port) = parse_port(&output) {
            let _ = ports.send(port);
            sent = true;
        }
    }
}

async fn fetch_json<T: serde::de::DeserializeOwned>(
    client: &reqwest::Client,
    url: String,
    method: &str,
    body: Option<Value>,
) -> Result<T> {
    let request = if method == "POST" {
        client.post(url)
    } else {
        client.get(url)
    };
    let request = if let Some(body) = body {
        request.json(&body)
    } else {
        request
    };
    let response = request
        .timeout(HTTP_TIMEOUT)
        .send()
        .await
        .map_err(|error| Error::Invalid(format!("OpenCode HTTP failed: {error}")))?;
    if !response.status().is_success() {
        return Err(Error::Invalid(format!(
            "OpenCode HTTP {}",
            response.status()
        )));
    }
    if response.status().as_u16() == 204 {
        return serde_json::from_value(Value::Null)
            .map_err(|_| Error::Invalid("OpenCode response invalid".into()));
    }
    let raw = response
        .text()
        .await
        .map_err(|error| Error::Invalid(format!("OpenCode response invalid: {error}")))?;
    if raw.trim().is_empty() {
        return serde_json::from_value(Value::Null)
            .map_err(|_| Error::Invalid("OpenCode response invalid".into()));
    }
    let value = serde_json::from_str::<Value>(&raw)?;
    let value = value.get("data").cloned().unwrap_or(value);
    serde_json::from_value(value).map_err(|_| Error::Invalid("OpenCode response invalid".into()))
}

async fn wait_catalog(
    client: &reqwest::Client,
    base_url: &str,
    workspace: &str,
    expected: Option<&str>,
) -> Result<()> {
    let deadline = tokio::time::Instant::now() + START_TIMEOUT;
    loop {
        match fetch_json::<Value>(
            client,
            format!("{base_url}/api/model?{}", location_query(workspace)),
            "GET",
            None,
        )
        .await
        {
            Ok(value) if expected.is_some_and(|model| catalog_has_model(&value, model)) => {
                return Ok(());
            }
            Ok(value) if expected.is_none() && catalog_non_empty(&value) => return Ok(()),
            _ if tokio::time::Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            _ => return Err(Error::Invalid("opencode 模型 catalog 加载超时".into())),
        }
    }
}

fn catalog_non_empty(value: &Value) -> bool {
    value.as_array().is_some_and(|items| !items.is_empty())
        || value.as_object().is_some_and(|object| !object.is_empty())
}

fn catalog_has_model(value: &Value, expected: &str) -> bool {
    let Some((provider, model)) = expected.split_once('/') else {
        return false;
    };
    if let Some(items) = value.as_array() {
        return items.iter().any(|item| {
            item.get("providerID").and_then(Value::as_str) == Some(provider)
                && (item.get("id").and_then(Value::as_str) == Some(model)
                    || item.get("modelID").and_then(Value::as_str) == Some(model))
        });
    }
    if value.get(expected).is_some() {
        return true;
    }
    value
        .get(provider)
        .and_then(|provider| provider.get("models"))
        .and_then(Value::as_object)
        .is_some_and(|models| models.contains_key(model))
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

fn stable_request_id(value: &str, fallback: &str) -> String {
    let mut base = safe_id(value, fallback);
    if base == value {
        return base;
    }
    if base.len() > 104 {
        base.truncate(104);
    }
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    let suffix = hasher
        .finalize()
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    base.push('-');
    base.push_str(&suffix);
    base
}

async fn default_model(
    client: &reqwest::Client,
    base_url: &str,
    workspace: &str,
) -> Result<Option<(String, String)>> {
    let config = fetch_json::<Value>(
        client,
        format!("{base_url}/config?directory={}", url_encode(workspace)),
        "GET",
        None,
    )
    .await
    .unwrap_or_else(|_| json!({}));
    let Some(raw) = config.get("model").and_then(Value::as_str) else {
        return Ok(None);
    };
    let Some((provider, model)) = raw.split_once('/') else {
        return Ok(None);
    };
    if provider.is_empty() || model.is_empty() {
        Ok(None)
    } else {
        Ok(Some((provider.to_owned(), model.to_owned())))
    }
}

async fn wait_provider(
    client: &reqwest::Client,
    base_url: &str,
    workspace: &str,
    provider: &str,
) -> Result<()> {
    let deadline = tokio::time::Instant::now() + START_TIMEOUT;
    loop {
        match fetch_json::<Value>(
            client,
            format!(
                "{base_url}/api/provider/{}?{}",
                url_encode(provider),
                location_query(workspace)
            ),
            "GET",
            None,
        )
        .await
        {
            Ok(value) if provider_ready(&value, provider) => return Ok(()),
            _ if tokio::time::Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            _ => {
                return Err(Error::Invalid(
                    "OpenCode API Profile provider 加载超时".into(),
                ));
            }
        }
    }
}

fn provider_ready(value: &Value, expected: &str) -> bool {
    let value = value.get("data").unwrap_or(value);
    value.get("id").and_then(Value::as_str) == Some(expected)
        || value.get("providerID").and_then(Value::as_str) == Some(expected)
}

pub(super) async fn spawn_turn(
    workspace: &str,
    prompt: &str,
    attachments: &[crate::agent::AttachmentInput],
    native_id: Option<&str>,
    options: &TurnOptions,
) -> Result<OpencodeTurn> {
    if !attachments.is_empty() {
        return Err(Error::Invalid(
            "OpenCode structured runtime 暂不支持图片附件".into(),
        ));
    }
    let (mut child, port) = start_process(workspace, &options.environment).await?;
    let child_pid = child.id().ok_or(Error::Closed)?;
    let client = reqwest::Client::new();
    let base_url = format!("http://127.0.0.1:{port}");
    let expected = options
        .environment
        .iter()
        .find_map(|(key, value)| (key == "PROSPERO_API_PROFILE_MODEL").then_some(value.as_str()));
    if let Err(error) = wait_catalog(&client, &base_url, workspace, expected).await {
        cleanup_child(&mut child).await;
        return Err(error);
    }
    let model = default_model(&client, &base_url, workspace).await?;
    if let Some(expected) = expected {
        let actual = model
            .as_ref()
            .map(|(provider, model)| format!("{provider}/{model}"));
        if actual.as_deref() != Some(expected) {
            cleanup_child(&mut child).await;
            return Err(Error::Invalid(
                "OpenCode API Profile 模型配置被其他配置覆盖".into(),
            ));
        }
    }
    let session_id = if let Some(id) = native_id {
        let _: Value = fetch_json(
            &client,
            format!(
                "{base_url}/api/session/{}?{}",
                url_encode(id),
                location_query(workspace)
            ),
            "GET",
            None,
        )
        .await?;
        id.to_owned()
    } else {
        let mut body = serde_json::Map::new();
        body.insert("location".into(), json!({"directory":workspace}));
        if let Some((provider, model)) = &model {
            body.insert("model".into(), json!({"providerID":provider,"id":model}));
        }
        fetch_json::<Value>(
            &client,
            format!("{base_url}/api/session"),
            "POST",
            Some(Value::Object(body)),
        )
        .await?
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::Invalid("OpenCode 未返回 session id".into()))?
        .to_owned()
    };
    let (events_tx, events_rx) = mpsc::channel::<AdapterEvent>(64);
    let _ = events_tx.try_send(AdapterEvent::NativeId(session_id.clone()));
    let (ready_tx, ready_rx) = oneshot::channel();
    tokio::spawn(run_events(EventLoop {
        client: client.clone(),
        base_url: base_url.clone(),
        event_url: format!("{base_url}/api/event"),
        session_id: session_id.clone(),
        auto_approve: options.policy == ApprovalPolicy::Auto,
        events: events_tx.clone(),
        ready: ready_tx,
        child,
    }));
    match tokio::time::timeout(START_TIMEOUT, ready_rx).await {
        Ok(Ok(Ok(()))) => {}
        Ok(Ok(Err(error))) => return Err(error),
        Ok(Err(_)) => return Err(Error::Closed),
        Err(_) => return Err(Error::Timeout),
    }
    let prompt_provider = expected.and_then(|model| model.split_once('/').map(|value| value.0));
    send_prompt(
        &client,
        &base_url,
        workspace,
        &session_id,
        prompt_provider,
        prompt,
    )
    .await?;
    Ok(OpencodeTurn {
        client,
        base_url,
        events: Some(events_rx),
        session_id,
        workspace: workspace.to_owned(),
        model: model.map(|(provider, model)| format!("{provider}/{model}")),
        isolated: expected.is_some(),
        child_pid,
    })
}

async fn run_events(mut loop_state: EventLoop) {
    let response = match loop_state
        .client
        .get(loop_state.event_url.clone())
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => {
            let _ = loop_state
                .ready
                .send(Err(Error::Invalid("OpenCode 事件流不可用".into())));
            cleanup_child(&mut loop_state.child).await;
            return;
        }
    };
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !response.status().is_success() || !content_type.contains("text/event-stream") {
        let _ = loop_state
            .ready
            .send(Err(Error::Invalid("OpenCode 事件流不可用".into())));
        cleanup_child(&mut loop_state.child).await;
        return;
    }
    let _ = loop_state.ready.send(Ok(()));
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut tool_names = HashMap::new();
    let mut input_tokens = None;
    let mut output_tokens = None;
    let mut cost_usd = None;
    let mut finished = false;
    while let Some(chunk) = stream.next().await {
        let Ok(chunk) = chunk else {
            break;
        };
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        if buffer.len() > MAX_EVENT_BYTES {
            break;
        }
        while let Some(index) = buffer.find('\n') {
            let line = buffer[..index].trim().to_owned();
            buffer.drain(..=index);
            if !line.starts_with("data: ") {
                continue;
            }
            let Ok(event) = serde_json::from_str::<Value>(&line[6..]) else {
                continue;
            };
            if event
                .get("data")
                .and_then(|data| data.get("sessionID"))
                .and_then(Value::as_str)
                != Some(loop_state.session_id.as_str())
            {
                continue;
            }
            if consume_event(
                EventContext {
                    events: &loop_state.events,
                    client: &loop_state.client,
                    base_url: &loop_state.base_url,
                    session_id: &loop_state.session_id,
                    auto_approve: loop_state.auto_approve,
                },
                &mut tool_names,
                &mut input_tokens,
                &mut output_tokens,
                &mut cost_usd,
                event,
            )
            .await
            {
                finished = true;
                break;
            }
        }
        if finished {
            break;
        }
    }
    if !finished {
        let _ = loop_state
            .events
            .send(AdapterEvent::Finish {
                interrupted: false,
                error: Some("OpenCode 事件流已关闭".into()),
                cost_usd,
                input_tokens,
                output_tokens,
                diffs: Vec::new(),
            })
            .await;
    }
    cleanup_child(&mut loop_state.child).await;
}

async fn consume_event(
    context: EventContext<'_>,
    tool_names: &mut HashMap<String, String>,
    input_tokens: &mut Option<i64>,
    output_tokens: &mut Option<i64>,
    cost_usd: &mut Option<f64>,
    event: Value,
) -> bool {
    let typ = event
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let data = event.get("data").cloned().unwrap_or_else(|| json!({}));
    let msg_id = data
        .get("assistantMessageID")
        .and_then(Value::as_str)
        .unwrap_or("opencode-message");
    match typ {
        "session.next.text.delta" => {
            if let Some(delta) = data.get("delta").and_then(Value::as_str)
                && !delta.is_empty()
            {
                let _ = context
                    .events
                    .send(AdapterEvent::Text {
                        subagent: None,
                        text: delta.to_owned(),
                    })
                    .await;
            }
        }
        "session.next.reasoning.delta" => {
            if let Some(delta) = data.get("delta").and_then(Value::as_str)
                && !delta.is_empty()
            {
                let _ = context
                    .events
                    .send(AdapterEvent::Thinking {
                        subagent: None,
                        text: delta.to_owned(),
                    })
                    .await;
            }
        }
        "session.next.tool.called" => {
            let call_id = safe_id(
                data.get("callID").and_then(Value::as_str).unwrap_or(""),
                "opencode-tool",
            );
            let tool = data.get("tool").and_then(Value::as_str).unwrap_or("tool");
            tool_names.insert(call_id.clone(), tool.to_owned());
            let _ = context
                .events
                .send(AdapterEvent::ToolCall {
                    subagent: None,
                    call_id,
                    name: tool.chars().take(128).collect(),
                    summary: summarize(data.get("input").cloned().unwrap_or(Value::Null)),
                    diff: None,
                })
                .await;
        }
        "session.next.tool.success" | "session.next.tool.failed" => {
            let call_id = safe_id(
                data.get("callID").and_then(Value::as_str).unwrap_or(""),
                "opencode-tool",
            );
            let failed = typ == "session.next.tool.failed";
            let raw = data
                .get(if failed { "error" } else { "structured" })
                .or_else(|| data.get("result"))
                .or_else(|| data.get("content"))
                .cloned()
                .unwrap_or_else(|| json!(if failed { "失败" } else { "完成" }));
            let summary = summarize(raw);
            let _ = context
                .events
                .send(AdapterEvent::ToolResult {
                    subagent: None,
                    call_id: call_id.clone(),
                    name: tool_names.remove(&call_id).unwrap_or_else(|| "tool".into()),
                    summary,
                    error: failed,
                    diff: None,
                    has_more: false,
                })
                .await;
        }
        "permission.v2.asked" => {
            let native_request_id = data
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("opencode-permission")
                .to_owned();
            let request_id = stable_request_id(&native_request_id, "opencode-permission");
            let action = data.get("action").and_then(Value::as_str).unwrap_or("操作");
            let summary = data
                .get("resources")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .map(|value| format!("{action}: {}", summarize(value.clone())))
                .unwrap_or_else(|| action.to_owned());
            if context.auto_approve {
                if reply_permission(
                    context.client,
                    context.base_url,
                    context.session_id,
                    &native_request_id,
                    true,
                )
                .await
                .is_err()
                {
                    let _ = context
                        .events
                        .send(AdapterEvent::Finish {
                            interrupted: false,
                            error: Some("OpenCode 审批回复失败".into()),
                            cost_usd: *cost_usd,
                            input_tokens: *input_tokens,
                            output_tokens: *output_tokens,
                            diffs: Vec::new(),
                        })
                        .await;
                    return true;
                }
                return false;
            }
            let (reply, receiver) = oneshot::channel();
            if context
                .events
                .send(AdapterEvent::Permission {
                    subagent: None,
                    request_id,
                    tool: action.chars().take(128).collect(),
                    summary,
                    reply,
                })
                .await
                .is_ok()
            {
                let client = context.client.clone();
                let base_url = context.base_url.to_owned();
                let session_id = context.session_id.to_owned();
                let events = context.events.clone();
                tokio::spawn(async move {
                    let allow = receiver.await.unwrap_or(false);
                    if reply_permission(&client, &base_url, &session_id, &native_request_id, allow)
                        .await
                        .is_err()
                    {
                        let _ = events
                            .send(AdapterEvent::Finish {
                                interrupted: false,
                                error: Some("OpenCode 审批回复失败".into()),
                                cost_usd: None,
                                input_tokens: None,
                                output_tokens: None,
                                diffs: Vec::new(),
                            })
                            .await;
                    }
                });
            } else {
                let _ = reply_permission(
                    context.client,
                    context.base_url,
                    context.session_id,
                    &native_request_id,
                    false,
                )
                .await;
            }
        }
        "session.next.step.ended" => {
            let tokens = data.get("tokens").cloned().unwrap_or_else(|| json!({}));
            *input_tokens = tokens.get("input").and_then(Value::as_i64);
            *output_tokens = tokens.get("output").and_then(Value::as_i64);
            *cost_usd = data.get("cost").and_then(Value::as_f64);
            let _ = context
                .events
                .send(AdapterEvent::Finish {
                    interrupted: false,
                    error: None,
                    cost_usd: *cost_usd,
                    input_tokens: *input_tokens,
                    output_tokens: *output_tokens,
                    diffs: Vec::new(),
                })
                .await;
            return true;
        }
        "session.next.step.failed" | "session.error" => {
            let _ = context
                .events
                .send(AdapterEvent::Finish {
                    interrupted: false,
                    error: Some(summarize(data.get("error").cloned().unwrap_or(Value::Null))),
                    cost_usd: *cost_usd,
                    input_tokens: *input_tokens,
                    output_tokens: *output_tokens,
                    diffs: Vec::new(),
                })
                .await;
            return true;
        }
        _ => {
            let _ = msg_id;
        }
    }
    false
}

async fn reply_permission(
    client: &reqwest::Client,
    base_url: &str,
    session_id: &str,
    request_id: &str,
    allow: bool,
) -> Result<()> {
    fetch_json::<Value>(
        client,
        format!(
            "{base_url}/api/session/{}/permission/{}/reply",
            url_encode(session_id),
            url_encode(request_id)
        ),
        "POST",
        Some(json!({"reply": if allow { "once" } else { "reject" }})),
    )
    .await
    .map(|_| ())
}

async fn send_prompt(
    client: &reqwest::Client,
    base_url: &str,
    workspace: &str,
    session_id: &str,
    provider: Option<&str>,
    text: &str,
) -> Result<()> {
    let admitted = fetch_json::<Value>(
        client,
        format!("{base_url}/api/session/{}/prompt", url_encode(session_id)),
        "POST",
        Some(json!({"prompt":{"text":text},"resume":false})),
    )
    .await?;
    if admitted.get("sessionID").and_then(Value::as_str) != Some(session_id) {
        return Err(Error::Invalid("OpenCode 未确认消息已进入执行队列".into()));
    }
    let id = admitted
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::Invalid("OpenCode 未确认消息已进入执行队列".into()))?
        .to_owned();
    if let Some(provider) = provider {
        wait_provider(client, base_url, workspace, provider).await?;
    }
    let _ = fetch_json::<Value>(
        client,
        format!("{base_url}/api/session/{}/prompt", url_encode(session_id)),
        "POST",
        Some(json!({"id":id,"prompt":{"text":text},"resume":true})),
    )
    .await?;
    Ok(())
}

fn models_from_catalog(value: &Value) -> Vec<LaunchModelInfo> {
    if let Some(items) = value.as_array() {
        return items
            .iter()
            .filter_map(|item| {
                let provider = item.get("providerID").and_then(Value::as_str)?;
                let model = item
                    .get("id")
                    .or_else(|| item.get("modelID"))
                    .and_then(Value::as_str)?;
                let id = format!("{provider}/{model}");
                Some(LaunchModelInfo {
                    id: id.clone(),
                    label: item
                        .get("name")
                        .or_else(|| item.get("label"))
                        .and_then(Value::as_str)
                        .unwrap_or(&id)
                        .chars()
                        .take(300)
                        .collect(),
                    description: None,
                    supported_efforts: Vec::new(),
                    default_effort: None,
                    is_default: false,
                })
            })
            .collect();
    }
    value
        .as_object()
        .into_iter()
        .flat_map(|providers| providers.iter())
        .flat_map(|(provider, payload)| {
            payload
                .get("models")
                .and_then(Value::as_object)
                .into_iter()
                .flat_map(move |models| {
                    models.iter().map(move |(model, value)| {
                        let id = format!("{provider}/{model}");
                        LaunchModelInfo {
                            id: id.clone(),
                            label: value
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or(&id)
                                .chars()
                                .take(300)
                                .collect(),
                            description: None,
                            supported_efforts: Vec::new(),
                            default_effort: None,
                            is_default: false,
                        }
                    })
                })
        })
        .collect()
}

pub(super) async fn launch_catalog(workspace: &Path) -> Result<LaunchModelCatalog> {
    let workspace = workspace
        .to_str()
        .ok_or_else(|| Error::Invalid("workspace must be Unicode".into()))?;
    let (mut child, port) = start_process(workspace, &[]).await?;
    let result = async {
        let client = reqwest::Client::new();
        let base_url = format!("http://127.0.0.1:{port}");
        wait_catalog(&client, &base_url, workspace, None).await?;
        let value = fetch_json::<Value>(
            &client,
            format!("{base_url}/api/model?{}", location_query(workspace)),
            "GET",
            None,
        )
        .await?;
        let mut models = models_from_catalog(&value);
        if models.is_empty() {
            return Err(Error::Invalid("OpenCode 没有返回可选模型".into()));
        }
        let current = default_model(&client, &base_url, workspace)
            .await?
            .map(|(provider, model)| format!("{provider}/{model}"));
        if let Some(current) = current.as_ref() {
            for model in &mut models {
                model.is_default = model.id == *current;
            }
        }
        Ok(LaunchModelCatalog {
            models,
            current_model: current,
            current_effort: None,
            presets: Vec::new(),
            current_preset: None,
        })
    }
    .await;
    cleanup_child(&mut child).await;
    result
}

impl OpencodeTurn {
    pub(super) fn take_events(&mut self) -> Option<mpsc::Receiver<AdapterEvent>> {
        self.events.take()
    }

    pub(super) async fn steer(&self, text: &str) -> Result<()> {
        send_prompt(
            &self.client,
            &self.base_url,
            &self.workspace,
            &self.session_id,
            self.isolated
                .then(|| {
                    self.model
                        .as_deref()
                        .and_then(|model| model.split_once('/').map(|value| value.0))
                })
                .flatten(),
            text,
        )
        .await
    }

    pub(super) async fn compact(&self) -> Result<()> {
        send_prompt(
            &self.client,
            &self.base_url,
            &self.workspace,
            &self.session_id,
            self.isolated
                .then(|| {
                    self.model
                        .as_deref()
                        .and_then(|model| model.split_once('/').map(|value| value.0))
                })
                .flatten(),
            "/compact",
        )
        .await
    }

    pub(super) async fn models(&self, workspace: &str) -> Result<AgentModelCatalog> {
        let value = fetch_json::<Value>(
            &self.client,
            format!("{}/api/model?{}", self.base_url, location_query(workspace)),
            "GET",
            None,
        )
        .await?;
        Ok(AgentModelCatalog {
            models: models_from_catalog(&value),
            current_model: self.model.clone(),
            current_effort: None,
        })
    }

    pub(super) async fn apply_selection(&mut self, model: &str) -> Result<()> {
        self.model = Some(model.to_owned());
        Ok(())
    }

    pub(super) fn interrupt(&self) {
        let client = self.client.clone();
        let base_url = self.base_url.clone();
        let session_id = self.session_id.clone();
        tokio::spawn(async move {
            let _ = fetch_json::<Value>(
                &client,
                format!("{base_url}/api/session/{session_id}/interrupt"),
                "POST",
                Some(json!({})),
            )
            .await;
        });
    }

    pub(super) fn kill(&self) {
        kill_process_group(self.child_pid);
    }
}

async fn cleanup_child(child: &mut Child) {
    let pid = child.id().unwrap_or(0);
    kill_process_group(pid);
    let _ = child.start_kill();
    let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
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

    #[test]
    fn maps_opencode_catalog_shapes() {
        let list = models_from_catalog(&json!([
            {"providerID":"openai","id":"gpt-5","name":"GPT 5"},
            {"providerID":"prospero","modelID":"chat-coder"}
        ]));
        assert_eq!(list[0].id, "openai/gpt-5");
        assert_eq!(list[0].label, "GPT 5");
        assert_eq!(list[1].id, "prospero/chat-coder");
        let grouped = models_from_catalog(&json!({
            "prospero": {"models": {"deep": {"name":"Deep"}}}
        }));
        assert_eq!(grouped[0].id, "prospero/deep");
        assert!(catalog_has_model(
            &json!({"prospero":{"models":{"deep":{}}}}),
            "prospero/deep"
        ));
    }

    #[tokio::test]
    async fn opencode_permission_reply_posts_to_native_endpoint() {
        use std::sync::{Arc, Mutex};

        type Capture = Arc<Mutex<Option<oneshot::Sender<(String, String, Value)>>>>;

        async fn capture(
            axum::extract::Path((sid, req_id)): axum::extract::Path<(String, String)>,
            axum::extract::State(sender): axum::extract::State<Capture>,
            axum::Json(body): axum::Json<Value>,
        ) -> axum::Json<Value> {
            if let Some(sender) = sender.lock().unwrap().take() {
                let _ = sender.send((sid, req_id, body));
            }
            axum::Json(json!({"ok":true}))
        }

        let (capture_tx, capture_rx) = oneshot::channel();
        let state = Arc::new(Mutex::new(Some(capture_tx)));
        let app = axum::Router::new()
            .route(
                "/api/session/{sid}/permission/{req_id}/reply",
                axum::routing::post(capture),
            )
            .with_state(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let client = reqwest::Client::new();
        let base_url = format!("http://{address}");
        let (events_tx, mut events_rx) = mpsc::channel(4);
        let mut tools = HashMap::new();
        let mut input = None;
        let mut output = None;
        let mut cost = None;
        assert!(
            !consume_event(
                EventContext {
                    events: &events_tx,
                    client: &client,
                    base_url: &base_url,
                    session_id: "session-1",
                    auto_approve: false,
                },
                &mut tools,
                &mut input,
                &mut output,
                &mut cost,
                json!({"type":"permission.v2.asked","data":{"sessionID":"session-1","id":"perm:1","action":"bash","resources":[{"cmd":"pwd"}]}}),
            )
            .await
        );

        let event = events_rx.recv().await.unwrap();
        let AdapterEvent::Permission {
            request_id, reply, ..
        } = event
        else {
            panic!("expected permission event");
        };
        assert!(request_id.starts_with("perm1-"));
        reply.send(true).unwrap();

        let (sid, req_id, body) = tokio::time::timeout(Duration::from_secs(3), capture_rx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(sid, "session-1");
        assert_eq!(req_id, "perm:1");
        assert_eq!(body["reply"], "once");
        server.abort();
    }

    #[tokio::test]
    async fn maps_opencode_events_to_adapter_events() {
        let client = reqwest::Client::new();
        let (tx, mut rx) = mpsc::channel(16);
        let mut tools = HashMap::new();
        let mut input = None;
        let mut output = None;
        let mut cost = None;

        assert!(
            !consume_event(
                EventContext {
                    events: &tx,
                    client: &client,
                    base_url: "http://127.0.0.1:9",
                    session_id: "s",
                    auto_approve: false,
                },
                &mut tools,
                &mut input,
                &mut output,
                &mut cost,
                json!({"type":"session.next.text.delta","data":{"sessionID":"s","assistantMessageID":"m","delta":"hello"}}),
            )
            .await
        );
        assert!(
            !consume_event(
                EventContext {
                    events: &tx,
                    client: &client,
                    base_url: "http://127.0.0.1:9",
                    session_id: "s",
                    auto_approve: false,
                },
                &mut tools,
                &mut input,
                &mut output,
                &mut cost,
                json!({"type":"session.next.tool.called","data":{"sessionID":"s","assistantMessageID":"m","callID":"call:1","tool":"bash","input":{"cmd":"pwd"}}}),
            )
            .await
        );
        assert!(
            !consume_event(
                EventContext {
                    events: &tx,
                    client: &client,
                    base_url: "http://127.0.0.1:9",
                    session_id: "s",
                    auto_approve: false,
                },
                &mut tools,
                &mut input,
                &mut output,
                &mut cost,
                json!({"type":"session.next.tool.success","data":{"sessionID":"s","callID":"call:1","content":"ok"}}),
            )
            .await
        );
        assert!(
            consume_event(
                EventContext {
                    events: &tx,
                    client: &client,
                    base_url: "http://127.0.0.1:9",
                    session_id: "s",
                    auto_approve: false,
                },
                &mut tools,
                &mut input,
                &mut output,
                &mut cost,
                json!({"type":"session.next.step.ended","data":{"sessionID":"s","assistantMessageID":"m","cost":0.25,"tokens":{"input":4,"output":6}}}),
            )
            .await
        );
        drop(tx);

        assert!(
            matches!(rx.recv().await.unwrap(), AdapterEvent::Text { text, .. } if text == "hello")
        );
        assert!(
            matches!(rx.recv().await.unwrap(), AdapterEvent::ToolCall { call_id, name, .. } if call_id == "call1" && name == "bash")
        );
        assert!(
            matches!(rx.recv().await.unwrap(), AdapterEvent::ToolResult { call_id, summary, error: false, .. } if call_id == "call1" && summary == "ok")
        );
        assert!(matches!(
            rx.recv().await.unwrap(),
            AdapterEvent::Finish {
                cost_usd: Some(0.25),
                input_tokens: Some(4),
                output_tokens: Some(6),
                error: None,
                ..
            }
        ));
    }
}
