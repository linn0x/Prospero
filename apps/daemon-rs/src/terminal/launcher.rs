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
    ws.max_message_size(16 * 1024 * 1024)
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
                .take(16 * 1024 * 1024 + 1)
                .read_until(b'\n', &mut bytes)
                .await;
            if matches!(result, Ok(0)) {
                break;
            }
            let line = match result {
                Ok(_) if bytes.len() <= 16 * 1024 * 1024 => String::from_utf8(bytes)
                    .map_err(|_| Error::Invalid("无效的原生会话响应".into())),
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
                    let value: Value = serde_json::from_str(&text)?;
                    if matches!(value["method"].as_str(), Some("turn/start" | "turn/steer")) {
                        let id = value["params"]["threadId"].as_str().ok_or(Error::Closed)?;
                        let (cwd, durable) = threads.get(id).ok_or_else(|| Error::Invalid("原生对话身份未确认".into()))?;
                        if *durable { state.claim(id, cwd)?; }
                    }
                    if matches!(value["method"].as_str(), Some("thread/start" | "thread/resume" | "thread/fork")) {
                        if pending.len() >= 64 { return Err(Error::Busy); }
                        let durable = value["params"]["ephemeral"].as_bool() != Some(true)
                            && value["params"]["threadSource"].as_str().is_none_or(|source| source == "user");
                        pending.insert(value["id"].to_string(), (value["method"].as_str().unwrap().to_owned(), durable));
                    }
                    input.write_all(text.as_bytes()).await?;
                    input.write_all(b"\n").await?;
                    input.flush().await?;
                }
                line = received.recv() => {
                    let Some(line) = line else { break; };
                    let line = line?;
                    let value: Value = serde_json::from_str(&line)?;
                    if value.get("method").is_none() && let Some((method, durable)) = pending.remove(&value["id"].to_string()) && value.get("error").is_none() {
                        let thread = &value["result"]["thread"];
                        let id = thread["id"].as_str().ok_or(Error::Closed)?;
                        let cwd = thread["cwd"].as_str().unwrap_or(&state.cwd);
                        if threads.len() >= 256 && let Some(old) = threads.keys().next().cloned() { threads.remove(&old); }
                        threads.insert(id.into(), (cwd.into(), durable));
                        if durable && method != "thread/start" { state.claim(id, cwd)?; }
                    }
                    socket.send(Message::Text(line.trim_end().to_owned().into())).await.map_err(|_| Error::Closed)?;
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
    if !matches!(agent.as_str(), "codex" | "claude") {
        return Err(Error::Invalid("不支持的原生终端".into()));
    }
    if let Some(id) = &native_id {
        validate_native_id(id)?;
    }
    if let Ok(Ok(output)) = tokio::time::timeout(
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
    let scope = (if agent == "codex" {
        std::env::var("CODEX_SQLITE_HOME").or_else(|_| std::env::var("CODEX_HOME"))
    } else {
        std::env::var("CLAUDE_CONFIG_DIR")
    })
    .unwrap_or_else(|_| {
        PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
            .join(if agent == "codex" {
                ".codex"
            } else {
                ".claude"
            })
            .to_string_lossy()
            .into_owned()
    });
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
