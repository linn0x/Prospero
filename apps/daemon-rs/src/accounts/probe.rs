//! Real connectivity probe for an Anthropic-compatible API profile.
//!
//! Port of the legacy `probeApiProfile`, narrowed to the only protocol the
//! Rust daemon currently exposes (`anthropic`). The probe:
//! 1. confirms `claude --version` starts in a scrubbed, credential-free env;
//! 2. sends at most two SSE requests (never redirected, never retried);
//! 3. forces a single synthetic tool call with a nonce, then a second turn
//!    with the tool result and requires the exact receipt text back.
//!
//! No user files, shells, MCP servers or real tools are ever involved.

use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ts_rs::TS;

use super::profile::{ApiProfile, endpoint};

const TOOL_NAME: &str = "prospero_connection_probe";
const MAX_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_EVENTS: usize = 4096;
const SCOPE: &str = "此检查验证 CLI 可启动、直接 API 协议的流式响应与无副作用工具往返；尚未验证 Agent 引擎的完整执行路径。";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum Check {
    Passed,
    Failed,
    NotTested,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ValidationChecks {
    pub runtime: Check,
    pub streaming: Check,
    pub tools: Check,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct EngineValidationChecks {
    pub runtime: Check,
    pub configuration: Check,
    pub streaming: Check,
    pub tools: Check,
}

/// Legacy `AgentApiValidation` contract.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ApiValidation {
    pub status: String,
    #[ts(type = "number")]
    pub checked_at: i64,
    pub engine: String,
    pub checks: ValidationChecks,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    pub detail: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number")]
    pub latency_ms: Option<i64>,
}

/// Legacy `AgentApiEngineValidation` contract.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ApiEngineValidation {
    pub status: String,
    #[ts(type = "number")]
    pub checked_at: i64,
    pub engine: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cli_version: Option<String>,
    pub checks: EngineValidationChecks,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    pub detail: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number")]
    pub latency_ms: Option<i64>,
}

/// Revision over agent + profile + credential; a replaced connection or key
/// immediately invalidates any previously recorded validation.
pub(crate) fn revision(profile: &ApiProfile, secret: Option<&str>) -> String {
    let canonical = serde_json::json!({
        "agent": "claude",
        "profile": profile,
        "credential": secret,
    });
    let mut hasher = Sha256::new();
    hasher.update(canonical.to_string().as_bytes());
    let digest = hasher.finalize();
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn binary() -> String {
    std::env::var("PROSPERO_CLAUDE_BIN").unwrap_or_else(|_| "claude".into())
}

async fn runtime_version() -> std::result::Result<Option<String>, ProbeFailure> {
    let root =
        tempfile::tempdir().map_err(|_| fail("runtime_unavailable", "无法创建隔离运行目录。"))?;
    let config = root.path().join("config");
    std::fs::create_dir_all(&config)
        .map_err(|_| fail("runtime_unavailable", "无法创建隔离运行目录。"))?;
    let mut command = tokio::process::Command::new(binary());
    command
        .arg("--version")
        .current_dir(root.path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command.env_clear();
    for (key, value) in std::env::vars() {
        if ["PATH", "TMPDIR", "TMP", "TEMP"].contains(&key.as_str()) {
            command.env(key, value);
        }
    }
    command
        .env("HOME", root.path())
        .env("CLAUDE_CONFIG_DIR", &config)
        .env("CODEX_HOME", &config)
        .env("CODEX_SQLITE_HOME", &config);
    let output = tokio::time::timeout(Duration::from_secs(5), command.output())
        .await
        .map_err(|_| fail("runtime_unavailable", "Claude CLI 启动超时。"))?
        .map_err(|_| fail("runtime_unavailable", "无法启动 Claude CLI。"))?;
    if !output.status.success() {
        return Err(fail("runtime_unavailable", "Claude CLI 不可用。"));
    }
    let raw = String::from_utf8_lossy(&output.stdout);
    let version = raw
        .split_whitespace()
        .find(|part| part.chars().any(|c| c.is_ascii_digit()))
        .map(|value| value.chars().take(100).collect::<String>());
    Ok(version)
}

/// Runs `<claude> --version` with a scrubbed environment and isolated HOME.
/// Never inherits API credentials or the user's shell/agent configuration.
pub(crate) async fn runtime_available() -> bool {
    let root = match tempfile::tempdir() {
        Ok(dir) => dir,
        Err(_) => return false,
    };
    let config = root.path().join("config");
    let _ = std::fs::create_dir_all(&config);
    let mut command = tokio::process::Command::new(binary());
    command
        .arg("--version")
        .current_dir(root.path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command.env_clear();
    for (key, value) in std::env::vars() {
        if ["PATH", "TMPDIR", "TMP", "TEMP"].contains(&key.as_str()) {
            command.env(key, value);
        }
    }
    command
        .env("HOME", root.path())
        .env("CLAUDE_CONFIG_DIR", &config)
        .env("CODEX_HOME", &config)
        .env("CODEX_SQLITE_HOME", &config);
    let spawned = tokio::time::timeout(Duration::from_secs(5), command.output()).await;
    matches!(spawned, Ok(Ok(output)) if output.status.success())
}

#[derive(Debug)]
struct ProbeFailure {
    code: &'static str,
    message: &'static str,
}

fn fail(code: &'static str, message: &'static str) -> ProbeFailure {
    ProbeFailure { code, message }
}

fn upstream_failure(status: Option<u16>, code: Option<&str>) -> ProbeFailure {
    if matches!(status, Some(401) | Some(403))
        || matches!(
            code,
            Some("authentication_error" | "invalid_api_key" | "permission_error")
        )
    {
        return fail(
            "authentication_failed",
            "API 鉴权失败，请检查该 Profile 的 Key 和访问权限。",
        );
    }
    if matches!(status, Some(429) | Some(529))
        || matches!(
            code,
            Some(
                "rate_limit_error"
                    | "rate_limit_exceeded"
                    | "overloaded_error"
                    | "insufficient_quota"
            )
        )
    {
        return fail(
            "rate_limited",
            "API 限流、额度不足或暂时过载；没有自动重试。",
        );
    }
    if code == Some("model_not_found") {
        return fail("model_not_found", "API 无法使用配置的模型。");
    }
    if status == Some(404) {
        return fail("endpoint_or_model_not_found", "API 端点或模型不存在。");
    }
    fail("upstream_error", "API 返回错误；没有自动重试。")
}

#[derive(Default, Debug, Clone)]
struct ToolCall {
    id: String,
    name: String,
    arguments: String,
}

#[derive(Default, Debug)]
struct StreamResult {
    text: String,
    text_delta_seen: bool,
    calls: Vec<ToolCall>,
    /// Content blocks in index order for the follow-up request.
    blocks: Vec<serde_json::Value>,
}

/// Extracts data lines from one SSE event block.
fn sse_data(raw: &str) -> Option<String> {
    let data: String = raw
        .lines()
        .filter(|line| line.starts_with("data:"))
        .map(|line| line[5..].strip_prefix(' ').unwrap_or(&line[5..]))
        .collect::<Vec<_>>()
        .join("\n");
    if data.is_empty() { None } else { Some(data) }
}

struct Budget {
    bytes: usize,
    events: usize,
}

/// Parses one Anthropic SSE stream to completion, enforcing byte/event bounds.
async fn collect_stream(
    response: reqwest::Response,
) -> std::result::Result<StreamResult, ProbeFailure> {
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !content_type.starts_with("text/event-stream") {
        return Err(fail("streaming_unavailable", "API 没有返回 SSE 流式响应。"));
    }
    use futures_util::StreamExt;
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut result = StreamResult::default();
    let mut budget = Budget {
        bytes: 0,
        events: 0,
    };
    let mut message_started = false;
    let mut finish = String::new();
    let mut calls = std::collections::BTreeMap::<usize, ToolCall>::new();
    let mut closed: std::collections::BTreeSet<usize> = std::collections::BTreeSet::new();

    loop {
        let chunk = match stream.next().await {
            Some(Ok(chunk)) => chunk,
            Some(Err(_)) => return Err(fail("connection_failed", "无法读取 API 流式响应。")),
            None => break,
        };
        budget.bytes += chunk.len();
        if budget.bytes > MAX_RESPONSE_BYTES {
            return Err(fail(
                "response_too_large",
                "API 响应超出连接测试的大小上限。",
            ));
        }
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(separator) = buffer.find("\n\n").or_else(|| buffer.find("\r\n\r\n")) {
            let raw = buffer[..separator].to_owned();
            let delimiter = if buffer[separator..].starts_with("\r\n") {
                4
            } else {
                2
            };
            buffer.drain(..separator + delimiter);
            let Some(data) = sse_data(&raw) else { continue };
            budget.events += 1;
            if budget.events > MAX_EVENTS {
                return Err(fail(
                    "response_too_large",
                    "API 响应超出连接测试的事件上限。",
                ));
            }
            let event: serde_json::Value = serde_json::from_str(&data)
                .unwrap_or_else(|_| serde_json::json!({"type": "__invalid__"}));
            if !event.is_object() {
                return Err(fail("invalid_stream", "响应流格式无效或没有完整结束。"));
            }
            if event.get("type").and_then(|v| v.as_str()) == Some("__invalid__") {
                return Err(fail("invalid_stream", "响应流格式无效或没有完整结束。"));
            }
            if event.get("type").and_then(|v| v.as_str()) == Some("error") {
                let error = event.get("error");
                let code = error.and_then(|v| v.get("type")).and_then(|v| v.as_str());
                return Err(upstream_failure(None, code));
            }
            let kind = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
            match kind {
                "message_start" => {
                    let message = event.get("message");
                    let valid = message.and_then(|m| m.get("type")).and_then(|v| v.as_str())
                        == Some("message")
                        && message.and_then(|m| m.get("role")).and_then(|v| v.as_str())
                            == Some("assistant")
                        && message
                            .and_then(|m| m.get("id"))
                            .and_then(|v| v.as_str())
                            .is_some_and(|id| !id.is_empty());
                    if message_started || !valid {
                        return Err(fail("invalid_stream", "响应流格式无效或没有完整结束。"));
                    }
                    message_started = true;
                }
                "content_block_start" => {
                    let Some(index) = event.get("index").and_then(|v| v.as_u64()) else {
                        return Err(fail("invalid_stream", "响应流格式无效或没有完整结束。"));
                    };
                    if !message_started || calls.contains_key(&(index as usize)) {
                        return Err(fail("invalid_stream", "响应流格式无效或没有完整结束。"));
                    }
                    let block = event.get("content_block");
                    let block_type = block.and_then(|b| b.get("type")).and_then(|v| v.as_str());
                    match block_type {
                        Some("text") => {
                            let text = block
                                .and_then(|b| b.get("text"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            result.text.push_str(text);
                            if !text.is_empty() {
                                result.text_delta_seen = true;
                            }
                            calls.insert(index as usize, ToolCall::default());
                        }
                        Some("tool_use") => {
                            let id = block
                                .and_then(|b| b.get("id"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            let name = block
                                .and_then(|b| b.get("name"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            calls.insert(
                                index as usize,
                                ToolCall {
                                    id: id.into(),
                                    name: name.into(),
                                    arguments: String::new(),
                                },
                            );
                        }
                        _ => return Err(fail("invalid_stream", "响应流格式无效或没有完整结束。")),
                    }
                }
                "content_block_delta" => {
                    let Some(index) = event.get("index").and_then(|v| v.as_u64()) else {
                        return Err(fail("invalid_stream", "响应流格式无效或没有完整结束。"));
                    };
                    if closed.contains(&(index as usize)) {
                        return Err(fail("invalid_stream", "响应流格式无效或没有完整结束。"));
                    }
                    let delta = event.get("delta");
                    match delta.and_then(|d| d.get("type")).and_then(|v| v.as_str()) {
                        Some("text_delta") => {
                            let text = delta
                                .and_then(|d| d.get("text"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            result.text.push_str(text);
                            if !text.is_empty() {
                                result.text_delta_seen = true;
                            }
                        }
                        Some("input_json_delta") => {
                            let partial = delta
                                .and_then(|d| d.get("partial_json"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            let Some(call) = calls.get_mut(&(index as usize)) else {
                                return Err(fail(
                                    "invalid_stream",
                                    "响应流格式无效或没有完整结束。",
                                ));
                            };
                            call.arguments.push_str(partial);
                        }
                        _ => return Err(fail("invalid_stream", "响应流格式无效或没有完整结束。")),
                    }
                }
                "content_block_stop" => {
                    let Some(index) = event.get("index").and_then(|v| v.as_u64()) else {
                        return Err(fail("invalid_stream", "响应流格式无效或没有完整结束。"));
                    };
                    closed.insert(index as usize);
                }
                "message_delta" => {
                    if let Some(reason) = event
                        .get("delta")
                        .and_then(|d| d.get("stop_reason"))
                        .and_then(|v| v.as_str())
                    {
                        finish = reason.to_owned();
                    }
                }
                "message_stop" => {
                    if !message_started || closed.len() != calls.len() {
                        return Err(fail("invalid_stream", "响应流格式无效或没有完整结束。"));
                    }
                    let has_calls = calls.values().any(|call| !call.name.is_empty());
                    if !["tool_use", "end_turn"].contains(&finish.as_str())
                        || (has_calls && finish != "tool_use")
                    {
                        return Err(fail("incomplete_response", "API 在测试完成前停止了生成。"));
                    }
                    for call in calls.values() {
                        if call.name.is_empty() {
                            // Text block: synthesize the assistant text content.
                            result.blocks.push(serde_json::json!({
                                "type": "text",
                                "text": result.text,
                            }));
                        } else {
                            let input: serde_json::Value = if call.arguments.is_empty() {
                                serde_json::json!({})
                            } else {
                                serde_json::from_str(&call.arguments).map_err(|_| {
                                    fail(
                                        "tool_arguments_invalid",
                                        "API 返回的工具参数不是有效 JSON。",
                                    )
                                })?
                            };
                            result.blocks.push(serde_json::json!({
                                "type": "tool_use",
                                "id": call.id,
                                "name": call.name,
                                "input": input,
                            }));
                            result.calls.push(call.clone());
                        }
                    }
                    return Ok(result);
                }
                "ping" => {}
                _ => {}
            }
        }
    }
    Err(fail("invalid_stream", "响应流格式无效或没有完整结束。"))
}

fn request_body(
    profile: &ApiProfile,
    prompt: &str,
    nonce: &str,
    previous: Option<(&[serde_json::Value], &ToolCall, &str)>,
) -> serde_json::Value {
    let parameters = serde_json::json!({
        "type": "object",
        "properties": { "nonce": { "type": "string", "enum": [nonce] } },
        "required": ["nonce"],
        "additionalProperties": false,
    });
    let user = serde_json::json!({ "role": "user", "content": prompt });
    let max_tokens = profile
        .model_capabilities
        .as_ref()
        .and_then(|caps| caps.max_output_tokens)
        .unwrap_or(1024)
        .min(1024);
    match previous {
        None => serde_json::json!({
            "model": profile.model,
            "stream": true,
            "max_tokens": max_tokens,
            "tools": [{
                "name": TOOL_NAME,
                "description": "Return a verification receipt. This synthetic tool has no side effects.",
                "input_schema": parameters,
            }],
            "tool_choice": { "type": "tool", "name": TOOL_NAME },
            "messages": [user],
        }),
        Some((blocks, call, receipt)) => serde_json::json!({
            "model": profile.model,
            "stream": true,
            "max_tokens": max_tokens,
            "tools": [{
                "name": TOOL_NAME,
                "description": "Return a verification receipt. This synthetic tool has no side effects.",
                "input_schema": parameters,
            }],
            "tool_choice": "none",
            "messages": [
                user,
                { "role": "assistant", "content": blocks },
                {
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": call.id,
                        "content": receipt,
                    }],
                },
            ],
        }),
    }
}

fn client() -> std::result::Result<reqwest::Client, ProbeFailure> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| fail("connection_failed", "无法完成 API 连接测试，请检查网络。"))
}

/// Runs the full probe. Always returns a validation record; failures are
/// encoded as `status: failed` with a stable code, never propagated.
pub(crate) async fn probe(profile: &ApiProfile, secret: &str) -> ApiValidation {
    let started = std::time::Instant::now();
    let checked_at = crate::database::now();
    let mut checks = ValidationChecks {
        runtime: Check::NotTested,
        streaming: Check::NotTested,
        tools: Check::NotTested,
    };
    let run = async {
        if profile
            .model_capabilities
            .as_ref()
            .and_then(|caps| caps.tools)
            == Some(false)
        {
            return Err(fail(
                "tools_disabled",
                "该 Profile 已声明不支持工具调用，无法验证 Agent 工具往返。",
            ));
        }
        if secret.is_empty() || secret.contains(['\r', '\n', '\0']) {
            return Err(fail(
                "credential_missing",
                "API Profile 尚未配置有效的 Key。",
            ));
        }
        if !runtime_available().await {
            return Err(fail(
                "runtime_unavailable",
                "所需 Agent CLI 未安装或无法启动。",
            ));
        }
        checks.runtime = Check::Passed;
        let http = client()?;
        let url = endpoint(profile, "/v1/messages")
            .map_err(|_| fail("invalid_profile", "此账号没有有效的 API Profile。"))?;
        let nonce = uuid::Uuid::new_v4().to_string();
        let prompt = format!(
            "This is a connection test. Call {TOOL_NAME} exactly once with nonce {nonce}. \
             After receiving its result, reply with only the exact receipt string returned \
             by that tool. Do not call any other tools."
        );
        let send = |body: serde_json::Value| {
            let http = http.clone();
            let url = url.clone();
            let secret = secret.to_owned();
            let profile_headers = profile.headers.clone().unwrap_or_default();
            async move {
                let mut request = http
                    .post(url)
                    .header("content-type", "application/json")
                    .header("accept", "text/event-stream")
                    .header("x-api-key", secret)
                    .header("anthropic-version", "2023-06-01")
                    .json(&body);
                for (name, value) in &profile_headers {
                    request = request.header(name, value);
                }
                let response = request.send().await.map_err(|_| {
                    fail(
                        "connection_failed",
                        "无法完成 API 连接测试，请检查地址、网络和协议配置。",
                    )
                })?;
                if !response.status().is_success() {
                    let status = response.status().as_u16();
                    let code = response
                        .json::<serde_json::Value>()
                        .await
                        .ok()
                        .and_then(|body| {
                            body.get("error")
                                .and_then(|error| error.get("type"))
                                .and_then(|value| value.as_str())
                                .map(str::to_owned)
                        });
                    return Err(upstream_failure(Some(status), code.as_deref()));
                }
                collect_stream(response).await
            }
        };
        // First request: exactly one tool call with the nonce.
        let first = send(request_body(profile, &prompt, &nonce, None)).await?;
        checks.streaming = Check::Passed;
        if first.calls.len() != 1
            || first.calls[0].name != TOOL_NAME
            || first.calls[0].id.is_empty()
        {
            return Err(fail(
                "tool_call_invalid",
                "API 没有返回唯一且符合要求的测试工具调用。",
            ));
        }
        let call = first.calls[0].clone();
        let arguments: serde_json::Value =
            serde_json::from_str(&call.arguments).unwrap_or_else(|_| serde_json::json!({}));
        if arguments.get("nonce").and_then(|v| v.as_str()) != Some(nonce.as_str())
            || arguments.as_object().is_none_or(|object| object.len() != 1)
        {
            return Err(fail(
                "tool_arguments_invalid",
                "API 返回的测试工具参数不符合要求。",
            ));
        }
        let receipt = format!("prospero-ok-{}", uuid::Uuid::new_v4());
        // Second request: tool result consumed, receipt echoed, no more tools.
        let last = send(request_body(
            profile,
            &prompt,
            &nonce,
            Some((&first.blocks, &call, &receipt)),
        ))
        .await?;
        if !last.calls.is_empty() {
            return Err(fail(
                "unexpected_tool_call",
                "API 在工具结果回传后再次请求工具；测试已停止。",
            ));
        }
        if !last.text_delta_seen {
            checks.streaming = Check::Failed;
            return Err(fail("streaming_unavailable", "API 没有返回流式文本增量。"));
        }
        if last.text.trim() != receipt {
            return Err(fail(
                "tool_roundtrip_failed",
                "API 未正确返回工具结果，工具往返验证失败。",
            ));
        }
        checks.tools = Check::Passed;
        Ok(())
    };

    let outcome = tokio::time::timeout(Duration::from_secs(20), run).await;
    let latency_ms = started.elapsed().as_millis() as i64;
    let failure = match outcome {
        Ok(Ok(())) => {
            return ApiValidation {
                status: "passed".into(),
                checked_at,
                engine: "claude".into(),
                checks,
                code: None,
                detail: SCOPE.into(),
                latency_ms: Some(latency_ms),
            };
        }
        Ok(Err(failure)) => failure,
        Err(_) => fail("timeout", "连接测试超时，已停止且没有自动重试。"),
    };
    // Mirror the legacy phase marker: a runtime failure leaves later checks
    // untested; anything after that fails the current phase.
    if checks.runtime != Check::Failed {
        if checks.streaming != Check::Passed {
            checks.streaming = Check::Failed;
        } else if checks.tools != Check::Passed {
            checks.tools = Check::Failed;
        }
    }
    ApiValidation {
        status: "failed".into(),
        checked_at,
        engine: "claude".into(),
        checks,
        code: Some(failure.code.into()),
        detail: format!("{} {}", failure.message, SCOPE),
        latency_ms: Some(latency_ms),
    }
}

/// Conservative Rust slice of the legacy isolated engine validation.
///
/// This currently covers Claude API profiles: it verifies the native CLI can
/// start in a scrubbed directory, then reuses the side-effect-free protocol
/// gateway probe to validate the profile's configured model, streaming SSE and
/// synthetic tool round trip. It is persisted separately from the direct
/// protocol probe so future native engine adapters can strengthen the
/// configuration step without changing the wire contract.
pub(crate) async fn probe_engine(profile: &ApiProfile, secret: &str) -> ApiEngineValidation {
    let started = crate::database::now();
    let mut checks = EngineValidationChecks {
        runtime: Check::NotTested,
        configuration: Check::NotTested,
        streaming: Check::NotTested,
        tools: Check::NotTested,
    };
    match runtime_version().await {
        Ok(cli_version) => {
            checks.runtime = Check::Passed;
            if secret.trim().is_empty() {
                checks.configuration = Check::Failed;
                return ApiEngineValidation {
                    status: "failed".into(),
                    checked_at: crate::database::now(),
                    engine: "claude".into(),
                    cli_version,
                    checks,
                    code: Some("credential_missing".into()),
                    detail: "API Profile 尚未配置 Key。".into(),
                    latency_ms: Some(crate::database::now() - started),
                };
            }
            let validation = probe(profile, secret).await;
            checks.configuration = if validation.status == "passed" {
                Check::Passed
            } else {
                Check::Failed
            };
            checks.streaming = validation.checks.streaming;
            checks.tools = validation.checks.tools;
            if validation.status == "passed" {
                return ApiEngineValidation {
                    status: "passed".into(),
                    checked_at: crate::database::now(),
                    engine: "claude".into(),
                    cli_version,
                    checks,
                    code: None,
                    detail: "Claude CLI 可在隔离环境启动；Profile 的受控 API 连接完成流式响应与合成工具往返。".into(),
                    latency_ms: Some(crate::database::now() - started),
                };
            }
            ApiEngineValidation {
                status: "failed".into(),
                checked_at: crate::database::now(),
                engine: "claude".into(),
                cli_version,
                checks,
                code: validation.code,
                detail: format!("Agent 引擎验证未通过：{}", validation.detail),
                latency_ms: Some(crate::database::now() - started),
            }
        }
        Err(error) => {
            checks.runtime = Check::Failed;
            ApiEngineValidation {
                status: "failed".into(),
                checked_at: crate::database::now(),
                engine: "claude".into(),
                cli_version: None,
                checks,
                code: Some(error.code.into()),
                detail: error.message.into(),
                latency_ms: Some(crate::database::now() - started),
            }
        }
    }
}
