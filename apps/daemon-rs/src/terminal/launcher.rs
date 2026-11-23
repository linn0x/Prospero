use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{
    Json, Router,
    routing::{get, post},
};
use fs2::FileExt;
use futures_util::StreamExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{Semaphore, watch};

use super::session::{Binding, validate_native_id};
use crate::auth::Token;
use crate::error::{Error, Result};

#[derive(Clone)]
struct LaunchState {
    cli: String,
    args: Vec<String>,
    binding: PathBuf,
    cwd: String,
    expected: Option<String>,
    token: Token,
    writer: Arc<Mutex<Option<(String, File)>>>,
    connections: Arc<Semaphore>,
    failed: watch::Sender<bool>,
    lock_directory: PathBuf,
}

fn private_directory(path: &std::path::Path) -> Result<()> {
    std::fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

impl LaunchState {
    fn claim(&self, native_id: &str, cwd: &str) -> Result<()> {
        validate_native_id(native_id)?;
        if std::fs::canonicalize(cwd)? != std::fs::canonicalize(&self.cwd)? {
            return Err(Error::Invalid("原生对话的工作目录与此会话不一致".into()));
        }
        let mut writer = self.writer.lock().map_err(|_| Error::Closed)?;
        if writer.is_none() && self.expected.as_deref().is_some_and(|id| id != native_id) {
            return Err(Error::Invalid("恢复结果不是所选的原生对话".into()));
        }
        if writer.as_ref().is_none_or(|(id, _)| id != native_id) {
            private_directory(&self.lock_directory)?;
            let path = self.lock_directory.join(format!("{native_id}.lock"));
            if std::fs::symlink_metadata(&path).is_ok_and(|m| !m.is_file()) {
                return Err(Error::Unauthorized);
            }
            let file = OpenOptions::new()
                .create(true)
                .truncate(false)
                .write(true)
                .read(true)
                .open(path)?;
            file.try_lock_exclusive()
                .map_err(|_| Error::Invalid("原生对话正在被其他 Prospero 会话使用".into()))?;
            *writer = Some((native_id.to_owned(), file));
        }
        let parent = self.binding.parent().ok_or(Error::Closed)?;
        private_directory(parent)?;
        let temporary = self
            .binding
            .with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        let bytes = serde_json::to_vec(&Binding {
            native_id: native_id.into(),
            cwd: cwd.into(),
        })?;
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        }
        std::io::Write::write_all(&mut file, &bytes)?;
        file.sync_all()?;
        std::fs::rename(temporary, &self.binding)?;
        Ok(())
    }

    fn authorized(&self, headers: &HeaderMap) -> bool {
        !headers.contains_key("origin")
            && self.token.accepts(
                headers
                    .get("authorization")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or_default(),
            )
    }
}

async fn bind(
    State(state): State<LaunchState>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> Response {
    if !state.authorized(&headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let result = state.claim(
        input["session_id"].as_str().unwrap_or_default(),
        input["cwd"].as_str().unwrap_or_default(),
    );
    match result {
        Ok(()) => Json(json!({"ok":true})).into_response(),
        Err(_) => {
            state.failed.send_replace(true);
            StatusCode::CONFLICT.into_response()
        }
    }
}

const MAX_WS_MESSAGE_BYTES: usize = 512 * 1024 * 1024;
const MAX_PASSTHROUGH_FRAME_BYTES: usize = 8 * 1024 * 1024;
const MAX_STDIO_LINE_BYTES: usize = 512 * 1024 * 1024;
const MAX_JSON_STRING_BYTES: usize = 256 * 1024;

#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientParams {
    thread_id: Option<String>,
    ephemeral: Option<bool>,
    thread_source: Option<String>,
}

#[derive(serde::Deserialize)]
struct ClientMessage {
    #[serde(default)]
    id: Option<Value>,
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    params: ClientParams,
}

#[derive(Default, serde::Deserialize)]
struct ServerThread {
    id: Option<String>,
    cwd: Option<String>,
}

#[derive(Default, serde::Deserialize)]
struct ServerResult {
    #[serde(default)]
    thread: Option<ServerThread>,
}

#[derive(serde::Deserialize)]
struct ServerReply {
    #[serde(default)]
    id: Option<Value>,
    #[serde(default)]
    method: Option<serde::de::IgnoredAny>,
    #[serde(default)]
    error: Option<serde::de::IgnoredAny>,
    #[serde(default)]
    result: Option<ServerResult>,
}

fn floor_char_boundary(text: &str, mut index: usize) -> usize {
    if index >= text.len() {
        return text.len();
    }
    while index > 0 && !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn ceil_char_boundary(text: &str, mut index: usize) -> usize {
    if index >= text.len() {
        return text.len();
    }
    while index < text.len() && !text.is_char_boundary(index) {
        index += 1;
    }
    index
}

fn truncate_utf8_middle(text: &mut String, max_bytes: usize) {
    if text.len() <= max_bytes {
        return;
    }
    const NOTICE: &str = "\n...[原生会话输出过大，已截断 / oversized output truncated]...\n";
    let budget = max_bytes.saturating_sub(NOTICE.len());
    let head_budget = (budget * 2) / 3;
    let tail_budget = budget.saturating_sub(head_budget);
    let head_end = floor_char_boundary(text, head_budget);
    let tail_start = ceil_char_boundary(text, text.len().saturating_sub(tail_budget));
    if head_end >= tail_start {
        text.truncate(floor_char_boundary(text, max_bytes));
        return;
    }
    let mut compacted = String::with_capacity(head_end + NOTICE.len() + (text.len() - tail_start));
    compacted.push_str(&text[..head_end]);
    compacted.push_str(NOTICE);
    compacted.push_str(&text[tail_start..]);
    *text = compacted;
}

fn compact_json_strings(value: &mut Value, max_string_bytes: usize) {
    match value {
        Value::String(text) => truncate_utf8_middle(text, max_string_bytes),
        Value::Array(items) => {
            for item in items {
                compact_json_strings(item, max_string_bytes);
            }
        }
        Value::Object(map) => {
            for entry in map.values_mut() {
                compact_json_strings(entry, max_string_bytes);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

fn compact_oversized_rpc_line(line: &mut String) -> Result<()> {
    if line.len() <= MAX_PASSTHROUGH_FRAME_BYTES {
        return Ok(());
    }
    let mut value: Value = serde_json::from_str(line)?;
    for limit in [MAX_JSON_STRING_BYTES, 32 * 1024, 4 * 1024] {
        compact_json_strings(&mut value, limit);
        let serialized = serde_json::to_string(&value)?;
        if serialized.len() <= MAX_PASSTHROUGH_FRAME_BYTES {
            *line = serialized;
            return Ok(());
        }
        *line = serialized;
    }
    Ok(())
}

async fn upgrade(
    State(state): State<LaunchState>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if !state.authorized(&headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Ok(permit) = state.connections.clone().try_acquire_owned() else {
        return StatusCode::CONFLICT.into_response();
    };
    ws.max_message_size(MAX_WS_MESSAGE_BYTES)
        .max_frame_size(MAX_WS_MESSAGE_BYTES)
        .on_upgrade(move |socket| async move {
            let _permit = permit;
            if let Err(error) = bridge(socket, state.clone()).await {
                eprintln!("native session bridge: {error}");
                state.failed.send_replace(true);
            }
        })
}

fn command(cli: &str) -> Command {
    let mut command = Command::new(cli);
    command.kill_on_drop(true);
    #[cfg(unix)]
    unsafe {
        command.pre_exec(|| {
            libc::signal(libc::SIGINT, libc::SIG_DFL);
            Ok(())
        });
    }
    command
}

fn server_args(args: &[String]) -> Vec<String> {
    let mut result = Vec::new();
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        if matches!(
            arg.as_str(),
            "-c" | "--config" | "-p" | "--profile" | "--enable" | "--disable"
        ) {
            if let Some(value) = args.next() {
                result.extend([arg.clone(), value.clone()]);
            }
        } else if arg.starts_with("--config=") {
            result.push(arg.clone());
        }
    }
    result.extend(["app-server".into(), "--stdio".into()]);
    result
}

fn compatible_args(agent: &str, args: &mut [String], help: &str) {
    for index in 1..args.len() {
        if agent == "codex"
            && args[index - 1] == "--ask-for-approval"
            && args[index] == "untrusted"
            && help.contains("- on-request:")
            && !help.contains("- untrusted:")
        {
            args[index] = "on-request".into();
        }
        if agent == "claude" && args[index - 1] == "--permission-mode" && args[index] == "default" {
            let choices = help.split("--permission-mode").nth(1).unwrap_or_default();
            let choices = choices
                .split("choices:")
                .nth(1)
                .unwrap_or_default()
                .split(')')
                .next()
                .unwrap_or_default();
            if choices.contains("manual") && !choices.contains("default") {
                args[index] = "manual".into();
            }
        }
    }
}

async fn bridge(mut socket: WebSocket, state: LaunchState) -> Result<()> {
    let mut server = command(&state.cli)
        .args(server_args(&state.args))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let mut input = server.stdin.take().ok_or(Error::Closed)?;
    let mut output = BufReader::new(server.stdout.take().ok_or(Error::Closed)?);
    let (frames, mut received) = tokio::sync::mpsc::channel::<Result<String>>(2);
    let reader = tokio::spawn(async move {
        loop {
            let mut bytes = Vec::new();
            let result = (&mut output)
                .take((MAX_STDIO_LINE_BYTES + 1) as u64)
                .read_until(b'\n', &mut bytes)
                .await;
            if matches!(result, Ok(0)) {
                break;
            }
            let line = match result {
                Ok(_) if bytes.len() <= MAX_STDIO_LINE_BYTES => Ok(String::from_utf8(bytes)
                    .unwrap_or_else(|err| String::from_utf8_lossy(&err.into_bytes()).into_owned())),
                Ok(_) => Err(Error::Invalid("原生会话响应过大".into())),
                Err(error) => Err(error.into()),
            };
            let failed = line.is_err();
            if frames.send(line).await.is_err() || failed {
                break;
            }
        }
    });
    let mut pending = HashMap::new();
    let mut threads = HashMap::<String, (String, bool)>::new();
    let result = async {
        loop {
            tokio::select! {
                received = socket.next() => {
                    let text = match received {
                        Some(Ok(Message::Text(text))) => text.to_string(),
                        Some(Ok(Message::Ping(bytes))) => { socket.send(Message::Pong(bytes)).await.map_err(|_| Error::Closed)?; continue; }
                        Some(Ok(Message::Pong(_))) => continue,
                        Some(Ok(Message::Close(_))) | None => break,
                        _ => return Err(Error::Closed),
                    };
                    let message: ClientMessage = serde_json::from_str(&text)?;
                    if matches!(message.method.as_deref(), Some("turn/start" | "turn/steer")) {
                        let id = message.params.thread_id.as_deref().ok_or(Error::Closed)?;
                        let (cwd, durable) = threads.get(id).ok_or_else(|| Error::Invalid("原生对话身份未确认".into()))?;
                        if *durable { state.claim(id, cwd)?; }
                    }
                    if let Some(method @ ("thread/start" | "thread/resume" | "thread/fork")) = message.method.as_deref() {
                        if pending.len() >= 64 { return Err(Error::Busy); }
                        let id = message.id.ok_or(Error::Closed)?;
                        let durable = message.params.ephemeral != Some(true)
                            && message.params.thread_source.as_deref().is_none_or(|source| source == "user");
                        pending.insert(id.to_string(), (method.to_owned(), durable));
                    }
                    input.write_all(text.as_bytes()).await?;
                    input.write_all(b"\n").await?;
                    input.flush().await?;
                }
                line = received.recv() => {
                    let Some(line) = line else { break; };
                    let mut line = line?;
                    if !pending.is_empty() {
                        let reply: ServerReply = serde_json::from_str(&line)?;
                        if reply.method.is_none()
                            && let Some(id) = reply.id
                            && let Some((method, durable)) = pending.remove(&id.to_string())
                            && reply.error.is_none()
                        {
                            let thread = reply
                                .result
                                .and_then(|result| result.thread)
                                .ok_or(Error::Closed)?;
                            let id = thread.id.as_deref().ok_or(Error::Closed)?;
                            let cwd = thread.cwd.as_deref().unwrap_or(&state.cwd);
                            if threads.len() >= 256 && let Some(old) = threads.keys().next().cloned() { threads.remove(&old); }
                            threads.insert(id.into(), (cwd.into(), durable));
                            if durable && method != "thread/start" { state.claim(id, cwd)?; }
                        }
                    }
                    compact_oversized_rpc_line(&mut line)?;
                    let trimmed_len = line.trim_end_matches(['\r', '\n']).len();
                    line.truncate(trimmed_len);
                    socket.send(Message::Text(line.into())).await.map_err(|_| Error::Closed)?;
                }
            }
        }
        Ok(())
    }.await;
    reader.abort();
    let _ = server.kill().await;
    let _ = server.wait().await;
    result
}

pub async fn run(
    agent: String,
    cli: String,
    binding: PathBuf,
    native_id: Option<String>,
    mut args: Vec<String>,
) -> Result<i32> {
    #[cfg(windows)]
    retain_process_job()?;
    if !matches!(agent.as_str(), "codex" | "claude" | "agy") {
        return Err(Error::Invalid("不支持的原生终端".into()));
    }
    if let Some(id) = &native_id {
        validate_native_id(id)?;
    }
    if matches!(agent.as_str(), "codex" | "claude")
        && let Ok(Ok(output)) = tokio::time::timeout(
            std::time::Duration::from_secs(4),
            command(&cli)
                .arg("--help")
                .stdin(Stdio::null())
                .stderr(Stdio::null())
                .output(),
        )
        .await
    {
        compatible_args(&agent, &mut args, &String::from_utf8_lossy(&output.stdout));
    }
    #[cfg(unix)]
    unsafe {
        libc::signal(libc::SIGINT, libc::SIG_IGN);
    }
    let token = Token::parse(format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    ))?;
    let cwd = std::env::current_dir()?.to_string_lossy().into_owned();
    let home_dir = || {
        PathBuf::from(
            std::env::var_os("HOME")
                .or_else(|| std::env::var_os("USERPROFILE"))
                .unwrap_or_default(),
        )
    };
    let scope = match agent.as_str() {
        "codex" => std::env::var("CODEX_SQLITE_HOME")
            .or_else(|_| std::env::var("CODEX_HOME"))
            .unwrap_or_else(|_| home_dir().join(".codex").to_string_lossy().into_owned()),
        "claude" => std::env::var("CLAUDE_CONFIG_DIR")
            .unwrap_or_else(|_| home_dir().join(".claude").to_string_lossy().into_owned()),
        _ => home_dir()
            .join(".gemini")
            .join("antigravity-cli")
            .to_string_lossy()
            .into_owned(),
    };
    let scope = std::fs::canonicalize(&scope)
        .unwrap_or_else(|_| PathBuf::from(scope))
        .to_string_lossy()
        .into_owned();
    let scope = Sha256::digest(format!("{agent}:{scope}").as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let lock_directory = binding
        .parent()
        .and_then(|p| p.parent())
        .ok_or(Error::Closed)?
        .join("native-session-locks")
        .join(scope);
    let (failed, mut failure) = watch::channel(false);
    let state = LaunchState {
        cli: cli.clone(),
        args: args.clone(),
        binding,
        cwd,
        expected: native_id.clone(),
        token: token.clone(),
        writer: Arc::new(Mutex::new(None)),
        connections: Arc::new(Semaphore::new(1)),
        failed,
        lock_directory,
    };
    if agent == "agy" {
        return run_agy(cli, native_id, args, state, failure).await;
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let router = Router::new()
        .route("/", get(upgrade))
        .route("/bind", post(bind))
        .layer(DefaultBodyLimit::max(8192))
        .with_state(state);
    let http = tokio::spawn(async move { axum::serve(listener, router).await });
    if agent == "codex" {
        if let Some(id) = &native_id {
            let mut original = args.into_iter();
            args = Vec::new();
            while let Some(arg) = original.next() {
                if matches!(
                    arg.as_str(),
                    "--ask-for-approval" | "-a" | "--sandbox" | "-s"
                ) {
                    original.next();
                } else if !matches!(
                    arg.as_str(),
                    "--full-auto" | "--dangerously-bypass-approvals-and-sandbox"
                ) {
                    args.push(arg);
                }
            }
            args.splice(0..0, ["resume".into(), id.clone()]);
        }
        if !args
            .iter()
            .any(|arg| arg.starts_with("tui.keymap.editor.kill_line_start="))
        {
            args.extend(["-c".into(), "tui.keymap.editor.kill_line_start=[]".into()]);
        }
        if !args
            .iter()
            .any(|arg| arg.starts_with("tui.keymap.chat.interrupt_turn="))
        {
            args.extend([
                "-c".into(),
                "tui.keymap.chat.interrupt_turn=[\"esc\",\"ctrl-u\"]".into(),
            ]);
        }
        args.extend([
            "--remote".into(),
            format!("ws://{address}"),
            "--remote-auth-token-env".into(),
            "PROSPERO_NATIVE_BIND_TOKEN".into(),
        ]);
    } else {
        if let Some(id) = &native_id {
            args.extend(["--resume".into(), id.clone()]);
        } else if !args
            .iter()
            .any(|arg| arg == "--resume" || arg == "--fork-session")
        {
            args.extend(["--session-id".into(), uuid::Uuid::new_v4().to_string()]);
        }
        let executable = std::env::current_exe()?
            .to_string_lossy()
            .replace('\\', "/");
        let command = format!("'{}' terminal-bind", executable.replace('\'', "'\\''"));
        args.extend(["--settings".into(), json!({"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":command,"timeout":5}]}]}}).to_string()]);
    }
    let mut child = command(&cli)
        .args(args)
        .env("PROSPERO_NATIVE_BIND_URL", format!("http://{address}/bind"))
        .env("PROSPERO_NATIVE_BIND_TOKEN", token.value())
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()?;
    let code = tokio::select! {
        result = child.wait() => result?.code().unwrap_or(1),
        _ = failure.changed() => { let _ = child.kill().await; let _ = child.wait().await; 1 }
    };
    http.abort();
    Ok(code)
}

const MAX_AGY_CARRY_BYTES: usize = 64 * 1024;

fn extract_agy_uuid(body: &str, prefix: &str) -> Option<String> {
    let rest = body.strip_prefix(prefix)?;
    let token = rest.split_whitespace().next()?;
    validate_native_id(token).ok()?;
    Some(token.to_owned())
}

#[derive(Default)]
struct AgyLogTracker {
    pending_stream: Option<String>,
    claimed: Option<String>,
}

impl AgyLogTracker {
    fn observe_line(&mut self, line: &str) -> Option<String> {
        let body = line
            .split_once("] ")
            .map(|(_, rest)| rest)
            .unwrap_or(line)
            .trim();
        if let Some(id) = extract_agy_uuid(body, "Streaming conversation ")
            .or_else(|| extract_agy_uuid(body, "Resuming conversation "))
        {
            self.pending_stream = Some(id);
            return None;
        }
        if let Some(id) = extract_agy_uuid(body, "GetConversationDetail: found conversation ")
            .or_else(|| extract_agy_uuid(body, "Starting conversation update stream for "))
        {
            if self.pending_stream.as_deref() == Some(id.as_str())
                && self.claimed.as_deref() != Some(id.as_str())
            {
                self.claimed = Some(id.clone());
                return Some(id);
            }
            return None;
        }
        if let Some(id) = extract_agy_uuid(body, "Forwarding user message to conversation ") {
            self.pending_stream = Some(id.clone());
            if self.claimed.as_deref() != Some(id.as_str()) {
                self.claimed = Some(id.clone());
                return Some(id);
            }
        }
        None
    }
}

struct AgyLogReader {
    path: PathBuf,
    offset: u64,
    carry: Vec<u8>,
    tracker: AgyLogTracker,
}

impl AgyLogReader {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            offset: 0,
            carry: Vec::new(),
            tracker: AgyLogTracker::default(),
        }
    }

    fn process_line(&mut self, bytes: &[u8], state: &LaunchState) -> bool {
        let line = String::from_utf8_lossy(bytes);
        if let Some(id) = self.tracker.observe_line(&line)
            && let Err(error) = state.claim(&id, &state.cwd)
        {
            eprintln!("native session bind: {error}");
            state.failed.send_replace(true);
            return false;
        }
        true
    }

    fn drain(&mut self, state: &LaunchState) -> bool {
        use std::io::{Read, Seek, SeekFrom};
        let mut file = match File::open(&self.path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return true,
            Err(error) => {
                eprintln!("agy log open failed: {error}");
                return true;
            }
        };
        let Ok(metadata) = file.metadata() else {
            return true;
        };
        let len = metadata.len();
        if len < self.offset {
            self.offset = 0;
            self.carry.clear();
        }
        if len == self.offset {
            return true;
        }
        if file.seek(SeekFrom::Start(self.offset)).is_err() {
            return true;
        }
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            match file.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    self.offset += read as u64;
                    self.carry.extend_from_slice(&buffer[..read]);
                    while let Some(pos) = self.carry.iter().position(|byte| *byte == b'\n') {
                        let line = self.carry.drain(..=pos).collect::<Vec<u8>>();
                        if !self.process_line(&line, state) {
                            return false;
                        }
                    }
                    if self.carry.len() > MAX_AGY_CARRY_BYTES {
                        self.carry.clear();
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        true
    }

    fn drain_final(&mut self, state: &LaunchState) {
        if !self.drain(state) {
            return;
        }
        if !self.carry.is_empty() {
            let line = std::mem::take(&mut self.carry);
            let _ = self.process_line(&line, state);
        }
    }
}

fn existing_agy_log_file(args: &[String]) -> Option<PathBuf> {
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == "--log-file" {
            return iter
                .next()
                .filter(|value| !value.trim().is_empty())
                .map(PathBuf::from);
        }
        if let Some(path) = arg.strip_prefix("--log-file=")
            && !path.trim().is_empty()
        {
            return Some(PathBuf::from(path));
        }
    }
    None
}

fn has_agy_conversation_arg(args: &[String]) -> bool {
    args.iter()
        .any(|arg| arg == "--conversation" || arg.starts_with("--conversation="))
}

async fn run_agy(
    cli: String,
    native_id: Option<String>,
    mut args: Vec<String>,
    state: LaunchState,
    mut failure: watch::Receiver<bool>,
) -> Result<i32> {
    if let Some(id) = &native_id
        && !has_agy_conversation_arg(&args)
    {
        args.extend(["--conversation".into(), id.clone()]);
    }
    let (log_path, owns_log_file) = match existing_agy_log_file(&args) {
        Some(path) => (path, false),
        None => {
            let path = super::session::agy_log_path_for_binding(&state.binding);
            if let Some(parent) = path.parent() {
                private_directory(parent)?;
            }
            let _ = std::fs::remove_file(&path);
            args.extend(["--log-file".into(), path.to_string_lossy().into_owned()]);
            (path, true)
        }
    };
    let mut child = command(&cli)
        .args(args)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()?;
    let reader = Arc::new(Mutex::new(AgyLogReader::new(log_path.clone())));
    let watch_reader = reader.clone();
    let watch_state = state.clone();
    let watcher = tokio::spawn(async move {
        loop {
            let keep_going = match watch_reader.lock() {
                Ok(mut guard) => guard.drain(&watch_state),
                Err(_) => false,
            };
            if !keep_going {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    });
    let (code, aborted_on_failure) = tokio::select! {
        result = child.wait() => (result?.code().unwrap_or(1), false),
        _ = failure.changed() => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            (1, true)
        }
    };
    watcher.abort();
    let _ = watcher.await;
    if !aborted_on_failure && let Ok(mut guard) = reader.lock() {
        guard.drain_final(&state);
    }
    let code = if aborted_on_failure || *failure.borrow() {
        1
    } else {
        code
    };
    if owns_log_file {
        let _ = std::fs::remove_file(&log_path);
    }
    Ok(code)
}

pub async fn notify() -> Result<()> {
    use std::io::Read;
    let mut bytes = Vec::new();
    std::io::stdin().take(8193).read_to_end(&mut bytes)?;
    if bytes.len() > 8192 {
        return Err(Error::Invalid("原生会话事件过大".into()));
    }
    let body: Value = serde_json::from_slice(&bytes)?;
    validate_native_id(body["session_id"].as_str().unwrap_or_default())?;
    let url = std::env::var("PROSPERO_NATIVE_BIND_URL").map_err(|_| Error::Unauthorized)?;
    let parsed = url::Url::parse(&url).map_err(|_| Error::Unauthorized)?;
    if parsed.scheme() != "http"
        || parsed.host_str() != Some("127.0.0.1")
        || parsed.path() != "/bind"
    {
        return Err(Error::Unauthorized);
    }
    let token = std::env::var("PROSPERO_NATIVE_BIND_TOKEN").map_err(|_| Error::Unauthorized)?;
    let response = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(4))
        .build()
        .map_err(|_| Error::Closed)?
        .post(url)
        .bearer_auth(token)
        .json(&json!({"session_id":body["session_id"],"cwd":body["cwd"]}))
        .send()
        .await
        .map_err(|_| Error::Closed)?;
    if !response.status().is_success() {
        return Err(Error::Conflict);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(root: &std::path::Path) -> LaunchState {
        LaunchState {
            cli: "fixture".into(),
            args: Vec::new(),
            binding: root.join("binding.json"),
            cwd: root.to_string_lossy().into_owned(),
            expected: None,
            token: Token::parse("a".repeat(64)).unwrap(),
            writer: Arc::new(Mutex::new(None)),
            connections: Arc::new(Semaphore::new(1)),
            failed: watch::channel(false).0,
            lock_directory: root.join("locks"),
        }
    }

    #[test]
    fn native_bindings_require_identity_workspace_and_single_writer() {
        let root = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let first = state(root.path());
        let id = uuid::Uuid::new_v4().to_string();
        assert!(first.claim(&id, other.path().to_str().unwrap()).is_err());
        first.claim(&id, &first.cwd).unwrap();
        let second = state(root.path());
        assert!(second.claim(&id, &second.cwd).is_err());
        let next = uuid::Uuid::new_v4().to_string();
        first.claim(&next, &first.cwd).unwrap();
        second.claim(&id, &second.cwd).unwrap();
        let mut resumed = state(other.path());
        resumed.expected = Some(id);
        assert!(resumed.claim(&next, &resumed.cwd).is_err());
        assert!(!resumed.binding.exists());
    }

    #[test]
    fn current_cli_policy_names_keep_restrictive_sandbox_flags() {
        let mut codex = vec![
            "--ask-for-approval".into(),
            "untrusted".into(),
            "--sandbox".into(),
            "read-only".into(),
        ];
        compatible_args("codex", &mut codex, "- on-request: asks\n- never: skips");
        assert_eq!(
            codex,
            ["--ask-for-approval", "on-request", "--sandbox", "read-only"]
        );
        let mut claude = vec!["--permission-mode".into(), "default".into()];
        compatible_args(
            "claude",
            &mut claude,
            "--permission-mode <mode> (choices: manual, acceptEdits)",
        );
        assert_eq!(claude, ["--permission-mode", "manual"]);
    }

    #[test]
    fn oversized_rpc_lines_compact_large_string_fields_while_preserving_thread_identity() {
        let huge_output = "中文输出-abc123\n".repeat(600_000);
        let thread_id = uuid::Uuid::new_v4().to_string();
        let mut line = serde_json::to_string(&json!({
            "jsonrpc": "2.0",
            "id": 7,
            "result": {
                "thread": {
                    "id": thread_id,
                    "cwd": "/tmp/workspace",
                    "turns": [
                        {
                            "items": [
                                {
                                    "type": "commandExecution",
                                    "aggregatedOutput": huge_output,
                                    "stdout": huge_output,
                                }
                            ]
                        }
                    ]
                }
            }
        }))
        .unwrap();
        assert!(line.len() > MAX_PASSTHROUGH_FRAME_BYTES);

        let reply: ServerReply = serde_json::from_str(&line).unwrap();
        assert!(reply.method.is_none());
        assert!(reply.error.is_none());
        let parsed_thread = reply.result.unwrap().thread.unwrap();
        assert_eq!(parsed_thread.id.as_deref(), Some(thread_id.as_str()));
        assert_eq!(parsed_thread.cwd.as_deref(), Some("/tmp/workspace"));

        compact_oversized_rpc_line(&mut line).unwrap();
        assert!(line.len() <= MAX_PASSTHROUGH_FRAME_BYTES);
        let compacted: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(
            compacted["result"]["thread"]["id"].as_str(),
            Some(thread_id.as_str())
        );
        let compacted_output =
            compacted["result"]["thread"]["turns"][0]["items"][0]["aggregatedOutput"]
                .as_str()
                .unwrap();
        assert!(compacted_output.contains("oversized output truncated"));
        assert!(compacted_output.starts_with("中文输出-abc123\n"));
        assert!(compacted_output.ends_with("中文输出-abc123\n"));
    }

    #[test]
    fn agy_log_tracker_tracks_new_resumed_switched_and_ignores_subagents_and_failed_resume() {
        let id1 = uuid::Uuid::new_v4().to_string();
        let id2 = uuid::Uuid::new_v4().to_string();
        let id3 = uuid::Uuid::new_v4().to_string();
        let sub_id = uuid::Uuid::new_v4().to_string();
        let bad_id = uuid::Uuid::new_v4().to_string();

        let mut tracker = AgyLogTracker::default();
        assert_eq!(
            tracker.observe_line(&format!(
                "I1119 01:16:32.911708     988 conversation_manager.go:1082] Streaming conversation {id1}"
            )),
            None
        );
        // Subagent stream in the same process must not hijack pending main conversation.
        assert_eq!(
            tracker.observe_line(&format!(
                "I1119 01:16:32.920000     999 server.go:1276] Starting conversation update stream for {sub_id}"
            )),
            None
        );
        assert_eq!(
            tracker.observe_line(&format!(
                "I1119 01:16:32.921000     988 server.go:3537] GetConversationDetail: found conversation {id1} (active=true)"
            )),
            Some(id1.clone())
        );
        // Duplicate confirmation for the same claimed conversation does not re-emit.
        assert_eq!(
            tracker.observe_line(&format!(
                "I1119 01:16:32.932768     988 server.go:1276] Starting conversation update stream for {id1}"
            )),
            None
        );
        // Failed resume only logs Resuming conversation without backend confirmation.
        assert_eq!(
            tracker.observe_line(&format!(
                "I1119 01:16:33.000000       1 common.go:477] Resuming conversation {bad_id}"
            )),
            None
        );
        // Switching conversation in TUI updates pending_stream and emits on confirmation.
        assert_eq!(
            tracker.observe_line(&format!(
                "I1119 01:16:34.000000     988 conversation_manager.go:1082] Streaming conversation {id2}"
            )),
            None
        );
        assert_eq!(
            tracker.observe_line(&format!(
                "I1119 01:16:34.010000     988 server.go:1276] Starting conversation update stream for {id2}"
            )),
            Some(id2.clone())
        );
        // Direct user prompt forwarding also claims when switching.
        assert_eq!(
            tracker.observe_line(&format!(
                "I1119 01:16:35.000000     988 conversation_manager.go:884] Forwarding user message to conversation {id3} (items=1, media=0)"
            )),
            Some(id3)
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn agy_launcher_binds_from_log_file_and_enforces_expected_resume_id() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        let bindings_dir = root.path().join("terminal-bindings");
        std::fs::create_dir_all(&bindings_dir).unwrap();

        let id1 = uuid::Uuid::new_v4().to_string();
        let id2 = uuid::Uuid::new_v4().to_string();
        let script_path = root.path().join("fake-agy.sh");
        let script = format!(
            r#"#!/bin/sh
set -eu
LOG_FILE=""
CONV_ID=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --log-file)
      LOG_FILE="$2"
      shift 2
      ;;
    --log-file=*)
      LOG_FILE="${{1#--log-file=}}"
      shift
      ;;
    --conversation)
      CONV_ID="$2"
      shift 2
      ;;
    --conversation=*)
      CONV_ID="${{1#--conversation=}}"
      shift
      ;;
    *)
      shift
      ;;
  esac
done
[ -n "$LOG_FILE" ]
MODE="${{FAKE_AGY_MODE:-new}}"
case "$MODE" in
  new)
    printf 'I1119 01:00:00.000000 1 conversation_manager.go:1082] Streaming conversation %s\n' "{id1}" >> "$LOG_FILE"
    printf 'I1119 01:00:00.001000 1 server.go:1276] Starting conversation update stream for %s\n' "{id1}" >> "$LOG_FILE"
    ;;
  resume)
    [ "$CONV_ID" = "{id1}" ]
    printf 'I1119 01:00:00.000000 1 common.go:477] Resuming conversation %s\n' "$CONV_ID" >> "$LOG_FILE"
    printf 'I1119 01:00:00.001000 1 conversation_manager.go:1082] Streaming conversation %s\n' "$CONV_ID" >> "$LOG_FILE"
    printf 'I1119 01:00:00.002000 1 server.go:3537] GetConversationDetail: found conversation %s\n' "$CONV_ID" >> "$LOG_FILE"
    ;;
  mismatch)
    printf 'I1119 01:00:00.000000 1 conversation_manager.go:1082] Streaming conversation %s\n' "{id2}" >> "$LOG_FILE"
    printf 'I1119 01:00:00.001000 1 server.go:1276] Starting conversation update stream for %s\n' "{id2}" >> "$LOG_FILE"
    sleep 5
    ;;
esac
sleep 0.15
"#,
        );
        std::fs::write(&script_path, script).unwrap();
        std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o755)).unwrap();

        let binding1 = bindings_dir.join("sess-1.json");
        let log1 = super::super::session::agy_log_path_for_binding(&binding1);
        unsafe { std::env::set_var("FAKE_AGY_MODE", "new") };
        let code1 = run(
            "agy".into(),
            script_path.to_string_lossy().into_owned(),
            binding1.clone(),
            None,
            Vec::new(),
        )
        .await
        .unwrap();
        assert_eq!(code1, 0);
        let claimed1 = super::super::session::read_binding(&binding1)
            .unwrap()
            .expect("new session binding must exist");
        assert_eq!(claimed1.native_id, id1);
        assert!(!log1.exists(), "owned agy log must be removed on exit");

        let binding2 = bindings_dir.join("sess-2.json");
        unsafe { std::env::set_var("FAKE_AGY_MODE", "resume") };
        let code2 = run(
            "agy".into(),
            script_path.to_string_lossy().into_owned(),
            binding2.clone(),
            Some(id1.clone()),
            Vec::new(),
        )
        .await
        .unwrap();
        assert_eq!(code2, 0);
        let claimed2 = super::super::session::read_binding(&binding2)
            .unwrap()
            .expect("resumed session binding must exist");
        assert_eq!(claimed2.native_id, id1);

        let binding3 = bindings_dir.join("sess-3.json");
        let log3 = super::super::session::agy_log_path_for_binding(&binding3);
        unsafe { std::env::set_var("FAKE_AGY_MODE", "mismatch") };
        let code3 = run(
            "agy".into(),
            script_path.to_string_lossy().into_owned(),
            binding3.clone(),
            Some(id1),
            Vec::new(),
        )
        .await
        .unwrap();
        unsafe { std::env::remove_var("FAKE_AGY_MODE") };
        assert_ne!(code3, 0);
        assert!(!binding3.exists());
        assert!(!log3.exists());
    }
}

#[cfg(windows)]
fn retain_process_job() -> Result<()> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::JobObjects::*;
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return Err(std::io::Error::last_os_error().into());
        }
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of_val(&limits) as u32,
        ) == 0
            || AssignProcessToJobObject(job, GetCurrentProcess()) == 0
        {
            let error = std::io::Error::last_os_error();
            CloseHandle(job);
            return Err(error.into());
        }
    }
    Ok(())
}
