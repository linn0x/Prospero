//! A per-session PTY owner that outlives the control daemon.
//! The parent sends the launch environment once over stdin; only a private
//! loopback capability is published to disk. Reattachment never spawns a shell.
use super::*;
use crate::auth::Token;
use crate::server::ApiError;
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Query, State},
    middleware::{self, Next},
    response::Response,
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    path::PathBuf,
    process::Stdio,
};

#[derive(Serialize, Deserialize)]
struct Launch {
    argv: Vec<std::ffi::OsString>,
    cwd: Option<std::ffi::OsString>,
    environment: Vec<(std::ffi::OsString, std::ffi::OsString)>,
    size: TerminalSize,
}
#[derive(Clone, Deserialize)]
struct Connection {
    base_url: String,
    token: String,
}
#[derive(Clone)]
pub(crate) struct Host {
    pub directory: PathBuf,
    url: String,
    token: String,
    client: reqwest::Client,
}
impl Host {
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
        if url.scheme() != "http"
            || url.host_str() != Some("127.0.0.1")
            || url.port().is_none()
            || url.path() != "/"
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
            .timeout(Duration::from_secs(8))
            .build()
            .map_err(|_| Error::Closed)?;
        let host = Self {
            directory,
            url: connection.base_url.trim_end_matches('/').to_owned(),
            token: connection.token,
            client,
        };
        let identity: serde_json::Value = host.get("identity").await?;
        if identity["version"] != 1
            || identity["id"].as_str() != host.directory.file_name().and_then(|v| v.to_str())
        {
            return Err(Error::Unauthorized);
        }
        Ok(host)
    }
    pub async fn start(
        exe: PathBuf,
        directory: PathBuf,
        command: portable_pty::CommandBuilder,
        size: TerminalSize,
        expected_hash: String,
    ) -> Result<Self> {
        std::fs::create_dir_all(&directory)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))?;
        }
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
        let launch = Launch {
            argv: command.get_argv().clone(),
            cwd: command.get_cwd().cloned(),
            environment: environment.into_iter().collect(),
            size,
        };
        let bytes = serde_json::to_vec(&launch)?;
        if bytes.len() > 1024 * 1024 {
            return Err(Error::Invalid("terminal environment exceeds limit".into()));
        }
        let dir = directory.clone();
        let mut child = tokio::task::spawn_blocking(move || -> Result<std::process::Child> {
            let cache = dir
                .parent()
                .and_then(std::path::Path::parent)
                .ok_or(Error::Closed)?
                .join("terminal-host-runtime");
            let executable = pin_executable(&exe, &cache, &expected_hash)?;
            let mut command = std::process::Command::new(executable);
            command
                .args(["terminal-host", "--directory"])
                .arg(&dir)
                .stdin(Stdio::piped())
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
            let mut child = command.spawn()?;
            let written = child.stdin.take().ok_or(Error::Closed)?.write_all(&bytes);
            if let Err(error) = written {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error.into());
            }
            Ok(child)
        })
        .await
        .map_err(|_| Error::Closed)??;
        for _ in 0..100 {
            if let Ok(host) = Self::attach(directory.clone()).await {
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
                return Ok(host);
            }
            if child.try_wait()?.is_some() {
                return Err(Error::Closed);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let _ = child.kill();
        let _ = tokio::task::spawn_blocking(move || child.wait()).await;
        Err(Error::Timeout)
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
        self.response(self.client.get(format!("{}/{path}", self.url)))
            .await
    }
    pub async fn post<T: Serialize>(&self, path: &str, body: &T) -> Result<()> {
        let result: Result<bool> = self
            .response(self.client.post(format!("{}/{path}", self.url)).json(body))
            .await;
        match result {
            Ok(_) => Ok(()),
            Err(Error::Closed | Error::Timeout | Error::Json(_)) if path == "input" => {
                // An acknowledgement may have been lost after bytes reached
                // the PTY. Do not invite replay of an ambiguous input batch.
                let _: Result<bool> = self
                    .response(self.client.post(format!("{}/close", self.url)).json(&true))
                    .await;
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
    let terminal = spawn(command, launch.size)?;
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
                        Json(serde_json::json!({"id":o.id,"version":1}))
                    }),
                )
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
                            o.terminal
                                .input(i)
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
            owner.terminal.stop();
            owner.terminal.wait_exited().await;
            let _ = std::fs::remove_file(directory.join("host.json"));
            result.map_err(Error::from)
        });
    drop(lock);
    if result.is_ok() {
        let _ = std::fs::remove_dir_all(cleanup_directory);
    }
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
}
