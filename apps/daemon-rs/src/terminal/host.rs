//! A per-session PTY owner that outlives the control daemon.
//! The parent sends the launch environment once over stdin; only a private
//! loopback capability is published to disk. Reattachment never spawns a shell.
use super::*;
use crate::auth::Token;
use crate::server::ApiError;
use axum::extract::ws::WebSocketUpgrade;
use axum::{
    Extension, Json, Router,
    extract::{DefaultBodyLimit, Query, State},
    middleware::{self, Next},
    response::Response,
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::PathBuf,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};

const STREAM_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);
const MUX_IDLE_EXIT_GRACE: Duration = Duration::from_millis(150);

async fn drain_terminal_streams(terminal: &Terminal) -> Option<tokio::sync::OwnedSemaphorePermit> {
    terminal.drain_streams(STREAM_DRAIN_TIMEOUT).await
}

#[derive(Serialize, Deserialize)]
struct Launch {
    argv: Vec<std::ffi::OsString>,
    cwd: Option<std::ffi::OsString>,
    environment: Vec<(std::ffi::OsString, std::ffi::OsString)>,
    size: TerminalSize,
    #[serde(default)]
    base_seq: i64,
}
#[derive(Clone, Deserialize)]
struct Connection {
    base_url: String,
    token: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct MuxInfo {
    version: u32,
    pid: u32,
    base_url: String,
    token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    executable: Option<PathBuf>,
}

#[derive(Serialize, Deserialize)]
struct MuxSpawnRequest {
    id: String,
    session_dir: PathBuf,
    command: Vec<String>,
    cwd: Option<String>,
    env: Vec<(String, String)>,
    size: TerminalSize,
    #[serde(default)]
    argv: Vec<std::ffi::OsString>,
    #[serde(default)]
    cwd_os: Option<std::ffi::OsString>,
    #[serde(default)]
    environment: Vec<(std::ffi::OsString, std::ffi::OsString)>,
    #[serde(default)]
    base_seq: i64,
}

struct SpawnLockGuard(Option<std::fs::File>);

impl Drop for SpawnLockGuard {
    fn drop(&mut self) {
        if let Some(file) = self.0.take() {
            let _ = fs2::FileExt::unlock(&file);
        }
    }
}

fn truncate_utf8_prefix(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_owned();
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

fn set_private_dir_permissions(path: &std::path::Path) -> Result<()> {
    std::fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn same_executable(left: &std::path::Path, right: &std::path::Path) -> bool {
    match (std::fs::canonicalize(left), std::fs::canonicalize(right)) {
        (Ok(a), Ok(b)) => a == b,
        _ => left == right,
    }
}

async fn read_healthy_mux(
    mux_dir: &std::path::Path,
    expected_executable: &std::path::Path,
    client: &reqwest::Client,
) -> Option<MuxInfo> {
    if !owner_alive(mux_dir).ok()? {
        return None;
    }
    let bytes = tokio::fs::read(mux_dir.join("mux.json")).await.ok()?;
    if bytes.len() > 4096 {
        return None;
    }
    let info: MuxInfo = serde_json::from_slice(&bytes).ok()?;
    if info.version != 1 {
        return None;
    }
    if !info
        .executable
        .as_deref()
        .is_some_and(|exe| same_executable(exe, expected_executable))
    {
        return None;
    }
    let url = url::Url::parse(&info.base_url).ok()?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || url.path() != "/"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    Token::parse(info.token.clone()).ok()?;
    let response = client
        .get(format!("{}health", info.base_url))
        .bearer_auth(&info.token)
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .ok()?;
    response.status().is_success().then_some(info)
}

fn spawn_mux_process(
    executable: &std::path::Path,
    mux_dir: &std::path::Path,
) -> Result<std::process::Child> {
    let mut command = std::process::Command::new(executable);
    command
        .args(["terminal-mux-host", "--directory"])
        .arg(mux_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x00000008 | 0x00000200 | 0x01000000);
    }
    Ok(command.spawn()?)
}
pub(crate) struct HostFallbackStream {
    epoch: String,
    controller: std::sync::Mutex<Option<String>>,
    controller_changed: watch::Sender<u64>,
    stream_slots: Arc<tokio::sync::Semaphore>,
}

impl Default for HostFallbackStream {
    fn default() -> Self {
        Self {
            epoch: format!("fallback-{}", uuid::Uuid::new_v4()),
            controller: std::sync::Mutex::new(None),
            controller_changed: watch::channel(0).0,
            stream_slots: Arc::new(tokio::sync::Semaphore::new(
                super::STREAM_VIEWER_SLOTS as usize,
            )),
        }
    }
}

#[derive(Clone)]
pub(crate) struct Host {
    pub directory: PathBuf,
    url: String,
    token: String,
    client: reqwest::Client,
    stream_supported: bool,
    scrollback_supported: bool,
    fallback_stream: Arc<HostFallbackStream>,
}
impl Host {
    pub fn supports_stream(&self) -> bool {
        self.stream_supported
    }
    pub fn supports_scrollback(&self) -> bool {
        self.scrollback_supported
    }
    pub fn stream_url(&self) -> String {
        format!("{}/stream", self.url.replacen("http://", "ws://", 1))
    }
    pub fn token(&self) -> &str {
        &self.token
    }
    pub(crate) fn fallback_epoch(&self) -> &str {
        &self.fallback_stream.epoch
    }
    pub(crate) fn fallback_stream_permit(&self) -> Result<tokio::sync::OwnedSemaphorePermit> {
        self.fallback_stream
            .stream_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Busy)
    }
    pub(crate) fn fallback_controller(&self) -> Result<Option<String>> {
        Ok(self
            .fallback_stream
            .controller
            .lock()
            .map_err(|_| Error::Closed)?
            .clone())
    }
    pub(crate) fn acquire_fallback_controller(&self, client: &str, takeover: bool) -> Result<bool> {
        let mut current = self
            .fallback_stream
            .controller
            .lock()
            .map_err(|_| Error::Closed)?;
        if current.is_none() || current.as_deref() == Some(client) || takeover {
            if current.as_deref() != Some(client) {
                *current = Some(client.into());
                self.fallback_stream
                    .controller_changed
                    .send_modify(|value| *value = value.wrapping_add(1));
            }
            Ok(true)
        } else {
            Ok(false)
        }
    }
    pub(crate) fn release_fallback_controller(&self, client: &str) -> Result<bool> {
        let mut current = self
            .fallback_stream
            .controller
            .lock()
            .map_err(|_| Error::Closed)?;
        if current.as_deref() == Some(client) {
            *current = None;
            self.fallback_stream
                .controller_changed
                .send_modify(|value| *value = value.wrapping_add(1));
            Ok(true)
        } else {
            Ok(false)
        }
    }
    pub(crate) fn fallback_controller_changes(&self) -> watch::Receiver<u64> {
        self.fallback_stream.controller_changed.subscribe()
    }
    pub(crate) async fn fallback_input_as(&self, client: &str, input: TerminalInput) -> Result<()> {
        if self.fallback_controller()?.as_deref() != Some(client) {
            return Err(Error::Conflict);
        }
        self.post("input", &input).await
    }
    pub(crate) async fn fallback_resize_as(&self, client: &str, size: TerminalSize) -> Result<()> {
        if self.fallback_controller()?.as_deref() != Some(client) {
            return Err(Error::Conflict);
        }
        self.post("resize", &size).await
    }
    pub async fn attach(directory: PathBuf) -> Result<Self> {
        use tokio::io::AsyncReadExt;
        let mut bytes = Vec::new();
        tokio::fs::File::open(directory.join("host.json"))
            .await?
            .take(4097)
            .read_to_end(&mut bytes)
            .await?;
        if bytes.len() > 4096 {
            return Err(Error::Invalid(
                "terminal host descriptor exceeds limit".into(),
            ));
        }
        let connection: Connection = serde_json::from_slice(&bytes)?;
        let url = url::Url::parse(&connection.base_url).map_err(|_| Error::Unauthorized)?;
        let expected_id = directory
            .file_name()
            .and_then(|v| v.to_str())
            .ok_or(Error::Unauthorized)?
            .to_owned();
        let mux_slash = format!("/s/{expected_id}/");
        let mux_bare = format!("/s/{expected_id}");
        let valid_path = url.path() == "/" || url.path() == mux_slash || url.path() == mux_bare;
        if url.scheme() != "http"
            || url.host_str() != Some("127.0.0.1")
            || url.port().is_none()
            || !valid_path
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(Error::Unauthorized);
        }
        Token::parse(connection.token.clone())?;
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(2))
            .build()
            .map_err(|_| Error::Closed)?;
        let mut host = Self {
            directory,
            url: connection.base_url.trim_end_matches('/').to_owned(),
            token: connection.token,
            client,
            stream_supported: false,
            scrollback_supported: false,
            fallback_stream: Arc::default(),
        };
        let identity: serde_json::Value = host.get("identity").await?;
        if identity["version"] != 1 || identity["id"].as_str() != Some(expected_id.as_str()) {
            return Err(Error::Unauthorized);
        }
        host.stream_supported = identity["capabilities"].as_array().is_some_and(|items| {
            items
                .iter()
                .any(|item| item.as_str() == Some("terminal.stream.v1"))
        });
        host.scrollback_supported = identity["capabilities"].as_array().is_some_and(|items| {
            items
                .iter()
                .any(|item| item.as_str() == Some("terminal.scrollback.v1"))
        });
        Ok(host)
    }

    pub async fn reconstruct_scrollback_snapshot(
        &self,
        fallback: Option<TerminalSnapshot>,
    ) -> Result<Option<TerminalSnapshot>> {
        if self.scrollback_supported {
            return match fallback {
                Some(snapshot) => Ok(Some(snapshot)),
                None => self.get("snapshot").await,
            };
        }
        let Some(snap) = (match fallback {
            Some(snapshot) => Some(snapshot),
            None => self.get("snapshot").await?,
        }) else {
            return Ok(None);
        };
        if snap.seq <= 0 {
            return Ok(Some(snap));
        }
        let Ok(first_page) = self
            .get::<TerminalPage>("output?afterSeq=0&waitMs=0")
            .await
        else {
            return Ok(Some(snap));
        };
        let initial_size = first_page.initial_size;
        let resynced = first_page.resync_required;
        let mut cursor = if resynced {
            first_page.floor_seq
        } else {
            0
        };
        if cursor > snap.seq {
            return Ok(Some(snap));
        }
        let mut collected = Vec::new();
        let mut pending_page = if !resynced { Some(first_page) } else { None };
        while cursor < snap.seq {
            let page = match pending_page.take() {
                Some(page) => page,
                None => match self
                    .get::<TerminalPage>(&format!("output?afterSeq={cursor}&waitMs=0"))
                    .await
                {
                    Ok(page) => page,
                    Err(_) => return Ok(Some(snap)),
                },
            };
            if page.resync_required {
                if page.floor_seq > cursor && page.floor_seq <= snap.seq {
                    cursor = page.floor_seq;
                    continue;
                }
                return Ok(Some(snap));
            }
            if page.events.is_empty() || page.next_seq <= cursor {
                break;
            }
            for (idx, event) in page.events.into_iter().enumerate() {
                let event_seq = page.base_seq + idx as i64 + 1;
                if event_seq > snap.seq {
                    break;
                }
                collected.push(event);
            }
            cursor = page.next_seq;
        }
        if collected.is_empty() {
            return Ok(Some(snap));
        }
        let fallback_snap = snap.clone();
        tokio::task::spawn_blocking(move || {
            let mut screen = super::screen::Screen::new(if resynced {
                fallback_snap.size
            } else {
                initial_size
            });
            let snap_screen = if resynced {
                let mut parsed = super::screen::Screen::new(fallback_snap.size);
                if let Ok(bytes) = STANDARD.decode(&fallback_snap.data_b64) {
                    parsed.process(&bytes);
                }
                screen.seed_modes_from(&parsed);
                Some(parsed)
            } else {
                None
            };
            for event in collected {
                match event {
                    TerminalEvent::Output { data_b64 } => {
                        if let Ok(bytes) = STANDARD.decode(data_b64) {
                            screen.process(&bytes);
                        }
                    }
                    TerminalEvent::Resize { size } => screen.resize(size),
                }
            }
            if screen.size() != fallback_snap.size {
                screen.resize(fallback_snap.size);
            }
            if let Some(snap_screen) = snap_screen {
                let rows = usize::from(fallback_snap.size.rows);
                if screen.scrollback_len() == 0
                    || screen.visible_tail_text(rows) != snap_screen.visible_tail_text(rows)
                {
                    return Ok(Some(fallback_snap));
                }
            }
            Ok(Some(
                screen.snapshot(fallback_snap.seq).unwrap_or(fallback_snap),
            ))
        })
        .await
        .map_err(|_| Error::Closed)?
    }

    /// Deliver bytes to an already-owned terminal without requiring the
    /// daemon's in-memory `Terminals` registry.  This is used by durable
    /// cross-model fan-in: a CLI parent may be a hosted PTY rather than a
    /// structured Rust agent session.
    pub(crate) async fn input(&self, input: TerminalInput) -> Result<()> {
        match self.post("system-input", &input).await {
            Err(Error::NotFound) => self.post("input", &input).await,
            other => other,
        }
    }
    pub async fn start_at(
        exe: PathBuf,
        directory: PathBuf,
        command: portable_pty::CommandBuilder,
        size: TerminalSize,
        expected_hash: String,
        base_seq: i64,
    ) -> Result<Self> {
        let id = directory
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or(Error::Unauthorized)?
            .to_owned();
        let data_dir = directory
            .parent()
            .and_then(std::path::Path::parent)
            .ok_or(Error::Closed)?
            .to_path_buf();
        set_private_dir_permissions(&directory)?;
        let mut environment: std::collections::BTreeMap<std::ffi::OsString, std::ffi::OsString> =
            command
                .iter_full_env_as_str()
                .map(|(key, value)| (key.into(), value.into()))
                .collect();
        for (key, _) in std::env::vars_os() {
            if let Some(value) = command.get_env(&key) {
                environment.insert(key, value.to_owned());
            }
        }
        let mut launch = Launch {
            argv: command.get_argv().clone(),
            cwd: command.get_cwd().cloned(),
            environment: environment.into_iter().collect(),
            size,
            base_seq,
        };
        let default_mux_dir = data_dir.join("terminal-mux-host");
        let pin_data_dir = data_dir.clone();
        let versioned_mux_dir = data_dir.join(format!("terminal-mux-host-{}", &expected_hash[..16]));
        let (executable, mux_dir, _spawn_lock, launch) =
            tokio::task::spawn_blocking(move || -> Result<(PathBuf, PathBuf, SpawnLockGuard, Launch)> {
                use fs2::FileExt;
                let cache = pin_data_dir.join("terminal-host-runtime");
                let executable = pin_executable(&exe, &cache, &expected_hash)?;
                let mut selected_mux_dir = default_mux_dir.clone();
                if owner_alive(&default_mux_dir).unwrap_or(false)
                    && let Ok(bytes) = std::fs::read(default_mux_dir.join("mux.json"))
                    && let Ok(info) = serde_json::from_slice::<MuxInfo>(&bytes)
                    && !info
                        .executable
                        .as_deref()
                        .is_some_and(|running_exe| same_executable(running_exe, &executable))
                {
                    selected_mux_dir = versioned_mux_dir;
                }
                set_private_dir_permissions(&selected_mux_dir)?;
                let lock_file = std::fs::OpenOptions::new()
                    .create(true)
                    .truncate(false)
                    .read(true)
                    .write(true)
                    .open(selected_mux_dir.join("spawn.lock"))?;
                lock_file.lock_exclusive()?;
                let guard = SpawnLockGuard(Some(lock_file));

                if launch
                    .argv
                    .first()
                    .is_some_and(|arg| arg == exe.as_os_str())
                {
                    launch.argv[0] = executable.clone().into_os_string();
                }
                let bytes = serde_json::to_vec(&launch)?;
                if bytes.len() > 1024 * 1024 {
                    return Err(Error::Invalid("terminal environment exceeds limit".into()));
                }
                Ok((executable, selected_mux_dir, guard, launch))
            })
            .await
            .map_err(|_| Error::Closed)??;

        let command_strings: Vec<String> = launch
            .argv
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        let cwd_string = launch
            .cwd
            .as_ref()
            .map(|cwd| cwd.to_string_lossy().into_owned());
        let env_strings: Vec<(String, String)> = launch
            .environment
            .iter()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().into_owned(),
                    v.to_string_lossy().into_owned(),
                )
            })
            .collect();
        let spawn_req = MuxSpawnRequest {
            id,
            session_dir: directory.clone(),
            command: command_strings,
            cwd: cwd_string,
            env: env_strings,
            size: launch.size,
            argv: launch.argv,
            cwd_os: launch.cwd,
            environment: launch.environment,
            base_seq: launch.base_seq,
        };

        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|_| Error::Closed)?;

        let mux_info = match read_healthy_mux(&mux_dir, &executable, &client).await {
            Some(info) => info,
            None => {
                let _ = std::fs::remove_file(mux_dir.join("mux.json"));
                let spawn_exec = executable.clone();
                let spawn_dir = mux_dir.clone();
                let mut child = Some(
                    tokio::task::spawn_blocking(move || spawn_mux_process(&spawn_exec, &spawn_dir))
                        .await
                        .map_err(|_| Error::Closed)??,
                );
                let mut connected = None;
                for _ in 0..600 {
                    if let Some(info) = read_healthy_mux(&mux_dir, &executable, &client).await {
                        if let Some(mut running) = child.take() {
                            std::thread::spawn(move || {
                                let _ = running.wait();
                            });
                        }
                        connected = Some(info);
                        break;
                    }
                    if let Some(running) = child.as_mut()
                        && running.try_wait()?.is_some()
                    {
                        return Err(Error::Closed);
                    }
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
                match connected {
                    Some(info) => info,
                    None => {
                        if let Some(mut running) = child.take() {
                            let _ = running.kill();
                            let _ = tokio::task::spawn_blocking(move || running.wait()).await;
                        }
                        return Err(Error::Timeout);
                    }
                }
            }
        };

        let response = client
            .post(format!("{}sessions", mux_info.base_url))
            .bearer_auth(&mux_info.token)
            .json(&spawn_req)
            .send()
            .await
            .map_err(|_| Error::Closed)?;
        let status = response.status();
        if !status.is_success() {
            let bytes = response.bytes().await.unwrap_or_default();
            let error: serde_json::Value = serde_json::from_slice(&bytes).unwrap_or_default();
            return Err(match error["code"].as_str() {
                Some("busy") => Error::Busy,
                Some("timeout") => Error::Timeout,
                _ => match status.as_u16() {
                    400 => Error::Invalid("terminal mux host rejected request".into()),
                    401 => Error::Unauthorized,
                    403 => Error::Forbidden,
                    404 => Error::NotFound,
                    409 => Error::Conflict,
                    429 => Error::Busy,
                    504 => Error::Timeout,
                    _ => Error::Closed,
                },
            });
        }
        drop(_spawn_lock);
        Self::attach(directory).await
    }
    async fn response<T: serde::de::DeserializeOwned>(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<T> {
        let mut response = request
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|_| Error::Closed)?;
        let status = response.status();
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| Error::Closed)? {
            if bytes.len() + chunk.len() > 8 * 1024 * 1024 {
                return Err(Error::Closed);
            }
            bytes.extend_from_slice(&chunk);
        }
        if !status.is_success() {
            let error: serde_json::Value = serde_json::from_slice(&bytes).unwrap_or_default();
            return Err(match error["code"].as_str() {
                Some("terminal_input_failed") => Error::TerminalInput,
                Some("terminal_replay_unavailable") => Error::Feature(
                    "terminal_replay_unavailable".into(),
                    "Terminal replay journal is unavailable".into(),
                ),
                Some("busy") => Error::Busy,
                Some("timeout") => Error::Timeout,
                _ => match status.as_u16() {
                    400 => Error::Invalid("terminal host rejected request".into()),
                    401 => Error::Unauthorized,
                    403 => Error::Forbidden,
                    404 => Error::NotFound,
                    409 => Error::Conflict,
                    429 => Error::Busy,
                    504 => Error::Timeout,
                    _ => Error::Closed,
                },
            });
        }
        serde_json::from_slice(&bytes).map_err(Error::from)
    }
    pub async fn get<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<T> {
        self.response(
            self.client
                .get(format!("{}/{path}", self.url))
                .timeout(Duration::from_secs(8)),
        )
        .await
    }
    pub async fn post<T: Serialize>(&self, path: &str, body: &T) -> Result<()> {
        self.post_with_input_timeout(path, body, Duration::from_secs(10))
            .await
    }
    async fn post_with_input_timeout<T: Serialize>(
        &self,
        path: &str,
        body: &T,
        input_timeout: Duration,
    ) -> Result<()> {
        let is_input = path == "input" || path == "system-input";
        let timeout = if is_input {
            input_timeout
        } else {
            Duration::from_secs(8)
        };
        let request = self
            .client
            .post(format!("{}/{path}", self.url))
            .json(body)
            .timeout(timeout);
        // Input acknowledgement may wait behind PTY backpressure, bounded by
        // `input_timeout` so a stalled child stdin cannot hang forever; a
        // transport timeout maps to `TerminalInput` and must not close the host.
        let result: Result<bool> = self.response(request).await;
        match result {
            Ok(_) => Ok(()),
            Err(Error::Closed | Error::Timeout | Error::Json(_)) if is_input => {
                Err(Error::TerminalInput)
            }
            Err(error) => Err(error),
        }
    }
}

#[derive(Clone)]
struct Owner {
    terminal: Terminal,
    token: Token,
    id: String,
    released: watch::Sender<bool>,
}
async fn auth(
    State(owner): State<Owner>,
    request: axum::extract::Request,
    next: Next,
) -> std::result::Result<Response, ApiError> {
    if !owner.token.accepts(
        request
            .headers()
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .unwrap_or(""),
    ) || request.headers().contains_key("origin")
    {
        return Err(ApiError(Error::Unauthorized));
    }
    Ok(next.run(request).await)
}

async fn host_stream(State(owner): State<Owner>, ws: WebSocketUpgrade) -> Response {
    ws.max_message_size(super::stream::MAX_PAYLOAD + super::stream::HEADER)
        .max_frame_size(super::stream::MAX_PAYLOAD + super::stream::HEADER)
        .on_upgrade(move |socket| async move {
            let _ = super::stream_session::serve(socket, owner.terminal).await;
        })
}
#[derive(Deserialize)]
struct Checkpoint {
    after: Option<i64>,
}
pub fn run(directory: PathBuf) -> Result<()> {
    use fs2::FileExt;
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(directory.join("owner.lock"))?;
    lock.try_lock_exclusive()
        .map_err(|_| Error::AlreadyRunning)?;
    let mut bytes = Vec::new();
    std::io::stdin()
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 1024 * 1024 {
        return Err(Error::Invalid("terminal launch exceeds limit".into()));
    }
    let launch: Launch = serde_json::from_slice(&bytes)?;
    let argv = launch.argv;
    #[cfg(unix)]
    let argv = {
        let mut guarded = vec![
            std::env::current_exe()?.into_os_string(),
            "terminal-guard".into(),
            "--parent".into(),
            std::process::id().to_string().into(),
            "--shell".into(),
        ];
        guarded.push(argv.first().ok_or(Error::Closed)?.clone());
        guarded.push("--".into());
        guarded.extend(argv.into_iter().skip(1));
        guarded
    };
    let mut command = portable_pty::CommandBuilder::from_argv(argv);
    command.env_clear();
    for (k, v) in launch.environment {
        command.env(k, v);
    }
    if let Some(cwd) = launch.cwd {
        command.cwd(cwd);
    }
    let token = Token::load(&directory)?;
    let terminal = super::native::spawn_at(command, launch.size, launch.base_seq)?;
    let id = directory
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or(Error::Unauthorized)?
        .to_owned();
    let cleanup_directory = directory.clone();
    let result = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?
        .block_on(async move {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
            let url = format!("http://{}/", listener.local_addr()?);
            crate::pairing::write_private_json(
                &directory,
                "host.json",
                &serde_json::json!({"base_url":url,"token":token.value(),"pid":std::process::id(),"executable":std::env::current_exe()?}),
            )?;
            let owner = Owner {
                terminal,
                token,
                id,
                released: watch::channel(false).0,
            };
            let mut released = owner.released.subscribe();
            let router = Router::new()
                .route(
                    "/identity",
                    get(|State(o): State<Owner>| async move {
                        Json(serde_json::json!({"id":o.id,"version":1,"capabilities":["terminal.stream.v1","terminal.scrollback.v1"]}))
                    }),
                )
                .route("/stream", get(host_stream))
                .route(
                    "/output",
                    get(
                        |State(o): State<Owner>, Query(q): Query<TerminalQuery>| async move {
                            o.terminal.read(q).await.map(Json).map_err(ApiError)
                        },
                    ),
                )
                .route(
                    "/snapshot",
                    get(|State(o): State<Owner>| async move {
                        tokio::task::spawn_blocking(move || o.terminal.snapshot())
                            .await
                            .map_err(|_| Error::Closed)?
                            .map(Json)
                            .map_err(ApiError)
                    }),
                )
                .route(
                    "/checkpoint",
                    get(
                        |State(o): State<Owner>, Query(q): Query<Checkpoint>| async move {
                            tokio::task::spawn_blocking(move || o.terminal.checkpoint(q.after))
                                .await
                                .map_err(|_| Error::Closed)?
                                .map(Json)
                                .map_err(ApiError)
                        },
                    ),
                )
                .route(
                    "/exited",
                    get(|State(o): State<Owner>| async move {
                        let _ =
                            tokio::time::timeout(Duration::from_secs(5), o.terminal.wait_exited())
                                .await;
                        o.terminal
                            .activity()
                            .map(|a| Json(a.exited))
                            .map_err(ApiError)
                    }),
                )
                .route(
                    "/activity",
                    get(|State(o): State<Owner>| async move {
                        o.terminal.activity().map(Json).map_err(ApiError)
                    }),
                )
                .route(
                    "/input",
                    post(
                        |State(o): State<Owner>, Json(i): Json<TerminalInput>| async move {
                            if !o.terminal.legacy_control_allowed()? { return Err(ApiError(Error::Conflict)); }
                            o.terminal
                                .input(i)
                                .await
                                .map(|_| Json(true))
                                .map_err(ApiError)
                        },
                    ),
                )
                .route(
                    "/system-input",
                    post(
                        |State(o): State<Owner>, Json(i): Json<TerminalInput>| async move {
                            o.terminal
                                .system_input(i)
                                .await
                                .map(|_| Json(true))
                                .map_err(ApiError)
                        },
                    ),
                )
                .route(
                    "/resize",
                    post(
                        |State(o): State<Owner>, Json(s): Json<TerminalSize>| async move {
                            if !o.terminal.legacy_control_allowed()? { return Err(ApiError(Error::Conflict)); }
                            o.terminal
                                .resize(s)
                                .await
                                .map(|_| Json(true))
                                .map_err(ApiError)
                        },
                    ),
                )
                .route(
                    "/close",
                    post(|State(o): State<Owner>| async move {
                        o.terminal.stop();
                        Json(true)
                    }),
                )
                .route(
                    "/reclaim",
                    post(
                        |State(o): State<Owner>, Json(before): Json<i64>| async move {
                            if o.terminal.reclaim_if_idle_prompt(before)? {
                                Ok(Json(true))
                            } else {
                                Err(ApiError(Error::Conflict))
                            }
                        },
                    ),
                )
                .route(
                    "/release",
                    post(|State(o): State<Owner>| async move {
                        if !o.terminal.activity()?.exited {
                            return Err(ApiError(Error::Conflict));
                        }
                        o.released.send_replace(true);
                        Ok(Json(true))
                    }),
                )
                .layer(DefaultBodyLimit::max(32 * 1024))
                .layer(middleware::from_fn_with_state(owner.clone(), auth))
                .with_state(owner.clone());
            let result = axum::serve(crate::transport::LimitedListener::new(listener), router)
                .with_graceful_shutdown(async move {
                    while !*released.borrow_and_update() {
                        if released.changed().await.is_err() {
                            break;
                        }
                    }
                })
                .await;
            // Axum stops accepting normally on graceful shutdown, but upgraded
            // websocket streams live in detached tasks. Keep the PTY reader and
            // output journal alive until viewers ACK final output and receive
            // Exit; cap the wait so a stalled/disconnected viewer cannot pin
            // the owner.
            let stream_drain = drain_terminal_streams(&owner.terminal).await;
            owner.terminal.stop();
            owner.terminal.wait_exited().await;
            let _ = std::fs::remove_file(directory.join("host.json"));
            drop(stream_drain);
            result.map_err(Error::from)
        });
    drop(lock);
    if result.is_ok() {
        let _ = std::fs::remove_dir_all(cleanup_directory);
    }
    result
}

struct MuxSession {
    id: String,
    session_dir: PathBuf,
    terminal: Terminal,
    token: Token,
    owner_lock: std::sync::Mutex<Option<std::fs::File>>,
}

struct MuxState {
    mux_dir: PathBuf,
    port: u16,
    mux_token: Token,
    sessions: std::sync::RwLock<HashMap<String, Arc<MuxSession>>>,
    inflight_creates: AtomicUsize,
    had_session: AtomicBool,
    shutting_down: AtomicBool,
    idle_notify: tokio::sync::Notify,
}

impl MuxState {
    fn get_session(&self, id: &str) -> Option<Arc<MuxSession>> {
        self.sessions.read().ok()?.get(id).cloned()
    }

    fn active_count(&self) -> usize {
        self.sessions.read().map_or(0, |map| map.len())
    }
}

struct InflightGuard(Arc<MuxState>);

impl InflightGuard {
    fn new(state: Arc<MuxState>) -> Self {
        state.inflight_creates.fetch_add(1, Ordering::AcqRel);
        Self(state)
    }
}

impl Drop for InflightGuard {
    fn drop(&mut self) {
        self.0.inflight_creates.fetch_sub(1, Ordering::AcqRel);
        self.0.idle_notify.notify_waiters();
    }
}

fn build_hosted_command(
    argv: Vec<std::ffi::OsString>,
    cwd: Option<std::ffi::OsString>,
    environment: Vec<(std::ffi::OsString, std::ffi::OsString)>,
) -> Result<portable_pty::CommandBuilder> {
    if argv.is_empty() {
        return Err(Error::Invalid("empty terminal command".into()));
    }
    #[cfg(unix)]
    let argv = {
        let mut guarded = vec![
            std::env::current_exe()?.into_os_string(),
            "terminal-guard".into(),
            "--parent".into(),
            std::process::id().to_string().into(),
            "--shell".into(),
        ];
        guarded.push(argv.first().ok_or(Error::Closed)?.clone());
        guarded.push("--".into());
        guarded.extend(argv.into_iter().skip(1));
        guarded
    };
    let mut command = portable_pty::CommandBuilder::from_argv(argv);
    command.env_clear();
    for (k, v) in environment {
        command.env(k, v);
    }
    if let Some(cwd) = cwd {
        command.cwd(cwd);
    }
    Ok(command)
}

async fn cleanup_mux_session(session: &MuxSession) {
    let stream_drain = drain_terminal_streams(&session.terminal).await;
    session.terminal.stop();
    session.terminal.wait_exited().await;
    drop(stream_drain);
    let session_dir = session.session_dir.clone();
    let owner_lock = session
        .owner_lock
        .lock()
        .ok()
        .and_then(|mut guard| guard.take());
    let _ = tokio::task::spawn_blocking(move || {
        let _ = std::fs::remove_file(session_dir.join("host.json"));
        if let Some(lock) = owner_lock {
            let _ = fs2::FileExt::unlock(&lock);
            drop(lock);
        }
        let _ = std::fs::remove_file(session_dir.join("owner.lock"));
        let _ = std::fs::remove_dir_all(&session_dir);
    })
    .await;
}

async fn mux_control_auth(
    State(state): State<Arc<MuxState>>,
    request: axum::extract::Request,
    next: Next,
) -> std::result::Result<Response, ApiError> {
    if !state.mux_token.accepts(
        request
            .headers()
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .unwrap_or(""),
    ) || request.headers().contains_key("origin")
    {
        return Err(ApiError(Error::Unauthorized));
    }
    Ok(next.run(request).await)
}

async fn mux_session_auth(
    State(state): State<Arc<MuxState>>,
    mut request: axum::extract::Request,
    next: Next,
) -> std::result::Result<Response, ApiError> {
    if request.headers().contains_key("origin") {
        return Err(ApiError(Error::Unauthorized));
    }
    let auth_header = request
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let session_id = request
        .uri()
        .path()
        .strip_prefix("/s/")
        .and_then(|rest| rest.split('/').next())
        .filter(|id| !id.is_empty())
        .ok_or(ApiError(Error::Unauthorized))?;
    let Some(session) = state.get_session(session_id) else {
        if !auth_header.starts_with("Bearer ") {
            return Err(ApiError(Error::Unauthorized));
        }
        return Err(ApiError(Error::NotFound));
    };
    if !session.token.accepts(auth_header) {
        return Err(ApiError(Error::Unauthorized));
    }
    request.extensions_mut().insert(session);
    Ok(next.run(request).await)
}

async fn mux_health(
    State(state): State<Arc<MuxState>>,
) -> std::result::Result<Json<serde_json::Value>, ApiError> {
    if state.shutting_down.load(Ordering::Acquire) {
        return Err(ApiError(Error::Closed));
    }
    Ok(Json(serde_json::json!({
        "ok": true,
        "version": 1,
        "pid": std::process::id(),
        "sessions": state.active_count(),
    })))
}

async fn mux_create_session(
    State(state): State<Arc<MuxState>>,
    Json(req): Json<MuxSpawnRequest>,
) -> std::result::Result<Json<serde_json::Value>, ApiError> {
    let _inflight = InflightGuard::new(state.clone());
    if state.shutting_down.load(Ordering::Acquire) {
        return Err(ApiError(Error::Closed));
    }
    if req.id.is_empty()
        || req.id.contains('/')
        || req.id.contains('\\')
        || req.id == "."
        || req.id == ".."
        || req.session_dir.file_name().and_then(|s| s.to_str()) != Some(req.id.as_str())
    {
        return Err(ApiError(Error::Invalid(
            "invalid terminal session id".into(),
        )));
    }
    if state.get_session(&req.id).is_some() {
        return Err(ApiError(Error::Conflict));
    }

    let port = state.port;
    let session = tokio::task::spawn_blocking(move || -> Result<MuxSession> {
        use fs2::FileExt;
        set_private_dir_permissions(&req.session_dir)?;
        let owner_lock = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(req.session_dir.join("owner.lock"))?;
        owner_lock
            .try_lock_exclusive()
            .map_err(|_| Error::AlreadyRunning)?;

        let argv = if !req.argv.is_empty() {
            req.argv
        } else {
            req.command.iter().map(std::ffi::OsString::from).collect()
        };
        let cwd = req
            .cwd_os
            .or_else(|| req.cwd.as_ref().map(std::ffi::OsString::from));
        let environment = if !req.environment.is_empty() {
            req.environment
        } else {
            req.env
                .iter()
                .map(|(k, v)| (std::ffi::OsString::from(k), std::ffi::OsString::from(v)))
                .collect()
        };
        let command = build_hosted_command(argv, cwd, environment)?;
        let terminal = super::native::spawn_at(command, req.size, req.base_seq)?;
        let session_token = Token::generate();
        let base_url = format!("http://127.0.0.1:{port}/s/{}/", req.id);
        let bounded_command: Vec<String> = req
            .command
            .iter()
            .take(8)
            .map(|arg| truncate_utf8_prefix(arg, 256))
            .collect();
        let bounded_cwd = req
            .cwd
            .as_deref()
            .map(|value| truncate_utf8_prefix(value, 512));
        let created_at = crate::database::now();
        crate::pairing::write_private_json(
            &req.session_dir,
            "host.json",
            &serde_json::json!({
                "version": 2,
                "id": req.id,
                "pid": std::process::id(),
                "base_url": base_url,
                "token": session_token.value(),
                "executable": std::env::current_exe()?,
                "command": bounded_command,
                "cwd": bounded_cwd,
                "created_at": created_at,
            }),
        )?;
        Ok(MuxSession {
            id: req.id,
            session_dir: req.session_dir,
            terminal,
            token: session_token,
            owner_lock: std::sync::Mutex::new(Some(owner_lock)),
        })
    })
    .await
    .map_err(|_| Error::Closed)??;

    let session_id = session.id.clone();
    let base_url = format!("http://127.0.0.1:{port}/s/{session_id}/");
    let arc_session = Arc::new(session);
    let conflict_or_closing = {
        let mut map = state
            .sessions
            .write()
            .map_err(|_| ApiError(Error::Closed))?;
        if state.shutting_down.load(Ordering::Acquire) {
            Some(Error::Closed)
        } else if map.contains_key(&session_id) {
            Some(Error::Conflict)
        } else {
            map.insert(session_id.clone(), arc_session.clone());
            state.had_session.store(true, Ordering::Release);
            None
        }
    };
    if let Some(error) = conflict_or_closing {
        cleanup_mux_session(&arc_session).await;
        return Err(ApiError(error));
    }

    Ok(Json(serde_json::json!({
        "id": session_id,
        "pid": std::process::id(),
        "base_url": base_url,
    })))
}

async fn mux_session_stream(
    Extension(session): Extension<Arc<MuxSession>>,
    ws: WebSocketUpgrade,
) -> Response {
    let terminal = session.terminal.clone();
    ws.max_message_size(super::stream::MAX_PAYLOAD + super::stream::HEADER)
        .max_frame_size(super::stream::MAX_PAYLOAD + super::stream::HEADER)
        .on_upgrade(move |socket| async move {
            let _ = super::stream_session::serve(socket, terminal).await;
        })
}

pub fn run_mux(directory: &std::path::Path) -> Result<()> {
    use fs2::FileExt;
    set_private_dir_permissions(directory)?;
    let owner_lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(directory.join("owner.lock"))?;
    owner_lock
        .try_lock_exclusive()
        .map_err(|_| Error::AlreadyRunning)?;

    let mux_dir = directory.to_path_buf();
    let result = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?
        .block_on(async move {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
            let port = listener.local_addr()?.port();
            let base_url = format!("http://127.0.0.1:{port}/");
            let mux_token = Token::generate();
            let state = Arc::new(MuxState {
                mux_dir: mux_dir.clone(),
                port,
                mux_token: mux_token.clone(),
                sessions: std::sync::RwLock::new(HashMap::new()),
                inflight_creates: AtomicUsize::new(0),
                had_session: AtomicBool::new(false),
                shutting_down: AtomicBool::new(false),
                idle_notify: tokio::sync::Notify::new(),
            });
            crate::pairing::write_private_json(
                &mux_dir,
                "mux.json",
                &MuxInfo {
                    version: 1,
                    pid: std::process::id(),
                    base_url,
                    token: mux_token.value().to_owned(),
                    executable: std::env::current_exe().ok(),
                },
            )?;

            let control_router = Router::new()
                .route("/health", get(mux_health))
                .route(
                    "/sessions",
                    post(mux_create_session).layer(DefaultBodyLimit::max(1024 * 1024 + 64 * 1024)),
                )
                .layer(middleware::from_fn_with_state(
                    state.clone(),
                    mux_control_auth,
                ))
                .with_state(state.clone());

            let identity_handler = |Extension(s): Extension<Arc<MuxSession>>| async move {
                Json(serde_json::json!({
                    "id": s.id,
                    "version": 1,
                    "capabilities": ["terminal.stream.v1", "terminal.scrollback.v1"],
                }))
            };
            let output_handler = |Extension(s): Extension<Arc<MuxSession>>,
                                  Query(q): Query<TerminalQuery>| async move {
                s.terminal.read(q).await.map(Json).map_err(ApiError)
            };

            let session_router = Router::new()
                .route("/s/{id}/identity", get(identity_handler))
                .route("/s/{id}/meta", get(identity_handler))
                .route("/s/{id}/stream", get(mux_session_stream))
                .route("/s/{id}/output", get(output_handler))
                .route("/s/{id}/events", get(output_handler))
                .route(
                    "/s/{id}/snapshot",
                    get(|Extension(s): Extension<Arc<MuxSession>>| async move {
                        tokio::task::spawn_blocking(move || s.terminal.snapshot())
                            .await
                            .map_err(|_| Error::Closed)?
                            .map(Json)
                            .map_err(ApiError)
                    }),
                )
                .route(
                    "/s/{id}/checkpoint",
                    get(
                        |Extension(s): Extension<Arc<MuxSession>>,
                         Query(q): Query<Checkpoint>| async move {
                            tokio::task::spawn_blocking(move || s.terminal.checkpoint(q.after))
                                .await
                                .map_err(|_| Error::Closed)?
                                .map(Json)
                                .map_err(ApiError)
                        },
                    ),
                )
                .route(
                    "/s/{id}/exited",
                    get(|Extension(s): Extension<Arc<MuxSession>>| async move {
                        let _ =
                            tokio::time::timeout(Duration::from_secs(5), s.terminal.wait_exited())
                                .await;
                        s.terminal
                            .activity()
                            .map(|a| Json(a.exited))
                            .map_err(ApiError)
                    }),
                )
                .route(
                    "/s/{id}/activity",
                    get(|Extension(s): Extension<Arc<MuxSession>>| async move {
                        s.terminal.activity().map(Json).map_err(ApiError)
                    }),
                )
                .route(
                    "/s/{id}/input",
                    post(
                        |Extension(s): Extension<Arc<MuxSession>>,
                         Json(i): Json<TerminalInput>| async move {
                            if !s.terminal.legacy_control_allowed()? {
                                return Err(ApiError(Error::Conflict));
                            }
                            s.terminal
                                .input(i)
                                .await
                                .map(|_| Json(true))
                                .map_err(ApiError)
                        },
                    ),
                )
                .route(
                    "/s/{id}/system-input",
                    post(
                        |Extension(s): Extension<Arc<MuxSession>>,
                         Json(i): Json<TerminalInput>| async move {
                            s.terminal
                                .system_input(i)
                                .await
                                .map(|_| Json(true))
                                .map_err(ApiError)
                        },
                    ),
                )
                .route(
                    "/s/{id}/resize",
                    post(
                        |Extension(s): Extension<Arc<MuxSession>>,
                         Json(size): Json<TerminalSize>| async move {
                            if !s.terminal.legacy_control_allowed()? {
                                return Err(ApiError(Error::Conflict));
                            }
                            s.terminal
                                .resize(size)
                                .await
                                .map(|_| Json(true))
                                .map_err(ApiError)
                        },
                    ),
                )
                .route(
                    "/s/{id}/close",
                    post(|Extension(s): Extension<Arc<MuxSession>>| async move {
                        s.terminal.stop();
                        Json(true)
                    }),
                )
                .route(
                    "/s/{id}/reclaim",
                    post(
                        |Extension(s): Extension<Arc<MuxSession>>,
                         Json(before): Json<i64>| async move {
                            if s.terminal.reclaim_if_idle_prompt(before)? {
                                Ok(Json(true))
                            } else {
                                Err(ApiError(Error::Conflict))
                            }
                        },
                    ),
                )
                .route(
                    "/s/{id}/release",
                    post(
                        |State(mux): State<Arc<MuxState>>,
                         Extension(s): Extension<Arc<MuxSession>>| async move {
                            if !s.terminal.activity()?.exited {
                                return Err(ApiError(Error::Conflict));
                            }
                            let removed = mux
                                .sessions
                                .write()
                                .ok()
                                .and_then(|mut map| map.remove(&s.id));
                            if let Some(session) = removed {
                                cleanup_mux_session(&session).await;
                                mux.idle_notify.notify_waiters();
                            }
                            Ok(Json(true))
                        },
                    ),
                )
                .layer(DefaultBodyLimit::max(32 * 1024))
                .layer(middleware::from_fn_with_state(
                    state.clone(),
                    mux_session_auth,
                ))
                .with_state(state.clone());

            let router = control_router.merge(session_router);
            let idle_state = state.clone();
            let serve_result =
                axum::serve(crate::transport::LimitedListener::new(listener), router)
                    .with_graceful_shutdown(async move {
                        let idle_exit = async move {
                            loop {
                                let notified = idle_state.idle_notify.notified();
                                tokio::pin!(notified);
                                notified.as_mut().enable();

                                let is_idle = idle_state.had_session.load(Ordering::Acquire)
                                    && idle_state.active_count() == 0
                                    && idle_state.inflight_creates.load(Ordering::Acquire) == 0;
                                if !is_idle {
                                    notified.await;
                                    continue;
                                }

                                tokio::select! {
                                    _ = tokio::time::sleep(MUX_IDLE_EXIT_GRACE) => {}
                                    _ = notified => continue,
                                }

                                if idle_state.active_count() != 0
                                    || idle_state.inflight_creates.load(Ordering::Acquire) != 0
                                {
                                    continue;
                                }

                                if !idle_state.mux_dir.exists() {
                                    idle_state.shutting_down.store(true, Ordering::Release);
                                    break;
                                }
                                let lock_path = idle_state.mux_dir.join("spawn.lock");
                                let maybe_lock = std::fs::OpenOptions::new()
                                    .create(true)
                                    .truncate(false)
                                    .read(true)
                                    .write(true)
                                    .open(&lock_path)
                                    .ok();
                                let Some(lock_file) = maybe_lock else {
                                    if !idle_state.mux_dir.exists() {
                                        idle_state.shutting_down.store(true, Ordering::Release);
                                        break;
                                    }
                                    tokio::time::sleep(Duration::from_millis(25)).await;
                                    continue;
                                };
                                if lock_file.try_lock_exclusive().is_err() {
                                    // A client is actively spawning under spawn.lock right now.
                                    tokio::time::sleep(Duration::from_millis(25)).await;
                                    continue;
                                }
                                let _guard = SpawnLockGuard(Some(lock_file));
                                let can_exit = idle_state
                                    .sessions
                                    .write()
                                    .map(|map| {
                                        map.is_empty()
                                            && idle_state.inflight_creates.load(Ordering::Acquire)
                                                == 0
                                    })
                                    .unwrap_or(false);
                                if can_exit {
                                    idle_state.shutting_down.store(true, Ordering::Release);
                                    let _ =
                                        std::fs::remove_file(idle_state.mux_dir.join("mux.json"));
                                    break;
                                }
                            }
                        };
                        #[cfg(unix)]
                        {
                            let mut sigterm = tokio::signal::unix::signal(
                                tokio::signal::unix::SignalKind::terminate(),
                            )
                            .ok();
                            tokio::select! {
                                _ = idle_exit => {}
                                _ = tokio::signal::ctrl_c() => {}
                                _ = async {
                                    match sigterm.as_mut() {
                                        Some(sig) => { let _ = sig.recv().await; }
                                        None => std::future::pending::<()>().await,
                                    }
                                } => {}
                            }
                        }
                        #[cfg(not(unix))]
                        {
                            tokio::select! {
                                _ = idle_exit => {}
                                _ = tokio::signal::ctrl_c() => {}
                            }
                        }
                    })
                    .await;

            state.shutting_down.store(true, Ordering::Release);
            let _ = std::fs::remove_file(mux_dir.join("mux.json"));
            let remaining: Vec<Arc<MuxSession>> = state
                .sessions
                .write()
                .map(|mut map| map.drain().map(|(_, v)| v).collect())
                .unwrap_or_default();
            for session in remaining {
                cleanup_mux_session(&session).await;
            }
            serve_result.map_err(Error::from)
        });
    let _ = fs2::FileExt::unlock(&owner_lock);
    drop(owner_lock);
    result
}

/// Finish the acknowledgement if a daemon died after archiving an exited
/// session but before releasing its host. Never stop an untracked live shell.
pub(crate) async fn reap_exited(root: PathBuf, active: &[String]) -> Result<()> {
    let mut entries = match tokio::fs::read_dir(root).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    while let Some(entry) = entries.next_entry().await? {
        if !entry.file_type().await?.is_dir()
            || active.iter().any(|id| entry.file_name() == id.as_str())
        {
            continue;
        }
        if let Ok(host) = Host::attach(entry.path()).await
            && host
                .get::<TerminalActivity>("activity")
                .await
                .is_ok_and(|a| a.exited)
        {
            let _ = host.post("release", &true).await;
        }
    }
    Ok(())
}

/// Content-addressed executable copies survive application replacement. Never
/// overwrite a cached image: an older host may still have it mapped.
fn pin_executable(
    source: &std::path::Path,
    cache: &std::path::Path,
    expected: &str,
) -> Result<PathBuf> {
    use sha2::{Digest, Sha256};
    fn digest(path: &std::path::Path) -> Result<String> {
        let mut file = std::fs::File::open(path)?;
        let mut hash = Sha256::new();
        let mut buffer = [0u8; 65536];
        loop {
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            hash.update(&buffer[..count]);
        }
        Ok(hash
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>())
    }
    if expected.len() != 64 || !expected.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(Error::Invalid("invalid terminal runtime identity".into()));
    }
    let root = cache.join(expected);
    std::fs::create_dir_all(&root)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(cache, std::fs::Permissions::from_mode(0o700))?;
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))?;
    }
    let target = root.join(if cfg!(windows) {
        "prosperod-rs.exe"
    } else {
        "prosperod-rs"
    });
    if target.exists() {
        if digest(&target)? != expected {
            return Err(Error::Invalid("terminal runtime cache is invalid".into()));
        }
        return Ok(target);
    }
    let mut file = std::fs::File::open(source)?;
    let mut staged = tempfile::NamedTempFile::new_in(&root)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        staged.write_all(&buffer[..count])?;
        hash.update(&buffer[..count]);
    }
    if hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
        != expected
    {
        return Err(Error::Invalid(
            "daemon executable changed; restart before creating a terminal".into(),
        ));
    }
    staged.as_file().sync_all()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        staged
            .as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o700))?;
    }
    match staged.persist_noclobber(&target) {
        Ok(_) => {}
        Err(error)
            if error.error.kind() == std::io::ErrorKind::AlreadyExists
                && digest(&target)? == expected => {}
        Err(error) => return Err(error.error.into()),
    }
    Ok(target)
}

/// A locked owner file indicates a live host, without trusting/reusing a PID.
pub(crate) fn owner_alive(directory: &std::path::Path) -> Result<bool> {
    use fs2::FileExt;
    let file = match std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(directory.join("owner.lock"))
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    Ok(file.try_lock_exclusive().is_err())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    async fn stream_for_drain_test(
        axum::extract::State(terminal): axum::extract::State<Terminal>,
        ws: WebSocketUpgrade,
    ) -> Response {
        ws.on_upgrade(move |socket| async move {
            let _ = super::super::stream_session::serve(socket, terminal).await;
        })
    }

    /// A detached websocket must be able to flush the final finite output and
    /// receive Exit after the listener has stopped accepting connections.
    #[cfg(unix)]
    #[tokio::test]
    async fn graceful_host_shutdown_drains_acknowledged_final_output() {
        use axum::routing::get;
        use futures_util::{SinkExt, StreamExt};
        use portable_pty::CommandBuilder;
        use tokio_tungstenite::tungstenite::Message;

        let size = TerminalSize { cols: 80, rows: 24 };
        let mut command = CommandBuilder::new("/bin/sh");
        command.arg("-c");
        command.arg("IFS= read -r start; printf 'BEGIN\\n'; head -c 768000 /dev/zero | tr '\\000' x; printf '\\nEND\\n'");
        let terminal = super::super::native::spawn(command, size).unwrap();
        let epoch = terminal.epoch().to_owned();

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        let serving_terminal = terminal.clone();
        let server = tokio::spawn(async move {
            let app = Router::new()
                .route("/stream", get(stream_for_drain_test))
                .with_state(serving_terminal.clone());
            let result = axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.await;
                })
                .await;
            let drain = drain_terminal_streams(&serving_terminal).await;
            serving_terminal.stop();
            serving_terminal.wait_exited().await;
            drop(drain);
            result
        });

        let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{address}/stream"))
            .await
            .unwrap();
        let attach = super::super::stream::Frame {
            kind: super::super::stream::Kind::Attach,
            sequence: 0,
            payload: serde_json::json!({ "wantControl": true })
                .to_string()
                .into_bytes(),
        };
        socket
            .send(Message::Binary(
                super::super::stream::encode(&attach).unwrap().into(),
            ))
            .await
            .unwrap();

        let mut last_applied = 0;
        loop {
            let message = socket.next().await.unwrap().unwrap();
            let Message::Binary(bytes) = message else {
                continue;
            };
            let frame = super::super::stream::decode(&bytes).unwrap();
            match frame.kind {
                super::super::stream::Kind::Snapshot => {
                    last_applied = frame.sequence;
                    let applied = super::super::stream::Frame {
                        kind: super::super::stream::Kind::Applied,
                        sequence: last_applied,
                        payload: vec![],
                    };
                    socket
                        .send(Message::Binary(
                            super::super::stream::encode(&applied).unwrap().into(),
                        ))
                        .await
                        .unwrap();
                }
                super::super::stream::Kind::Ready => break,
                _ => {}
            }
        }
        let input = super::super::stream::Frame {
            kind: super::super::stream::Kind::Input,
            sequence: 1,
            payload: b"go\r".to_vec(),
        };
        socket
            .send(Message::Binary(
                super::super::stream::encode(&input).unwrap().into(),
            ))
            .await
            .unwrap();

        // Leave credit outstanding without requiring an exact window-sized
        // boundary; an output chunk can be rejected just below the limit.
        let mut received_bytes = 0usize;
        while received_bytes < super::super::stream::WINDOW_BYTES / 2 {
            let message = tokio::time::timeout(Duration::from_secs(10), socket.next())
                .await
                .expect("stream should deliver up to its credit window")
                .unwrap()
                .unwrap();
            let Message::Binary(bytes) = message else {
                continue;
            };
            let frame = super::super::stream::decode(&bytes).unwrap();
            if matches!(
                frame.kind,
                super::super::stream::Kind::Output | super::super::stream::Kind::Resize
            ) {
                received_bytes += frame.payload.len();
                last_applied = frame.sequence;
            }
        }
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if terminal.activity().unwrap().exited {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("finite child should exit while stream credit is held");

        shutdown_tx.send(()).unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            !server.is_finished(),
            "host must wait for the attached stream"
        );

        let applied = super::super::stream::Frame {
            kind: super::super::stream::Kind::Applied,
            sequence: last_applied,
            payload: vec![],
        };
        socket
            .send(Message::Binary(
                super::super::stream::encode(&applied).unwrap().into(),
            ))
            .await
            .unwrap();

        let mut output = Vec::new();
        let exit_code = loop {
            let message = tokio::time::timeout(Duration::from_secs(10), socket.next())
                .await
                .expect("host drain should preserve the stream")
                .unwrap()
                .unwrap();
            let Message::Binary(bytes) = message else {
                continue;
            };
            let frame = super::super::stream::decode(&bytes).unwrap();
            match frame.kind {
                super::super::stream::Kind::Output | super::super::stream::Kind::Resize => {
                    last_applied = frame.sequence;
                    if frame.kind == super::super::stream::Kind::Output {
                        output.extend(frame.payload);
                    }
                    let applied = super::super::stream::Frame {
                        kind: super::super::stream::Kind::Applied,
                        sequence: last_applied,
                        payload: vec![],
                    };
                    socket
                        .send(Message::Binary(
                            super::super::stream::encode(&applied).unwrap().into(),
                        ))
                        .await
                        .unwrap();
                }
                super::super::stream::Kind::Exit => {
                    break serde_json::from_slice::<serde_json::Value>(&frame.payload)
                        .unwrap()["exitCode"]
                        .as_u64()
                        .unwrap();
                }
                _ => {}
            }
        };
        assert_eq!(exit_code, 0);
        assert!(output.windows(3).any(|bytes| bytes == b"END"));
        assert_eq!(
            terminal.epoch(),
            epoch,
            "drain must not spawn a replacement PTY"
        );
        tokio::time::timeout(Duration::from_secs(2), server)
            .await
            .expect("host cleanup should finish after Exit")
            .unwrap()
            .unwrap();
    }

    #[test]
    fn pinned_runtime_is_immutable_when_the_application_binary_changes() {
        use sha2::{Digest, Sha256};
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let cache = root.path().join("runtime");
        std::fs::write(&source, b"version one").unwrap();
        let first = Sha256::digest(b"version one")
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let pinned = pin_executable(&source, &cache, &first).unwrap();
        std::fs::write(&source, b"version two").unwrap();
        assert_eq!(pin_executable(&source, &cache, &first).unwrap(), pinned);
        assert_eq!(std::fs::read(&pinned).unwrap(), b"version one");
        let second = Sha256::digest(b"version two")
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        assert_ne!(pin_executable(&source, &cache, &second).unwrap(), pinned);
        std::fs::write(&pinned, b"corrupt").unwrap();
        assert!(pin_executable(&source, &cache, &first).is_err());
    }
    #[tokio::test]
    async fn host_descriptors_reject_oversize_and_non_loopback_addresses() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("host.json"), vec![b'x'; 4097]).unwrap();
        assert!(matches!(
            Host::attach(root.path().to_owned()).await,
            Err(Error::Invalid(_))
        ));
        std::fs::write(
            root.path().join("host.json"),
            serde_json::json!({"base_url":"https://example.invalid:443/","token":"a".repeat(64)})
                .to_string(),
        )
        .unwrap();
        assert!(matches!(
            Host::attach(root.path().to_owned()).await,
            Err(Error::Unauthorized)
        ));
    }

    #[tokio::test]
    async fn input_transport_has_no_request_timeout_but_keeps_connect_bound() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0_u8; 4096];
            let _ = socket.read(&mut request).await.unwrap();
            tokio::time::sleep(Duration::from_millis(8_200)).await;
            socket
                .write_all(b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 4\r\nconnection: close\r\n\r\ntrue")
                .await
                .unwrap();
        });
        let host = Host {
            stream_supported: false,
            scrollback_supported: false,
            fallback_stream: Arc::default(),
            directory: tempfile::tempdir().unwrap().path().to_owned(),
            url: format!("http://{address}"),
            token: "token".into(),
            client: reqwest::Client::builder()
                .no_proxy()
                .connect_timeout(Duration::from_secs(2))
                .build()
                .unwrap(),
        };
        let result = host
            .input(TerminalInput {
                data_b64: "eA==".into(),
            })
            .await;
        assert!(result.is_ok());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn ambiguous_input_reply_does_not_close_or_replay_the_terminal() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 4096];
            let count = socket.read(&mut request).await.unwrap();
            assert!(String::from_utf8_lossy(&request[..count]).starts_with("POST /system-input "));
            socket
                .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 1\r\nconnection: close\r\n\r\nx")
                .await
                .unwrap();
            drop(socket);
            assert!(
                tokio::time::timeout(Duration::from_millis(250), listener.accept())
                    .await
                    .is_err(),
                "no automatic close or replay after an ambiguous reply"
            );
        });
        let directory = tempfile::tempdir().unwrap();
        let host = Host {
            stream_supported: false,
            scrollback_supported: false,
            fallback_stream: Arc::default(),
            directory: directory.path().to_owned(),
            url: format!("http://{address}"),
            token: "token".into(),
            client: reqwest::Client::builder()
                .no_proxy()
                .connect_timeout(Duration::from_secs(2))
                .build()
                .unwrap(),
        };
        assert!(matches!(
            host.input(TerminalInput {
                data_b64: "eA==".into()
            })
            .await,
            Err(Error::TerminalInput)
        ));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn stalled_input_times_out_with_terminal_input_error() {
        use tokio::io::AsyncReadExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0_u8; 4096];
                let _ = socket.read(&mut request).await.unwrap();
                tokio::time::sleep(Duration::from_millis(400)).await;
            }
        });
        let directory = tempfile::tempdir().unwrap();
        let host = Host {
            stream_supported: false,
            scrollback_supported: false,
            fallback_stream: Arc::default(),
            directory: directory.path().to_owned(),
            url: format!("http://{address}"),
            token: "token".into(),
            client: reqwest::Client::builder()
                .no_proxy()
                .connect_timeout(Duration::from_secs(2))
                .build()
                .unwrap(),
        };
        for path in ["system-input", "input"] {
            let err = host
                .post_with_input_timeout(
                    path,
                    &TerminalInput {
                        data_b64: "eA==".into(),
                    },
                    Duration::from_millis(120),
                )
                .await;
            assert!(matches!(err, Err(Error::TerminalInput)));
        }
        server.await.unwrap();
    }

    #[cfg(unix)]
    fn test_daemon_binary() -> (PathBuf, String) {
        use sha2::{Digest, Sha256};
        static BUILD_ONCE: std::sync::Once = std::sync::Once::new();
        let current = std::env::current_exe().unwrap();
        let target_dir = current
            .parent()
            .and_then(|deps| deps.parent())
            .expect("test binary lives under target/<profile>/deps");
        let bin = target_dir.join("prosperod-rs");
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let bin_mtime = std::fs::metadata(&bin).and_then(|m| m.modified()).ok();
        let needs_rebuild = bin_mtime.is_none_or(|built_at| {
            [
                manifest_dir.join("src/main.rs"),
                manifest_dir.join("src/terminal/host.rs"),
            ]
            .iter()
            .filter_map(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok())
            .any(|src_mtime| src_mtime > built_at)
        });
        if needs_rebuild {
            BUILD_ONCE.call_once(|| {
                let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
                let manifest = manifest_dir.join("Cargo.toml");
                let status = std::process::Command::new(cargo)
                    .args(["build", "--bin", "prosperod-rs", "--manifest-path"])
                    .arg(manifest)
                    .status()
                    .expect("failed to invoke cargo build --bin prosperod-rs");
                assert!(status.success(), "cargo build --bin prosperod-rs failed");
            });
        }
        let bytes = std::fs::read(&bin).expect("prosperod-rs binary must exist");
        let digest = Sha256::digest(&bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        (bin, digest)
    }

    #[cfg(unix)]
    async fn read_until_contains(host: &Host, route: &str, needle: &str) -> String {
        use base64::{Engine, engine::general_purpose::STANDARD};
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                let page: TerminalPage = host
                    .get(&format!("{route}?afterSeq=0"))
                    .await
                    .expect("output read should succeed");
                let combined: String = page
                    .events
                    .iter()
                    .filter_map(|ev| match ev {
                        TerminalEvent::Output { data_b64 } => STANDARD
                            .decode(data_b64)
                            .ok()
                            .map(|b| String::from_utf8_lossy(&b).into_owned()),
                        _ => None,
                    })
                    .collect();
                if combined.contains(needle) {
                    return combined;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for {needle:?}"))
    }

    #[cfg(unix)]
    async fn close_and_release(host: &Host) {
        host.post("close", &true).await.unwrap();
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                if host.get::<bool>("exited").await.unwrap_or(false) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(15)).await;
            }
        })
        .await
        .expect("session should exit after close");
        host.post("release", &true).await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn mux_host_shares_single_process_isolates_sessions_and_exits_when_idle() {
        use base64::{Engine, engine::general_purpose::STANDARD};

        let (exe, hash) = test_daemon_binary();
        let data_dir = tempfile::tempdir().unwrap();
        let hosts_dir = data_dir.path().join("terminal-hosts");
        let alpha_dir = hosts_dir.join("sess-alpha");
        let beta_dir = hosts_dir.join("sess-beta");
        let size = TerminalSize { cols: 80, rows: 24 };

        let mut cmd_a = portable_pty::CommandBuilder::new("/bin/sh");
        cmd_a.cwd(data_dir.path());
        let mut cmd_b = portable_pty::CommandBuilder::new("/bin/sh");
        cmd_b.cwd(data_dir.path());

        let alpha = Host::start_at(exe.clone(), alpha_dir.clone(), cmd_a, size, hash.clone(), 0)
            .await
            .unwrap();
        let beta = Host::start_at(exe.clone(), beta_dir.clone(), cmd_b, size, hash.clone(), 0)
            .await
            .unwrap();

        let alpha_info: serde_json::Value =
            serde_json::from_slice(&std::fs::read(alpha_dir.join("host.json")).unwrap()).unwrap();
        let beta_info: serde_json::Value =
            serde_json::from_slice(&std::fs::read(beta_dir.join("host.json")).unwrap()).unwrap();
        let mux_dir = data_dir.path().join("terminal-mux-host");
        let mux_info: serde_json::Value =
            serde_json::from_slice(&std::fs::read(mux_dir.join("mux.json")).unwrap()).unwrap();

        assert_eq!(alpha_info["version"], 2);
        assert_eq!(beta_info["version"], 2);
        let mux_pid = mux_info["pid"].as_i64().unwrap() as i32;
        assert_eq!(alpha_info["pid"].as_i64().unwrap() as i32, mux_pid);
        assert_eq!(beta_info["pid"].as_i64().unwrap() as i32, mux_pid);
        assert_ne!(alpha_info["token"], beta_info["token"]);
        assert!(
            alpha_info["base_url"]
                .as_str()
                .unwrap()
                .ends_with("/s/sess-alpha/"),
            "trailing slash must be present on base_url: {}",
            alpha_info["base_url"]
        );
        assert!(
            beta_info["base_url"]
                .as_str()
                .unwrap()
                .ends_with("/s/sess-beta/")
        );
        assert!(owner_alive(&alpha_dir).unwrap());
        assert!(owner_alive(&beta_dir).unwrap());

        // Cross-session token isolation + /meta alias check.
        let raw_client = reqwest::Client::builder().no_proxy().build().unwrap();
        let cross_resp = raw_client
            .get(format!("{}meta", beta_info["base_url"].as_str().unwrap()))
            .bearer_auth(alpha_info["token"].as_str().unwrap())
            .send()
            .await
            .unwrap();
        assert_eq!(cross_resp.status().as_u16(), 401);

        let own_meta: serde_json::Value = beta.get("meta").await.unwrap();
        assert_eq!(own_meta["id"], "sess-beta");

        // Isolated IO streams across the two sessions.
        alpha
            .input(TerminalInput {
                data_b64: STANDARD.encode("printf 'ALPHA_ONLY_91\\n'\n"),
            })
            .await
            .unwrap();
        beta.input(TerminalInput {
            data_b64: STANDARD.encode("printf 'BETA_ONLY_92\\n'\n"),
        })
        .await
        .unwrap();

        let alpha_out = read_until_contains(&alpha, "output", "ALPHA_ONLY_91").await;
        let beta_out = read_until_contains(&beta, "events", "BETA_ONLY_92").await;
        assert!(!alpha_out.contains("BETA_ONLY_92"));
        assert!(!beta_out.contains("ALPHA_ONLY_91"));

        // Releasing sess-alpha leaves sess-beta and terminal-mux-host alive past the idle window.
        close_and_release(&alpha).await;
        assert!(!owner_alive(&alpha_dir).unwrap());
        assert!(!alpha_dir.exists());

        tokio::time::sleep(Duration::from_millis(260)).await;
        assert_eq!(unsafe { libc::kill(mux_pid, 0) }, 0);
        assert!(mux_dir.join("mux.json").exists());
        assert!(owner_alive(&beta_dir).unwrap());

        beta.input(TerminalInput {
            data_b64: STANDARD.encode("printf 'BETA_STILL_ALIVE\\n'\n"),
        })
        .await
        .unwrap();
        read_until_contains(&beta, "output", "BETA_STILL_ALIVE").await;

        // Releasing the last session causes terminal-mux-host to exit cleanly and remove mux.json.
        close_and_release(&beta).await;
        assert!(!owner_alive(&beta_dir).unwrap());
        assert!(!beta_dir.exists());

        tokio::time::timeout(Duration::from_secs(4), async {
            while unsafe { libc::kill(mux_pid, 0) } == 0 {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("terminal-mux-host must exit cleanly after last session is released");
        assert!(!mux_dir.join("mux.json").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn concurrent_host_spawns_share_single_mux_daemon() {
        let (exe, hash) = test_daemon_binary();
        let data_dir = tempfile::tempdir().unwrap();
        let hosts_dir = data_dir.path().join("terminal-hosts");
        let size = TerminalSize { cols: 80, rows: 24 };

        let spawn_one = |name: &'static str| {
            let exe = exe.clone();
            let hash = hash.clone();
            let dir = hosts_dir.join(name);
            let cwd = data_dir.path().to_path_buf();
            async move {
                let mut cmd = portable_pty::CommandBuilder::new("/bin/sh");
                cmd.cwd(cwd);
                let host = Host::start_at(exe, dir.clone(), cmd, size, hash, 0)
                    .await
                    .unwrap();
                let info: serde_json::Value =
                    serde_json::from_slice(&std::fs::read(dir.join("host.json")).unwrap()).unwrap();
                (host, info["pid"].as_i64().unwrap() as i32)
            }
        };

        let ((h1, p1), (h2, p2), (h3, p3)) =
            tokio::join!(spawn_one("c1"), spawn_one("c2"), spawn_one("c3"));
        assert_eq!(p1, p2);
        assert_eq!(p2, p3);

        for host in [&h1, &h2, &h3] {
            close_and_release(host).await;
        }
        tokio::time::timeout(Duration::from_secs(4), async {
            while unsafe { libc::kill(p1, 0) } == 0 {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("mux should exit after concurrent sessions are released");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn legacy_standalone_terminal_host_attach_remains_compatible() {
        use base64::{Engine, engine::general_purpose::STANDARD};

        // Also verify Host::attach rejects a mismatched /s/<other>/ path.
        let mismatch_root = tempfile::tempdir().unwrap();
        let expected_dir = mismatch_root.path().join("expected-id");
        std::fs::create_dir_all(&expected_dir).unwrap();
        std::fs::write(
            expected_dir.join("host.json"),
            serde_json::json!({
                "base_url": "http://127.0.0.1:9999/s/other-id/",
                "token": "a".repeat(64),
            })
            .to_string(),
        )
        .unwrap();
        assert!(matches!(
            Host::attach(expected_dir).await,
            Err(Error::Unauthorized)
        ));

        // Spawn a real legacy standalone `terminal-host` process (url.path() == "/")
        // and verify Host::attach + IO + release remain 100% compatible.
        let (exe, _) = test_daemon_binary();
        let data_dir = tempfile::tempdir().unwrap();
        let legacy_dir = data_dir.path().join("terminal-hosts").join("legacy-1");
        std::fs::create_dir_all(&legacy_dir).unwrap();
        let launch = Launch {
            argv: vec!["/bin/sh".into()],
            cwd: Some(data_dir.path().as_os_str().to_owned()),
            environment: std::env::vars_os().collect(),
            size: TerminalSize { cols: 80, rows: 24 },
            base_seq: 0,
        };
        let launch_bytes = serde_json::to_vec(&launch).unwrap();
        let mut child = std::process::Command::new(&exe)
            .args(["terminal-host", "--directory"])
            .arg(&legacy_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(&launch_bytes)
            .unwrap();

        let host = tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                if let Ok(attached) = Host::attach(legacy_dir.clone()).await {
                    return attached;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("should attach to legacy standalone terminal-host");

        let info: serde_json::Value =
            serde_json::from_slice(&std::fs::read(legacy_dir.join("host.json")).unwrap()).unwrap();
        let parsed = url::Url::parse(info["base_url"].as_str().unwrap()).unwrap();
        assert_eq!(parsed.path(), "/");
        assert!(host.supports_stream());

        host.input(TerminalInput {
            data_b64: STANDARD.encode("printf 'LEGACY_OK_77\\n'\n"),
        })
        .await
        .unwrap();
        read_until_contains(&host, "output", "LEGACY_OK_77").await;

        close_and_release(&host).await;
        let status = tokio::task::spawn_blocking(move || child.wait())
            .await
            .unwrap()
            .unwrap();
        assert!(status.success());
    }
}
