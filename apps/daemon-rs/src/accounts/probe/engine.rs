//! Isolated CLI engine validation. Model responses are checked in full before
//! the tool-capable CLI sees them; only the synthetic nonce/receipt tool runs.
use super::*;
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{Request, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::any,
};
use serde_json::{Value, json};
use std::{
    path::Path,
    sync::{Arc, Mutex},
};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

type Failure = (&'static str, &'static str);
type ProbeResult<T> = std::result::Result<T, Failure>;
const LIMIT: usize = 512 * 1024;
#[derive(Default)]
struct Progress {
    local: usize,
    models: usize,
    tools: usize,
    configured: bool,
    receipt: String,
    failure: Option<Failure>,
}
struct Context {
    executable: Option<String>,
    profile: ApiProfile,
    secret: String,
    token: String,
    nonce: String,
    tool: String,
    progress: Mutex<Progress>,
    failed: tokio::sync::Notify,
    cancelled: tokio::sync::watch::Sender<bool>,
}
impl Context {
    fn invoke(&self, name: &str, args: &Value) -> ProbeResult<String> {
        let mut p = self.progress.lock().unwrap();
        if name != self.tool
            || args.get("nonce").and_then(Value::as_str) != Some(&self.nonce)
            || args.as_object().is_none_or(|a| a.len() != 1)
            || p.tools != 0
        {
            return Err((
                "unexpected_tool_call",
                "引擎请求了测试范围以外的工具或参数。",
            ));
        }
        p.tools = 1;
        p.receipt = format!("PROSPERO-RECEIPT-{}", uuid::Uuid::new_v4());
        Ok(p.receipt.clone())
    }
    fn prompt(&self) -> String {
        format!(
            "Call the sole tool {} exactly once with nonce {}. Then reply only with its receipt, without other actions.",
            self.tool, self.nonce
        )
    }
    fn schema(&self) -> Value {
        json!({"type":"object","properties":{"nonce":{"type":"string","enum":[self.nonce]}},"required":["nonce"],"additionalProperties":false})
    }
    fn fail(&self, failure: Failure) {
        self.progress.lock().unwrap().failure.get_or_insert(failure);
        self.failed.notify_one();
    }
}
fn safe_stream(raw: &str, c: &Context) -> ProbeResult<()> {
    let mut complete = false;
    let mut names = std::collections::BTreeMap::<u64, String>::new();
    let check = |item: &Value, key: &str| -> ProbeResult<()> {
        let kind = item["type"].as_str().unwrap_or("");
        if kind.is_empty() {
            return Ok(());
        }
        if ![
            "function_call",
            "message",
            "reasoning",
            "tool_use",
            "text",
            "thinking",
            "redacted_thinking",
        ]
        .contains(&kind)
        {
            return Err(("unexpected_tool_call", "上游返回了测试范围以外的操作。"));
        }
        if ["function_call", "tool_use"].contains(&kind)
            && (item[key] != c.tool
                || item
                    .get("namespace")
                    .is_some_and(|value| !value.is_null() && value != ""))
        {
            return Err(("unexpected_tool_call", "上游请求了未允许的工具。"));
        }
        Ok(())
    };
    for frame in raw.replace("\r\n", "\n").split("\n\n") {
        let data = frame
            .lines()
            .filter_map(|l| l.strip_prefix("data:"))
            .map(str::trim_start)
            .collect::<Vec<_>>()
            .join("\n");
        if data.is_empty() {
            continue;
        }
        if data == "[DONE]" {
            complete |= c.profile.protocol() == "openai_chat_completions";
            continue;
        }
        let e: Value =
            serde_json::from_str(&data).map_err(|_| ("invalid_stream", "上游返回无效响应流。"))?;
        if e.get("error").is_some()
            || matches!(
                e["type"].as_str(),
                Some("error" | "response.failed" | "response.incomplete")
            )
        {
            return Err(("upstream_error", "上游未完成验证请求。"));
        }
        check(&e["item"], "name")?;
        check(&e["content_block"], "name")?;
        if let Some(choices) = e["choices"].as_array() {
            for choice in choices {
                let delta = &choice["delta"];
                if delta.get("function_call").is_some() {
                    return Err(("unexpected_tool_call", "上游返回未启用的工具格式。"));
                }
                if let Some(calls) = delta["tool_calls"].as_array() {
                    for call in calls {
                        names
                            .entry(call["index"].as_u64().unwrap_or(0))
                            .or_default()
                            .push_str(call["function"]["name"].as_str().unwrap_or(""));
                    }
                }
            }
        }
        if e["type"] == "response.completed" {
            if e["response"]["status"] != "completed" {
                return Err(("invalid_stream", "上游响应未正常结束。"));
            }
            if let Some(items) = e["response"]["output"].as_array() {
                for item in items {
                    check(item, "name")?;
                }
            }
            complete = true;
        }
        complete |= e["type"] == "message_stop";
    }
    if !complete {
        return Err(("invalid_stream", "响应流不完整。"));
    }
    if names.values().any(|name| name != &c.tool) {
        return Err(("unexpected_tool_call", "响应流包含未允许的工具。"));
    }
    Ok(())
}
async fn gateway(State(c): State<Arc<Context>>, request: Request) -> Response {
    let mut cancelled = c.cancelled.subscribe();
    tokio::select! {
        _ = cancelled.wait_for(|value| *value) => StatusCode::SERVICE_UNAVAILABLE.into_response(),
        result = gateway_inner(&c, request) => match result {
            Ok(response) => response,
            Err(error) => { c.fail(error); (StatusCode::BAD_REQUEST, axum::Json(json!({"error":{"type":"invalid_request_error","message":"Prospero engine probe stopped"}}))).into_response() }
        },
    }
}
struct ProbeServer {
    task: tokio::task::JoinHandle<()>,
    cancel: tokio::sync::watch::Sender<bool>,
}
impl Drop for ProbeServer {
    fn drop(&mut self) {
        self.cancel.send_replace(true);
        self.task.abort();
    }
}
async fn gateway_inner(c: &Context, request: Request) -> ProbeResult<Response> {
    {
        let mut p = c.progress.lock().unwrap();
        p.local += 1;
        if p.local > 20 {
            return Err(("request_limit", "引擎测试超过本地请求上限。"));
        }
    }
    if request.headers().contains_key("origin") {
        return Err(("configuration_mismatch", "拒绝浏览器调用测试服务。"));
    }
    let path = request.uri().path();
    let prefix = format!("/{}/", c.token);
    let path = path
        .strip_prefix(&prefix)
        .ok_or(("configuration_mismatch", "引擎未使用隔离地址。"))?;
    if request.method() == "HEAD" && path == "api/hello" {
        return Ok(StatusCode::OK.into_response());
    }
    if request.method() == "GET" && path == "mcp" {
        return Ok(StatusCode::METHOD_NOT_ALLOWED.into_response());
    }
    if request.method() != "POST" {
        return Err(("configuration_mismatch", "引擎访问了范围外的端点。"));
    }
    let mcp = path == "mcp";
    let protocol = c.profile.protocol();
    let wanted = match protocol {
        "anthropic" => "v1/messages",
        "openai_responses" => "v1/responses",
        _ => "v1/chat/completions",
    };
    if !mcp && path != wanted {
        return Err(("configuration_mismatch", "引擎模型端点不匹配。"));
    }
    if !mcp {
        let supplied = if protocol == "anthropic" {
            request
                .headers()
                .get("x-api-key")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_owned()
        } else {
            request
                .headers()
                .get("authorization")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .strip_prefix("Bearer ")
                .unwrap_or("")
                .to_owned()
        };
        if supplied != c.token {
            return Err(("configuration_mismatch", "引擎没有使用隔离凭据。"));
        }
    }
    let raw = to_bytes(request.into_body(), LIMIT)
        .await
        .map_err(|_| ("request_limit", "引擎请求过大。"))?;
    let mut body: Value =
        serde_json::from_slice(&raw).map_err(|_| ("invalid_request", "引擎请求不是 JSON。"))?;
    if mcp {
        let Some(id) = body.get("id") else {
            return Ok(StatusCode::ACCEPTED.into_response());
        };
        let result = match body["method"].as_str() {
            Some("initialize") => {
                json!({"protocolVersion":"2025-03-26","capabilities":{"tools":{}},"serverInfo":{"name":"prospero_probe","version":"1.0.0"}})
            }
            Some("tools/list") => {
                json!({"tools":[{"name":TOOL_NAME,"description":"Return a synthetic receipt without side effects.","inputSchema":c.schema()}]})
            }
            Some("tools/call") => {
                if body["params"]["name"] != TOOL_NAME {
                    return Err(("unexpected_tool_call", "未注册的测试工具。"));
                }
                json!({"content":[{"type":"text","text":c.invoke(&c.tool,&body["params"]["arguments"])?}]})
            }
            Some("ping") => json!({}),
            _ => return Err(("unexpected_tool_call", "引擎请求了范围外的 MCP 方法。")),
        };
        return Ok(axum::Json(json!({"jsonrpc":"2.0","id":id,"result":result})).into_response());
    }
    if body["model"] != c.profile.model || body["stream"] != true {
        return Err(("configuration_mismatch", "引擎没有使用指定模型与流式协议。"));
    }
    let tools = body["tools"]
        .as_array()
        .ok_or(("configuration_mismatch", "引擎没有声明测试工具。"))?;
    let name = |tool: &Value| {
        tool["name"]
            .as_str()
            .or(tool["function"]["name"].as_str())
            .unwrap_or("")
            .to_owned()
    };
    let allowed = |tool: &Value| -> bool {
        if name(tool) == c.tool {
            return true;
        }
        protocol == "openai_responses"
            && ((tool["type"] == "function" && tool["name"] == "request_user_input")
                || (tool["type"] == "namespace"
                    && tool["name"] == "skills"
                    && tool["tools"].as_array().is_some_and(|tools| {
                        tools
                            .iter()
                            .all(|t| matches!(t["name"].as_str(), Some("list" | "read")))
                    })))
    };
    if !tools.iter().any(|t| name(t) == c.tool) || tools.iter().any(|t| !allowed(t)) {
        return Err(("configuration_mismatch", "引擎没有正确限制测试工具。"));
    }
    {
        let mut p = c.progress.lock().unwrap();
        p.models += 1;
        if p.models > 2 {
            return Err(("request_limit", "验证最多允许两次模型请求。"));
        }
        if p.models == 2 && (p.tools != 1 || !String::from_utf8_lossy(&raw).contains(&p.receipt)) {
            return Err(("tool_roundtrip_failed", "引擎没有把测试工具结果送回模型。"));
        }
        p.configured = true;
    }
    let key = match protocol {
        "openai_responses" => "max_output_tokens",
        "openai_chat_completions" if body.get("max_completion_tokens").is_some() => {
            "max_completion_tokens"
        }
        _ => "max_tokens",
    };
    body[key] = json!(
        c.profile
            .model_capabilities
            .as_ref()
            .and_then(|caps| caps.max_output_tokens)
            .unwrap_or(1024)
            .min(1024)
    );
    let suffix = match protocol {
        "anthropic" => "v1/messages",
        "openai_responses" => "responses",
        _ => "chat/completions",
    };
    let url =
        endpoint(&c.profile, suffix).map_err(|_| ("invalid_profile", "API Profile 地址无效。"))?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| ("connection_failed", "无法初始化受控连接。"))?;
    let mut call = client.post(url).header("content-type", "application/json");
    for (key, value) in c.profile.headers.iter().flatten() {
        call = call.header(key, value);
    }
    call = if protocol == "anthropic" {
        call.header("x-api-key", &c.secret)
            .header("anthropic-version", "2023-06-01")
    } else {
        call.bearer_auth(&c.secret)
    };
    let mut response = call
        .json(&body)
        .send()
        .await
        .map_err(|_| ("connection_failed", "受控模型请求失败。"))?;
    if !response.status().is_success() {
        return Err((
            if matches!(response.status().as_u16(), 401 | 403) {
                "authentication_failed"
            } else {
                "connection_failed"
            },
            "模型请求未通过验证。",
        ));
    }
    if !response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("text/event-stream"))
    {
        return Err(("invalid_stream", "上游未返回 SSE 响应。"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| ("invalid_stream", "读取响应流失败。"))?
    {
        if bytes.len() + chunk.len() > LIMIT {
            return Err(("response_limit", "响应流超过验证上限。"));
        }
        bytes.extend_from_slice(&chunk);
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| ("invalid_stream", "响应编码无效。"))?;
    safe_stream(text, c)?;
    Ok((
        [(header::CONTENT_TYPE, "text/event-stream")],
        Body::from(bytes),
    )
        .into_response())
}

fn environment(command: &mut tokio::process::Command, root: &Path) -> ProbeResult<()> {
    command.env_clear();
    for key in [
        "PATH",
        "PATHEXT",
        "SystemRoot",
        "SYSTEMROOT",
        "WINDIR",
        "COMSPEC",
        "ComSpec",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    for (key, dir) in [
        ("HOME", "."),
        ("USERPROFILE", "."),
        ("XDG_CONFIG_HOME", "config"),
        ("XDG_DATA_HOME", "data"),
        ("XDG_CACHE_HOME", "cache"),
        ("XDG_STATE_HOME", "state"),
        ("TMPDIR", "tmp"),
        ("TMP", "tmp"),
        ("TEMP", "tmp"),
        ("CODEX_HOME", "codex"),
        ("CODEX_SQLITE_HOME", "codex"),
        ("CLAUDE_CONFIG_DIR", "claude"),
    ] {
        let path = root.join(dir);
        std::fs::create_dir_all(&path)
            .map_err(|_| ("runtime_unavailable", "无法准备隔离目录。"))?;
        command.env(key, path);
    }
    for key in [
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
        "DISABLE_TELEMETRY",
        "DISABLE_ERROR_REPORTING",
        "DISABLE_AUTOUPDATER",
        "OPENCODE_DISABLE_AUTOUPDATE",
        "OPENCODE_DISABLE_PROJECT_CONFIG",
        "OPENCODE_DISABLE_MODELS_FETCH",
        "OPENCODE_DISABLE_DEFAULT_PLUGINS",
    ] {
        command.env(key, "1");
    }
    command
        .env("ENABLE_TOOL_SEARCH", "false")
        .env("MCP_TOOL_TIMEOUT", "1000")
        .env("NO_PROXY", "127.0.0.1,localhost")
        .env("no_proxy", "127.0.0.1,localhost");
    Ok(())
}
pub(super) struct ProcessGroup {
    #[cfg(unix)]
    pid: u32,
    #[cfg(windows)]
    job: isize,
}
impl ProcessGroup {
    pub(super) fn new(child: &tokio::process::Child) -> std::io::Result<Self> {
        #[cfg(unix)]
        {
            Ok(Self {
                pid: child
                    .id()
                    .ok_or_else(|| std::io::Error::other("missing child PID"))?,
            })
        }
        #[cfg(windows)]
        {
            use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
            use windows_sys::Win32::System::JobObjects::*;
            let process = child
                .raw_handle()
                .ok_or_else(|| std::io::Error::other("missing child handle"))?;
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() || job == INVALID_HANDLE_VALUE {
                    return Err(std::io::Error::last_os_error());
                }
                let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    std::mem::size_of_val(&limits) as u32,
                ) == 0
                    || AssignProcessToJobObject(job, process.cast()) == 0
                {
                    let error = std::io::Error::last_os_error();
                    CloseHandle(job);
                    return Err(error);
                }
                Ok(Self { job: job as isize })
            }
        }
    }
}
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        #[cfg(unix)]
        unsafe {
            libc::kill(-(self.pid as i32), libc::SIGKILL);
        }
        #[cfg(windows)]
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(
                self.job as windows_sys::Win32::Foundation::HANDLE,
            );
        }
    }
}
async fn send(stdin: &mut tokio::process::ChildStdin, body: Value) -> ProbeResult<()> {
    let mut bytes = serde_json::to_vec(&body).unwrap();
    bytes.push(b'\n');
    stdin
        .write_all(&bytes)
        .await
        .map_err(|_| ("runtime_closed", "引擎控制管道已关闭。"))
}
async fn run_cli(c: Arc<Context>, root: &Path, base: &str) -> ProbeResult<(String, bool)> {
    let protocol = c.profile.protocol();
    let mut command =
        tokio::process::Command::new(c.executable.clone().unwrap_or_else(|| match protocol {
            "anthropic" => binary(),
            "openai_responses" => codex_binary(),
            _ => opencode_binary(),
        }));
    environment(&mut command, root)?;
    let cwd = root.join("workspace");
    std::fs::create_dir_all(&cwd).map_err(|_| ("runtime_unavailable", "无法创建验证工作区。"))?;
    let api = if protocol == "anthropic" {
        base.to_owned()
    } else {
        format!("{base}/v1")
    };
    if protocol == "anthropic" {
        let caps = c.profile.model_capabilities.as_ref();
        command.env(
            "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
            caps.and_then(|caps| caps.max_output_tokens)
                .unwrap_or(1024)
                .min(1024)
                .to_string(),
        );
        if let Some(context) = caps.and_then(|caps| caps.context_window) {
            command.env("CLAUDE_CODE_MAX_CONTEXT_TOKENS", context.to_string());
        }
        if caps.and_then(|caps| caps.reasoning) == Some(false) {
            command.env("MAX_THINKING_TOKENS", "0");
        }
        command
            .env("ANTHROPIC_API_KEY", &c.token)
            .env("ANTHROPIC_BASE_URL", &api)
            .env("ANTHROPIC_MODEL", &c.profile.model);
        let config = root.join("mcp.json");
        std::fs::write(
            &config,
            json!({"mcpServers":{"prospero_probe":{"type":"http","url":format!("{base}/mcp")}}})
                .to_string(),
        )
        .map_err(|_| ("runtime_unavailable", "无法准备 MCP 测试配置。"))?;
        command
            .args([
                "-p",
                "--output-format",
                "stream-json",
                "--verbose",
                "--include-partial-messages",
                "--tools",
                "",
                "--allowedTools",
                &c.tool,
                "--strict-mcp-config",
                "--mcp-config",
            ])
            .arg(config)
            .args([
                "--permission-mode",
                "dontAsk",
                "--setting-sources",
                "",
                "--no-session-persistence",
                "--bare",
                "--system-prompt",
                "Use only the registered synthetic probe tool in this isolated connection test.",
                "--disable-slash-commands",
                "--max-turns",
                "2",
                "--model",
                &c.profile.model,
            ])
            .arg(c.prompt());
    } else if protocol == "openai_responses" {
        command.env("OPENAI_API_KEY", &c.token).arg("app-server");
        let mut config = json!({"model":c.profile.model,"model_provider":"prospero_probe","model_providers.prospero_probe.name":"Prospero engine probe","model_providers.prospero_probe.base_url":api,"model_providers.prospero_probe.env_key":"OPENAI_API_KEY","model_providers.prospero_probe.wire_api":"responses","model_providers.prospero_probe.requires_openai_auth":false,"model_providers.prospero_probe.request_max_retries":0,"model_providers.prospero_probe.stream_max_retries":0,"web_search":"disabled","check_for_update_on_startup":false});
        for key in [
            "features.shell_tool",
            "features.unified_exec",
            "features.multi_agent",
            "features.skill_search",
            "features.skill_mcp_dependency_install",
            "features.plugins",
            "features.apps",
            "features.hooks",
            "features.memories",
            "features.shell_snapshot",
            "features.browser_use",
            "features.computer_use",
            "features.image_generation",
            "features.code_mode",
            "features.tool_suggest",
            "features.goals",
            "features.unbounded_connection_retries",
            "features.request_permissions_tool",
            "features.enable_request_compression",
            "tools.view_image",
            "analytics.enabled",
            "feedback.enabled",
        ] {
            config[key] = json!(false);
        }
        config["features.skip_host_skill_discovery"] = json!(true);
        if let Some(context) = c
            .profile
            .model_capabilities
            .as_ref()
            .and_then(|caps| caps.context_window)
        {
            config["model_context_window"] = json!(context);
        }
        if c.profile
            .model_capabilities
            .as_ref()
            .and_then(|caps| caps.reasoning)
            == Some(false)
        {
            config["model_supports_reasoning_summaries"] = json!(false);
            config["model_reasoning_summary"] = json!("none");
        }

        for (key, value) in config.as_object().unwrap() {
            command.arg("-c").arg(format!("{key}={value}"));
        }
    } else {
        command.env("OPENAI_API_KEY", &c.token);
        let file = root.join("opencode.json");
        let model = format!("prospero_probe/{}", c.profile.model);
        let mut config = json!({"$schema":"https://opencode.ai/config.json","model":model,"small_model":model,"autoupdate":false,"share":"disabled","plugin":[],"permission":{"*":"deny","prospero_probe_*":"allow"},"provider":{"prospero_probe":{"npm":"@ai-sdk/openai-compatible","name":"Prospero engine probe","env":["OPENAI_API_KEY"],"options":{"baseURL":api},"models":{}}},"mcp":{"prospero_probe":{"type":"remote","url":format!("{base}/mcp"),"oauth":false,"enabled":true}},"agent":{"prospero_probe":{"mode":"primary","description":"Isolated synthetic probe","prompt":"Use only the synthetic probe tool.","permission":{"*":"deny","prospero_probe_*":"allow"}}}});
        config["provider"]["prospero_probe"]["models"][&c.profile.model] = json!({"name":c.profile.model,"tool_call":true,"limit":{"context":c.profile.model_capabilities.as_ref().and_then(|caps|caps.context_window).unwrap_or(32000),"output":c.profile.model_capabilities.as_ref().and_then(|caps|caps.max_output_tokens).unwrap_or(1024).min(1024)}});
        std::fs::write(&file, config.to_string())
            .map_err(|_| ("runtime_unavailable", "无法准备引擎配置。"))?;
        command
            .env("OPENCODE_CONFIG", file)
            .args([
                "run",
                "--pure",
                "--format",
                "json",
                "--model",
                &model,
                "--agent",
                "prospero_probe",
                "--title",
                "Prospero engine probe",
            ])
            .arg(c.prompt());
    }
    command
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command
        .spawn()
        .map_err(|_| ("runtime_unavailable", "无法启动隔离 Agent 引擎。"))?;
    let _group = ProcessGroup::new(&child)
        .map_err(|_| ("runtime_unavailable", "无法建立引擎进程所有权。"))?;
    let mut stdin = child.stdin.take();
    if protocol == "openai_responses" {
        send(stdin.as_mut().unwrap(),json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"prospero_engine_probe","version":"1.0.0"},"capabilities":{"experimentalApi":true}}})).await?;
    } else {
        drop(stdin.take());
    }
    let stderr = child.stderr.take().unwrap();
    let progress = c.clone();
    let errors = tokio::spawn(async move {
        let mut bytes = Vec::new();
        let _ = stderr
            .take((LIMIT * 2 + 1) as u64)
            .read_to_end(&mut bytes)
            .await;
        if bytes.len() > LIMIT * 2 {
            progress.fail(("runtime_output_limit", "引擎输出超过上限。"));
        }
    });
    let mut lines =
        BufReader::new(child.stdout.take().unwrap().take((LIMIT * 2 + 1) as u64)).lines();
    let mut size = 0;
    let mut text = String::new();
    let mut delta = false;
    let mut finished = false;
    let mut initialized = protocol != "anthropic";
    while let Some(line) = lines
        .next_line()
        .await
        .map_err(|_| ("runtime_protocol_error", "引擎输出读取失败。"))?
    {
        size += line.len() + 1;
        if size > LIMIT * 2 {
            return Err(("runtime_output_limit", "引擎输出超过上限。"));
        }
        let event: Value = serde_json::from_str(&line)
            .map_err(|_| ("runtime_protocol_error", "引擎返回无效 JSON。"))?;
        if protocol == "openai_responses" {
            let params = &event["params"];
            if event.get("error").is_some() {
                return Err(("engine_turn_failed", "引擎未完成验证轮次。"));
            }
            match event["id"].as_u64() {
                Some(1) if event.get("method").is_none() => {
                    if let Some(home) = event["result"]["codexHome"]
                        .as_str()
                        .filter(|home| !home.is_empty())
                        && std::fs::canonicalize(home).ok()
                            != std::fs::canonicalize(root.join("codex")).ok()
                    {
                        return Err(("configuration_mismatch", "Codex 未使用隔离配置目录。"));
                    }
                    send(
                        stdin.as_mut().unwrap(),
                        json!({"method":"initialized","params":{}}),
                    )
                    .await?;
                    send(stdin.as_mut().unwrap(),json!({"id":2,"method":"thread/start","params":{"cwd":cwd,"model":c.profile.model,"modelProvider":"prospero_probe","sandbox":"read-only","approvalPolicy":"never","ephemeral":true,"environments":[],"baseInstructions":"Use only the registered synthetic probe tool.","dynamicTools":[{"type":"function","name":TOOL_NAME,"description":"Return a synthetic receipt without side effects.","inputSchema":c.schema()}]}})).await?;
                }
                Some(2) if event.get("method").is_none() => {
                    let result = &event["result"];
                    if result["model"] != c.profile.model
                        || result["thread"]["id"].as_str().is_none()
                    {
                        return Err(("configuration_mismatch", "Codex 未载入指定模型。"));
                    }
                    send(stdin.as_mut().unwrap(),json!({"id":3,"method":"turn/start","params":{"threadId":result["thread"]["id"],"input":[{"type":"text","text":c.prompt()}]}})).await?;
                }
                _ => {}
            }
            if event.get("id").is_some() && event.get("method").is_some() {
                if event["method"] != "item/tool/call" {
                    return Err(("unexpected_tool_call", "Codex 请求了验证范围外的操作。"));
                }
                let receipt =
                    c.invoke(params["tool"].as_str().unwrap_or(""), &params["arguments"])?;
                send(stdin.as_mut().unwrap(),json!({"id":event["id"],"result":{"success":true,"contentItems":[{"type":"inputText","text":receipt}]}})).await?;
            }
            if event["method"] == "item/agentMessage/delta" {
                let t = params["delta"].as_str().unwrap_or("");
                text.push_str(t);
                delta |= !t.is_empty();
            }
            if event["method"] == "turn/completed" {
                finished = params["turn"]["status"] == "completed";
                break;
            }
        } else if protocol == "anthropic" {
            if event["type"] == "system" && event["subtype"] == "init" {
                let cwd_matches = event["cwd"].as_str().is_some_and(|path| {
                    std::fs::canonicalize(path).ok() == std::fs::canonicalize(&cwd).ok()
                });
                if !cwd_matches
                    || event["model"] != c.profile.model
                    || event["tools"]
                        .as_array()
                        .is_none_or(|tools| tools.iter().any(|tool| tool.as_str() != Some(&c.tool)))
                    || event["plugins"].as_array().is_some_and(|v| !v.is_empty())
                    || event["skills"].as_array().is_some_and(|v| !v.is_empty())
                {
                    return Err((
                        "configuration_mismatch",
                        "Claude 未使用预期的隔离工作区、模型和工具配置。",
                    ));
                }
                initialized = true;
            }
            if event["type"] == "stream_event" && event["event"]["delta"]["type"] == "text_delta" {
                let t = event["event"]["delta"]["text"].as_str().unwrap_or("");
                text.push_str(t);
                delta |= !t.is_empty();
            }
            if event["type"] == "result" {
                finished = event["is_error"] != true && event["subtype"] == "success";
                break;
            }
        } else {
            if event["type"] == "text" {
                let t = event["part"]["text"].as_str().unwrap_or("");
                text.push_str(t);
                delta |= !t.is_empty();
            }
            if event["type"] == "error" {
                return Err(("engine_turn_failed", "OpenCode 引擎验证失败。"));
            }
        }
    }
    if protocol == "openai_chat_completions" {
        finished = child.wait().await.is_ok_and(|s| s.success());
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
    errors.abort();
    if !finished || !initialized {
        return Err(("runtime_closed", "引擎在验证完成前退出。"));
    }
    Ok((text, delta))
}

pub(super) async fn probe(profile: &ApiProfile, secret: &str) -> ApiEngineValidation {
    probe_binary(profile, secret, None).await
}

async fn probe_binary(
    profile: &ApiProfile,
    secret: &str,
    executable: Option<String>,
) -> ApiEngineValidation {
    let started = crate::database::now();
    let engine = super::super::profile::agent_kind(profile);
    let label = engine_label(engine);
    let mut checks = EngineValidationChecks {
        runtime: Check::NotTested,
        configuration: Check::NotTested,
        streaming: Check::NotTested,
        tools: Check::NotTested,
    };
    let version = if let Some(binary) = &executable {
        command_version(label, binary.clone(), &[]).await
    } else {
        engine_runtime_version(engine).await
    };
    if version.is_ok() {
        checks.runtime = Check::Passed;
    } else {
        checks.runtime = Check::Failed;
    }
    let version = match version {
        Ok(v) => v,
        Err(e) => {
            return ApiEngineValidation {
                status: "failed".into(),
                checked_at: crate::database::now(),
                engine: label.into(),
                cli_version: None,
                checks,
                code: Some(e.code.into()),
                detail: e.message.into(),
                latency_ms: Some(crate::database::now() - started),
            };
        }
    };
    let tool = match profile.protocol() {
        "anthropic" => format!("mcp__prospero_probe__{TOOL_NAME}"),
        "openai_responses" => TOOL_NAME.into(),
        _ => format!("prospero_probe_{TOOL_NAME}"),
    };
    let c = Arc::new(Context {
        executable,
        profile: profile.clone(),
        secret: secret.into(),
        token: uuid::Uuid::new_v4().to_string(),
        nonce: uuid::Uuid::new_v4().to_string(),
        tool,
        progress: Mutex::new(Progress::default()),
        failed: tokio::sync::Notify::new(),
        cancelled: tokio::sync::watch::channel(false).0,
    });
    let outcome = async {
        if secret.is_empty() { return Err(("credential_missing", "Profile 尚未配置 Key。")); }
        let root = tempfile::tempdir().map_err(|_| ("runtime_unavailable", "无法创建隔离目录。"))?;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|_| ("connection_failed", "无法创建本地验证连接。"))?;
        let base = format!("http://127.0.0.1:{}/{}", listener.local_addr().unwrap().port(), c.token);
        let router = Router::new().fallback(any(gateway)).with_state(c.clone());
        let server = ProbeServer { cancel: c.cancelled.clone(), task: tokio::spawn(async move {
            let _ = axum::serve(crate::transport::LimitedListener::new(listener), router).await;
        }) };
        let result = tokio::select! {
            result = tokio::time::timeout(Duration::from_secs(45), run_cli(c.clone(), root.path(), &base)) => result.unwrap_or(Err(("timeout", "引擎验证超时，未自动重试。"))),
            _ = c.failed.notified() => Err(c.progress.lock().unwrap().failure.unwrap_or(("engine_turn_failed", "引擎验证失败。"))),
        };
        drop(server);
        result
    }.await;
    let p = c.progress.lock().unwrap();
    checks.configuration = if p.configured {
        Check::Passed
    } else {
        Check::Failed
    };
    let (status, code, detail) = match outcome {
        Ok((text, delta))
            if p.models == 2
                && p.tools == 1
                && !p.receipt.is_empty()
                && text.trim() == p.receipt
                && delta =>
        {
            checks.streaming = Check::Passed;
            checks.tools = Check::Passed;
            (
                "passed",
                None,
                "隔离 CLI 已使用指定模型完成流式响应与无副作用测试工具往返。",
            )
        }
        Ok(_) => {
            checks.streaming = Check::Failed;
            checks.tools = Check::Failed;
            (
                "failed",
                Some("tool_roundtrip_failed"),
                "引擎没有完成流式响应和测试工具回执验证。",
            )
        }
        Err(error) => {
            let (code, detail) = p.failure.unwrap_or(error);
            ("failed", Some(code), detail)
        }
    };
    ApiEngineValidation {
        status: status.into(),
        checked_at: crate::database::now(),
        engine: label.into(),
        cli_version: version,
        checks,
        code: code.map(str::to_owned),
        detail: detail.into(),
        latency_ms: Some(crate::database::now() - started),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    #[derive(Clone)]
    struct Fake {
        protocol: &'static str,
        unsafe_tool: bool,
        wrong_receipt: bool,
        requests: Arc<AtomicUsize>,
    }
    fn receipt(v: &Value) -> Option<String> {
        match v {
            Value::String(s) if s.starts_with("PROSPERO-RECEIPT-") => Some(s.clone()),
            Value::Array(a) => a.iter().find_map(receipt),
            Value::Object(m) => m.values().find_map(receipt),
            _ => None,
        }
    }
    async fn upstream(
        State(f): State<Fake>,
        headers: axum::http::HeaderMap,
        axum::Json(body): axum::Json<Value>,
    ) -> Response {
        f.requests.fetch_add(1, Ordering::SeqCst);
        assert_eq!(
            headers
                .get(if f.protocol == "anthropic" {
                    "x-api-key"
                } else {
                    "authorization"
                })
                .unwrap(),
            if f.protocol == "anthropic" {
                "test-secret"
            } else {
                "Bearer test-secret"
            }
        );
        let tool = body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| {
                tool["name"]
                    .as_str()
                    .or(tool["function"]["name"].as_str())
                    .is_some_and(|name| name.ends_with(TOOL_NAME))
            })
            .unwrap();
        let name = if f.unsafe_tool {
            "unapproved_shell"
        } else {
            tool["name"]
                .as_str()
                .or(tool["function"]["name"].as_str())
                .unwrap()
        };
        let schema = if f.protocol == "anthropic" {
            &tool["input_schema"]
        } else if f.protocol == "openai_responses" {
            &tool["parameters"]
        } else {
            &tool["function"]["parameters"]
        };
        let args = json!({"nonce":schema["properties"]["nonce"]["enum"][0]}).to_string();
        let echoed = receipt(&body).map(|text| {
            if f.wrong_receipt {
                "wrong-receipt".into()
            } else {
                text
            }
        });
        let frames = match f.protocol {
            "anthropic" => {
                let is_text = echoed.is_some();
                let block = if is_text {
                    json!({"type":"text","text":""})
                } else {
                    json!({"type":"tool_use","id":"tool-1","name":name,"input":{}})
                };
                let delta = if let Some(text) = echoed {
                    json!({"type":"text_delta","text":text})
                } else {
                    json!({"type":"input_json_delta","partial_json":args})
                };
                vec![
                    json!({"type":"message_start","message":{"type":"message","id":"msg-probe","role":"assistant","model":body["model"],"content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}),
                    json!({"type":"content_block_start","index":0,"content_block":block}),
                    json!({"type":"content_block_delta","index":0,"delta":delta}),
                    json!({"type":"content_block_stop","index":0}),
                    json!({"type":"message_delta","delta":{"stop_reason":if is_text {"end_turn"} else {"tool_use"},"stop_sequence":null},"usage":{"output_tokens":1}}),
                    json!({"type":"message_stop"}),
                ]
            }
            "openai_responses" => {
                let response = |output: Value| json!({"id":"resp-probe","object":"response","created_at":1,"status":"completed","model":body["model"],"output":output,"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}});
                if let Some(text) = echoed {
                    let part = json!({"type":"output_text","text":text,"annotations":[]});
                    let message = json!({"id":"msg-probe","type":"message","role":"assistant","status":"completed","content":[part]});
                    vec![
                        json!({"type":"response.created","response":{"id":"resp-probe","status":"in_progress","output":[]}}),
                        json!({"type":"response.output_item.added","output_index":0,"item":{"id":"msg-probe","type":"message","role":"assistant","status":"in_progress","content":[]}}),
                        json!({"type":"response.content_part.added","output_index":0,"item_id":"msg-probe","content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}),
                        json!({"type":"response.output_text.delta","output_index":0,"item_id":"msg-probe","content_index":0,"delta":text}),
                        json!({"type":"response.output_text.done","output_index":0,"item_id":"msg-probe","content_index":0,"text":text}),
                        json!({"type":"response.content_part.done","output_index":0,"item_id":"msg-probe","content_index":0,"part":part}),
                        json!({"type":"response.output_item.done","output_index":0,"item":message}),
                        json!({"type":"response.completed","response":response(json!([message]))}),
                    ]
                } else {
                    let call = json!({"id":"fc-probe","type":"function_call","call_id":"call-probe","name":name,"arguments":args,"status":"completed"});
                    vec![
                        json!({"type":"response.created","response":{"id":"resp-probe","status":"in_progress","output":[]}}),
                        json!({"type":"response.output_item.added","output_index":0,"item":{"id":"fc-probe","type":"function_call","call_id":"call-probe","name":name,"arguments":"","status":"in_progress"}}),
                        json!({"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc-probe","delta":args}),
                        json!({"type":"response.function_call_arguments.done","output_index":0,"item_id":"fc-probe","arguments":args}),
                        json!({"type":"response.output_item.done","output_index":0,"item":call}),
                        json!({"type":"response.completed","response":response(json!([call]))}),
                    ]
                }
            }
            _ => {
                if let Some(text) = echoed {
                    vec![json!({"choices":[{"delta":{"content":text}}]})]
                } else {
                    vec![
                        json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":name,"arguments":args}}]}}]}),
                    ]
                }
            }
        };
        let mut raw = frames
            .iter()
            .map(|event| {
                if let Some(kind) = event["type"].as_str() {
                    format!("event: {kind}\ndata: {event}\n\n")
                } else {
                    format!("data: {event}\n\n")
                }
            })
            .collect::<String>();
        if f.protocol == "openai_chat_completions" {
            raw.push_str("data: [DONE]\n\n");
        }
        ([(header::CONTENT_TYPE, "text/event-stream")], raw).into_response()
    }
    async fn exercise(protocol: &'static str, unsafe_tool: bool) -> ApiEngineValidation {
        exercise_binary(protocol, unsafe_tool, None, false).await
    }
    async fn exercise_binary(
        protocol: &'static str,
        unsafe_tool: bool,
        executable: Option<String>,
        wrong_receipt: bool,
    ) -> ApiEngineValidation {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let cli = root.path().join("engine.py");
        std::fs::write(
            &cli,
            include_str!("../../../tests/fixtures/engine_probe_cli.py"),
        )
        .unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let requests = Arc::new(AtomicUsize::new(0));
        let fake = Fake {
            protocol,
            unsafe_tool,
            wrong_receipt,
            requests: requests.clone(),
        };
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().fallback(any(upstream)).with_state(fake),
            )
            .await
            .unwrap();
        });
        let profile = ApiProfile {
            provider: if protocol == "anthropic" {
                "anthropic_compatible"
            } else {
                "openai_compatible"
            }
            .into(),
            protocol: Some(protocol.into()),
            base_url: format!(
                "http://127.0.0.1:{port}{}",
                if protocol == "anthropic" { "" } else { "/v1" }
            ),
            model: "test-model".into(),
            model_capabilities: None,
            headers: None,
        };
        let result = probe_binary(
            &profile,
            "test-secret",
            Some(executable.unwrap_or_else(|| cli.to_string_lossy().into_owned())),
        )
        .await;
        server.abort();
        assert_eq!(
            requests.load(Ordering::SeqCst),
            if unsafe_tool { 1 } else { 2 },
            "{result:?}"
        );
        result
    }
    #[tokio::test]
    async fn all_three_cli_protocols_must_execute_the_tool_and_return_its_receipt() {
        for protocol in ["anthropic", "openai_responses", "openai_chat_completions"] {
            let result = exercise(protocol, false).await;
            assert_eq!(result.status, "passed", "{protocol}: {result:?}");
            assert_eq!(result.checks.runtime, Check::Passed);
            assert_eq!(result.checks.configuration, Check::Passed);
            assert_eq!(result.checks.streaming, Check::Passed);
            assert_eq!(result.checks.tools, Check::Passed);
        }
    }
    #[tokio::test]
    async fn unexpected_upstream_tools_are_blocked_before_reaching_any_cli() {
        for protocol in ["anthropic", "openai_responses", "openai_chat_completions"] {
            let result = exercise(protocol, true).await;
            assert_eq!(result.status, "failed");
            assert_eq!(
                result.code.as_deref(),
                Some("unexpected_tool_call"),
                "{result:?}"
            );
            assert_ne!(result.checks.tools, Check::Passed);
        }
    }
    #[tokio::test]
    async fn wrong_final_receipt_cannot_pass_engine_validation() {
        for protocol in ["anthropic", "openai_responses", "openai_chat_completions"] {
            let result = exercise_binary(protocol, false, None, true).await;
            assert_eq!(result.status, "failed");
            assert_eq!(result.code.as_deref(), Some("tool_roundtrip_failed"));
        }
    }

    #[tokio::test]
    async fn cancellation_terminates_the_cli_and_closes_the_private_gateway() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = tempfile::tempdir().unwrap();
        let cli = fixture.path().join("blocked.py");
        let marker = fixture.path().join("blocked.json");
        std::fs::write(&cli, r#"#!/usr/bin/env python3
import json,os,sys,time
from pathlib import Path
if sys.argv[1:] == ['--version']:
 print('1.2.3-fake');sys.exit(0)
Path(__file__).with_suffix('.json').write_text(json.dumps({'pid':os.getpid(),'url':os.environ['ANTHROPIC_BASE_URL']}))
time.sleep(120)
"#).unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
        let profile = ApiProfile {
            provider: "anthropic_compatible".into(),
            protocol: Some("anthropic".into()),
            base_url: "http://127.0.0.1:1".into(),
            model: "test".into(),
            model_capabilities: None,
            headers: None,
        };
        let task = tokio::spawn(async move {
            probe_binary(
                &profile,
                "test-secret",
                Some(cli.to_string_lossy().into_owned()),
            )
            .await
        });
        let info: Value = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Ok(bytes) = std::fs::read(&marker)
                    && let Ok(info) = serde_json::from_slice(&bytes)
                {
                    break info;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        task.abort();
        let _ = task.await;
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_millis(200))
            .build()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let gone = unsafe { libc::kill(info["pid"].as_i64().unwrap() as i32, 0) } != 0;
                let closed = client
                    .get(format!("{}/api/hello", info["url"].as_str().unwrap()))
                    .send()
                    .await
                    .is_err();
                if gone && closed {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
    }
    #[tokio::test]
    #[ignore = "explicit local CLI opt-in; uses a loopback fake provider and no real credentials"]
    async fn real_cli_with_isolated_loopback_provider() {
        let binary = std::env::var("PROSPERO_ENGINE_REAL_BIN").expect("explicit binary");
        let protocol = match std::env::var("PROSPERO_ENGINE_REAL_PROTOCOL").as_deref() {
            Ok("openai_responses") => "openai_responses",
            Ok("openai_chat_completions") => "openai_chat_completions",
            Ok("anthropic") | Err(_) => "anthropic",
            _ => panic!("unsupported test protocol"),
        };
        let result = exercise_binary(protocol, false, Some(binary), false).await;
        assert_eq!(result.status, "passed", "{result:?}");
    }
}
