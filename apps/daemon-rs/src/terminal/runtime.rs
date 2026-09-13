use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use tokio::sync::Semaphore;

use super::*;
use crate::protocol::{SessionHead, SessionStatus, UpdateSession};
use crate::worker::Database;

const NATIVE_CODEX_ID: &str = "native-codex";

struct State {
    guard: Option<PathBuf>,
    database: Database,
    entries: Mutex<HashMap<String, Terminal>>,
    slots: Arc<Semaphore>,
    closed: AtomicBool,
    failed: AtomicBool,
    changed: watch::Sender<u64>,
    checkpoints: Arc<Semaphore>,
}

#[derive(Clone)]
pub struct Terminals(Arc<State>);

/// Explicit program for a non-shell PTY (managed-account login flow).
#[derive(Debug, Clone)]
pub(crate) struct ProgramSpec {
    pub program: String,
    pub args: Vec<String>,
    pub environment: Vec<(String, String)>,
    pub account_id: Option<String>,
}

impl Terminals {
    pub fn new(database: Database) -> Self {
        Self::with_guard(database, None)
    }

    pub(crate) fn with_guard(database: Database, guard: Option<PathBuf>) -> Self {
        Self(Arc::new(State {
            guard,
            database,
            entries: Mutex::new(HashMap::new()),
            slots: Arc::new(Semaphore::new(16)),
            closed: AtomicBool::new(false),
            failed: AtomicBool::new(false),
            changed: watch::channel(0).0,
            checkpoints: Arc::new(Semaphore::new(2)),
        }))
    }

    pub fn count(&self) -> usize {
        16 - self.0.slots.available_permits()
    }

    /// Spawns the managed-Claude login flow (`claude setup-token`) in a PTY
    /// rooted at the account's isolated config directory. The returned head is
    /// a normal pty session; its run is bound to the account for accounting.
    #[cfg(unix)]
    pub async fn create_login(
        &self,
        account_id: &str,
        title: String,
        size: TerminalSize,
        environment: Vec<(String, String)>,
    ) -> Result<SessionHead> {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .ok_or_else(|| Error::Invalid("无法定位用户目录".into()))?;
        let program = std::env::var("PROSPERO_CLAUDE_BIN").unwrap_or_else(|_| "claude".into());
        let input = CreateTerminal {
            title,
            workspace: home.to_string_lossy().into_owned(),
            size,
            agent: Some(crate::protocol::AgentKind::Claude),
            command: None,
            account_id: None,
            model: None,
            effort: None,
        };
        let spec = ProgramSpec {
            program,
            args: vec!["setup-token".into()],
            environment,
            account_id: Some(account_id.to_owned()),
        };
        self.create_with(input, Some(spec)).await
    }

    pub(crate) fn changes(&self) -> watch::Sender<u64> {
        self.0.changed.clone()
    }

    pub fn check(&self) -> Result<()> {
        if self.0.failed.load(Ordering::Acquire) {
            Err(Error::Closed)
        } else {
            Ok(())
        }
    }

    pub async fn create(&self, input: CreateTerminal) -> Result<SessionHead> {
        let spec = self.pty_program_for(&input).await?;
        self.create_with(input, spec).await
    }

    /// A non-shell PTY (the managed-account login flow): runs an explicit
    /// program with private environment overrides and is bound to the account
    /// for active-session accounting.
    pub(crate) async fn create_with(
        &self,
        input: CreateTerminal,
        spec: Option<ProgramSpec>,
    ) -> Result<SessionHead> {
        input.size.validate()?;
        crate::database::validate_text(&input.title, 512, false)?;
        crate::database::validate_text(&input.workspace, 4096, false)?;
        if !Path::new(&input.workspace).is_absolute() {
            return Err(Error::Invalid("workspace must be absolute".into()));
        }
        if self.0.closed.load(Ordering::Acquire) {
            return Err(Error::Closed);
        }
        let permit = self
            .0
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Busy)?;
        let runtime = self.clone();
        let (reply, result) = oneshot::channel();
        tokio::spawn(async move {
            let created = if reply.is_closed() {
                Err(Error::Closed)
            } else {
                runtime.start(input, spec).await
            };
            match created {
                Ok((head, terminal)) => {
                    if reply.send(Ok(head.clone())).is_err()
                        || runtime.0.closed.load(Ordering::Acquire)
                    {
                        terminal.stop();
                    }
                    if runtime.persist_live(&head.id, &terminal).await.is_err() {
                        runtime.0.failed.store(true, Ordering::Release);
                        runtime.0.closed.store(true, Ordering::Release);
                        terminal.stop();
                        terminal.wait_exited().await;
                        eprintln!("terminal checkpoint failed");
                    }
                    let finalized = match terminal.archive() {
                        Ok(archive) => runtime.finish(&head.id, archive).await,
                        Err(error) => Err(error),
                    };
                    if finalized.is_err() {
                        runtime.0.failed.store(true, Ordering::Release);
                        runtime.0.closed.store(true, Ordering::Release);
                        eprintln!("terminal finalization failed");
                    }
                    if !runtime.0.failed.load(Ordering::Acquire)
                        && let Ok(mut entries) = runtime.0.entries.lock()
                    {
                        entries.remove(&head.id);
                    }
                }
                Err(error) => {
                    let _ = reply.send(Err(error));
                }
            }
            drop(permit);
            runtime
                .0
                .changed
                .send_modify(|seq| *seq = seq.wrapping_add(1));
        });
        result.await.map_err(|_| Error::Closed)?
    }

    async fn finish(&self, id: &str, archive: Archive) -> Result<()> {
        for attempt in 0..20 {
            let id = id.to_owned();
            let archive = archive.clone();
            match self
                .0
                .database
                .call(move |store| store.finish_terminal(&id, archive))
                .await
            {
                Ok(_) => return Ok(()),
                Err(Error::Busy) if attempt < 19 => {
                    tokio::time::sleep(Duration::from_millis(25)).await
                }
                Err(error) => return Err(error),
            }
        }
        Err(Error::Busy)
    }

    async fn persist_live(&self, id: &str, terminal: &Terminal) -> Result<()> {
        let mut seq = 0;
        let mut waiting = false;
        loop {
            if waiting {
                tokio::select! {
                    _ = terminal.wait_exited() => return Ok(()),
                    _ = terminal.wait_output(seq) => {
                        waiting = false;
                        continue;
                    }
                    _ = tokio::time::sleep(Duration::from_millis(250)) => {}
                }
            } else {
                tokio::select! {
                    _ = terminal.wait_exited() => return Ok(()),
                    _ = terminal.wait_output(seq) => waiting = true,
                }
            }
            let permit = tokio::select! {
                _ = terminal.wait_exited() => return Ok(()),
                permit = self.0.checkpoints.clone().acquire_owned() => permit.map_err(|_| Error::Closed)?,
            };
            let copy = terminal.clone();
            let archive = tokio::task::spawn_blocking(move || {
                let _permit = permit;
                copy.checkpoint(Some(seq))
            })
            .await
            .map_err(|_| Error::Closed)??;
            let Some(archive) = archive else {
                continue;
            };
            let next = archive.seq;
            let id = id.to_owned();
            match self
                .0
                .database
                .call(move |store| store.checkpoint_terminal(&id, archive))
                .await
            {
                Ok(()) => seq = next,
                Err(Error::Busy) => {}
                Err(error) => return Err(error),
            }
        }
    }

    #[cfg(unix)]
    async fn start(
        &self,
        mut input: CreateTerminal,
        spec: Option<ProgramSpec>,
    ) -> Result<(SessionHead, Terminal)> {
        let workspace = input.workspace.clone();
        let directory = tokio::task::spawn_blocking(move || std::fs::canonicalize(workspace))
            .await
            .map_err(|_| Error::Closed)??;
        if !directory.is_dir() {
            return Err(Error::Invalid("workspace is not a directory".into()));
        }
        input.workspace = directory
            .to_str()
            .ok_or_else(|| Error::Invalid("workspace must be Unicode".into()))?
            .into();
        if self.0.closed.load(Ordering::Acquire) {
            return Err(Error::Closed);
        }
        let size = input.size;
        let guard = self.0.guard.clone();
        let account_id = spec.as_ref().and_then(|spec| spec.account_id.clone());
        let head = self
            .0
            .database
            .call(move |store| store.create_terminal_with(input, account_id))
            .await?;
        let child = tokio::task::spawn_blocking(move || {
            let mut command = match &spec {
                Some(spec) => {
                    // Explicit program (managed-account login): no shell, no
                    // guard, private env overrides only.
                    let mut command = portable_pty::CommandBuilder::new(&spec.program);
                    command.args(&spec.args);
                    for (key, value) in &spec.environment {
                        command.env(key, value);
                    }
                    command
                }
                None => {
                    let shell = login_shell(std::env::var_os("SHELL"));
                    if let Some(guard) = guard {
                        let mut command = portable_pty::CommandBuilder::new(guard);
                        command.args([
                            "terminal-guard",
                            "--parent",
                            &std::process::id().to_string(),
                            "--shell",
                        ]);
                        command.arg(shell);
                        command.args(["--", "-l"]);
                        command
                    } else {
                        let mut command = portable_pty::CommandBuilder::new(shell);
                        command.arg("-l");
                        command
                    }
                }
            };
            command.cwd(directory);
            command.env("TERM", "xterm-256color");
            command.env("COLORTERM", "truecolor");
            for key in ["TMUX", "TMUX_PANE", "STY"] {
                command.env_remove(key);
            }
            spawn(command, size)
        })
        .await
        .map_err(|_| Error::Closed)
        .and_then(|result| result);
        let terminal = match child {
            Ok(terminal) => terminal,
            Err(error) => {
                let id = head.id;
                self.0
                    .database
                    .call(move |store| {
                        store.finish_terminal(
                            &id,
                            Archive {
                                snapshot: None,
                                floor: 0,
                                start: 0,
                                seq: 0,
                                events: Vec::new(),
                                exit_code: None,
                            },
                        )
                    })
                    .await?;
                return Err(error);
            }
        };
        let id = head.id.clone();
        let running = self
            .0
            .database
            .call(move |store| {
                let head = store.session(&id)?;
                store.update_session(
                    &id,
                    UpdateSession {
                        revision: head.revision,
                        title: None,
                        lifecycle: None,
                        status: Some(SessionStatus::Running),
                    },
                )
            })
            .await;
        if let Err(error) = running {
            terminal.stop();
            terminal.wait_exited().await;
            let archive = terminal.archive()?;
            let id = head.id;
            self.0
                .database
                .call(move |store| store.finish_terminal(&id, archive))
                .await?;
            return Err(error);
        }
        self.0
            .entries
            .lock()
            .map_err(|_| Error::Closed)?
            .insert(head.id.clone(), terminal.clone());
        Ok((running?, terminal))
    }

    #[cfg(not(unix))]
    async fn start(
        &self,
        _input: CreateTerminal,
        _spec: Option<ProgramSpec>,
    ) -> Result<(SessionHead, Terminal)> {
        Err(Error::Invalid(
            "terminal runtime is not available on this platform".into(),
        ))
    }

    fn terminal(&self, id: &str) -> Result<Terminal> {
        crate::database::validate_id(id)?;
        self.0
            .entries
            .lock()
            .map_err(|_| Error::Closed)?
            .get(id)
            .cloned()
            .ok_or(Error::NotFound)
    }

    pub async fn read(&self, id: String, query: TerminalQuery) -> Result<TerminalPage> {
        match self.terminal(&id) {
            Ok(terminal) => terminal.read(query).await,
            Err(Error::NotFound) => {
                self.0
                    .database
                    .call(move |store| store.terminal_output(&id, query))
                    .await
            }
            Err(error) => Err(error),
        }
    }

    pub async fn snapshot(&self, id: String) -> Result<Option<TerminalSnapshot>> {
        match self.terminal(&id) {
            Ok(terminal) => tokio::task::spawn_blocking(move || terminal.snapshot())
                .await
                .map_err(|_| Error::Closed)?,
            Err(Error::NotFound) => {
                self.0
                    .database
                    .call(move |store| store.terminal_snapshot(&id))
                    .await
            }
            Err(error) => Err(error),
        }
    }

    pub async fn input(&self, id: &str, input: TerminalInput) -> Result<()> {
        self.terminal(id)?.input(input).await
    }
    pub async fn resize(&self, id: &str, size: TerminalSize) -> Result<()> {
        self.terminal(id)?.resize(size).await
    }
    pub fn close(&self, id: &str) -> Result<()> {
        self.terminal(id)?.stop();
        Ok(())
    }

    pub async fn shutdown(&self) -> Result<()> {
        self.0.closed.store(true, Ordering::Release);
        for terminal in self.0.entries.lock().map_err(|_| Error::Closed)?.values() {
            terminal.stop();
        }
        let mut changed = self.0.changed.subscribe();
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                changed.borrow_and_update();
                if self.count() == 0 {
                    return;
                }
                if changed.changed().await.is_err() {
                    return;
                }
            }
        })
        .await
        .map_err(|_| Error::Timeout)?;
        self.check()
    }
}

#[cfg(unix)]
fn shell_command(command: &str) -> Result<ProgramSpec> {
    if command.len() > 2000 || command.contains('\0') || command.trim().is_empty() {
        return Err(Error::Invalid("invalid terminal command".into()));
    }
    let shell = login_shell(std::env::var_os("SHELL"))
        .into_string()
        .map_err(|_| Error::Invalid("shell path must be Unicode".into()))?;
    Ok(ProgramSpec {
        program: shell,
        args: vec!["-c".into(), command.to_owned()],
        environment: Vec::new(),
        account_id: None,
    })
}

fn normalize_selection(
    value: Option<&String>,
    maximum: usize,
    message: &'static str,
) -> Result<Option<String>> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.chars().count() > maximum || value.chars().any(|c| c.is_control()) {
        return Err(Error::Invalid(message.into()));
    }
    let value = value.trim();
    if value.is_empty() {
        return Err(Error::Invalid(message.into()));
    }
    Ok(Some(value.to_owned()))
}

fn push_env(env: &mut Vec<(String, String)>, key: &str, value: impl Into<String>) {
    env.retain(|(existing, _)| existing != key);
    env.push((key.into(), value.into()));
}

#[cfg(unix)]
fn private_dir(path: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(path)?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn private_dir(path: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(path)
}

fn native_codex_environment(data: &Path) -> Result<Vec<(String, String)>> {
    let root = data
        .join("agent-accounts")
        .join("codex")
        .join(NATIVE_CODEX_ID);
    private_dir(&root)?;
    Ok(vec![
        ("OPENAI_API_KEY".into(), String::new()),
        ("CODEX_API_KEY".into(), String::new()),
        ("CODEX_ACCESS_TOKEN".into(), String::new()),
        ("CODEX_REFRESH_TOKEN".into(), String::new()),
        ("CODEX_HOME".into(), root.to_string_lossy().into_owned()),
        (
            "CODEX_SQLITE_HOME".into(),
            root.to_string_lossy().into_owned(),
        ),
    ])
}

fn claude_binary() -> String {
    std::env::var("PROSPERO_CLAUDE_BIN").unwrap_or_else(|_| "claude".into())
}

fn codex_binary() -> String {
    std::env::var("PROSPERO_CODEX_BIN").unwrap_or_else(|_| "codex".into())
}

impl Terminals {
    async fn pty_program_for(&self, input: &CreateTerminal) -> Result<Option<ProgramSpec>> {
        let Some(agent) = input.agent else {
            if input.account_id.is_some() || input.model.is_some() || input.effort.is_some() {
                return Err(Error::Invalid(
                    "terminal launch selection is invalid".into(),
                ));
            }
            return Ok(None);
        };
        let model = normalize_selection(input.model.as_ref(), 160, "模型无效")?;
        let effort = normalize_selection(input.effort.as_ref(), 80, "思考强度无效")?;
        if effort.is_some() && model.is_none() {
            return Err(Error::Invalid("推理强度必须和启动模型一起指定".into()));
        }
        match (agent, input.command.as_deref()) {
            (crate::protocol::AgentKind::Shell, None) => {
                if input.account_id.is_some() || model.is_some() || effort.is_some() {
                    return Err(Error::Invalid(
                        "terminal launch selection is invalid".into(),
                    ));
                }
                Ok(None)
            }
            (
                crate::protocol::AgentKind::Shell | crate::protocol::AgentKind::Custom,
                Some(command),
            ) => {
                if input.account_id.is_some() || model.is_some() || effort.is_some() {
                    return Err(Error::Invalid(
                        "custom terminal launch selection is invalid".into(),
                    ));
                }
                Ok(Some(shell_command(command)?))
            }
            (crate::protocol::AgentKind::Custom, None) => {
                Err(Error::Invalid("custom agent requires a command".into()))
            }
            (_, Some(command)) => {
                if input.account_id.is_some() || model.is_some() || effort.is_some() {
                    return Err(Error::Invalid(
                        "custom terminal launch selection is invalid".into(),
                    ));
                }
                Ok(Some(shell_command(command)?))
            }
            (crate::protocol::AgentKind::Claude, None) => {
                let (mut environment, account_id, default_model, default_effort) = self
                    .resolve_claude_terminal_account(input.account_id.clone())
                    .await?;
                let effective_model = model.or(default_model);
                let effective_effort = if input.effort.is_some() {
                    effort
                } else {
                    default_effort
                };
                if let Some(model) = effective_model {
                    push_env(&mut environment, "ANTHROPIC_MODEL", model);
                }
                if let Some(effort) = effective_effort {
                    push_env(&mut environment, "CLAUDE_CODE_EFFORT_LEVEL", effort);
                }
                Ok(Some(ProgramSpec {
                    program: claude_binary(),
                    args: vec!["--dangerously-skip-permissions".into()],
                    environment,
                    account_id,
                }))
            }
            (crate::protocol::AgentKind::Codex, None) => {
                let (environment, account_id) = self
                    .resolve_codex_terminal_account(input.account_id.clone())
                    .await?;
                let mut args = vec!["--dangerously-bypass-approvals-and-sandbox".into()];
                if let Some(model) = model {
                    args.extend([
                        "-c".into(),
                        format!("model={}", serde_json::to_string(&model)?),
                    ]);
                }
                if let Some(effort) = effort {
                    args.extend([
                        "-c".into(),
                        format!("model_reasoning_effort={}", serde_json::to_string(&effort)?),
                    ]);
                }
                Ok(Some(ProgramSpec {
                    program: codex_binary(),
                    args,
                    environment,
                    account_id,
                }))
            }
            (crate::protocol::AgentKind::Opencode, None) => {
                if input.account_id.is_some() || model.is_some() || effort.is_some() {
                    return Err(Error::Invalid(
                        "terminal launch selection is invalid".into(),
                    ));
                }
                Ok(Some(ProgramSpec {
                    program: "opencode".into(),
                    args: Vec::new(),
                    environment: Vec::new(),
                    account_id: None,
                }))
            }
            (crate::protocol::AgentKind::Grok, None) => {
                if input.account_id.is_some() || model.is_some() || effort.is_some() {
                    return Err(Error::Invalid(
                        "terminal launch selection is invalid".into(),
                    ));
                }
                Ok(Some(ProgramSpec {
                    program: "grok".into(),
                    args: Vec::new(),
                    environment: Vec::new(),
                    account_id: None,
                }))
            }
            (crate::protocol::AgentKind::Trae, None) => {
                if input.account_id.is_some() || model.is_some() || effort.is_some() {
                    return Err(Error::Invalid(
                        "terminal launch selection is invalid".into(),
                    ));
                }
                Ok(Some(ProgramSpec {
                    program: "trae-cli".into(),
                    args: vec!["interactive".into()],
                    environment: Vec::new(),
                    account_id: None,
                }))
            }
            (crate::protocol::AgentKind::Deepseek, None) => Err(Error::Invalid(
                "DeepSeek Harness only supports structured sessions".into(),
            )),
        }
    }

    async fn resolve_claude_terminal_account(
        &self,
        account_id: Option<String>,
    ) -> Result<(
        Vec<(String, String)>,
        Option<String>,
        Option<String>,
        Option<String>,
    )> {
        let Some(id) = account_id else {
            return Ok((Vec::new(), None, None, None));
        };
        if id == crate::accounts::NATIVE_CLAUDE_ID {
            return Ok((Vec::new(), None, None, None));
        }
        crate::database::validate_id(&id)?;
        let data = self.0.database.directory().to_owned();
        let record = self
            .0
            .database
            .call({
                let database = self.0.database.clone();
                let data = data.clone();
                let id = id.clone();
                move |store| {
                    if let Some(message) =
                        crate::accounts::source_bound_launch_error(&database, &id)?
                    {
                        return Err(Error::Invalid(message));
                    }
                    let record = store.managed_snapshot_row(&data, &id)?;
                    let target = crate::accounts::config::ConfigTarget {
                        account_id: record.id.clone(),
                        model: record
                            .api_profile
                            .as_ref()
                            .map(|profile| profile.model.clone()),
                        model_capabilities: record
                            .api_profile
                            .as_ref()
                            .and_then(|profile| profile.model_capabilities.clone()),
                        active_sessions: 0,
                    };
                    let defaults = crate::accounts::config::read_defaults(&data, &target)?;
                    Ok((record, defaults))
                }
            })
            .await?;
        let (record, (default_model, default_effort)) = record;
        let account_id = record.id.clone();
        let env_id = account_id.clone();
        let env = tokio::task::spawn_blocking(move || match record.api_profile {
            Some(profile) => {
                crate::accounts::managed::profile_account_environment(&data, &env_id, &profile)
            }
            None => crate::accounts::managed::claude_environment(&data, &env_id, false),
        })
        .await
        .map_err(|_| Error::Closed)??;
        Ok((env, Some(account_id), default_model, default_effort))
    }

    async fn resolve_codex_terminal_account(
        &self,
        account_id: Option<String>,
    ) -> Result<(Vec<(String, String)>, Option<String>)> {
        match account_id.as_deref() {
            None => Ok((Vec::new(), None)),
            Some(NATIVE_CODEX_ID) => {
                let data = self.0.database.directory().to_owned();
                let env = tokio::task::spawn_blocking(move || native_codex_environment(&data))
                    .await
                    .map_err(|_| Error::Closed)??;
                Ok((env, Some(NATIVE_CODEX_ID.into())))
            }
            Some(_) => Err(Error::Invalid(
                "Rust Codex PTY 当前仅支持本机默认账号".into(),
            )),
        }
    }
}

fn login_shell(shell: Option<OsString>) -> OsString {
    let Some(shell) = shell else {
        return "/bin/sh".into();
    };
    let path = Path::new(&shell);
    if !path.is_absolute() {
        return "/bin/sh".into();
    }
    let allowed = path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            matches!(
                name,
                "sh" | "bash" | "zsh" | "dash" | "ksh" | "fish" | "csh" | "tcsh"
            )
        });
    if allowed { shell } else { "/bin/sh".into() }
}

#[cfg(test)]
mod tests {
    use super::login_shell;
    use std::ffi::OsString;

    #[test]
    fn login_shell_rejects_non_shell() {
        assert_eq!(
            login_shell(Some(OsString::from("/bin/cat"))),
            OsString::from("/bin/sh")
        );
    }

    #[test]
    fn login_shell_rejects_relative_path() {
        assert_eq!(
            login_shell(Some(OsString::from("zsh"))),
            OsString::from("/bin/sh")
        );
    }

    #[test]
    fn login_shell_accepts_known_shell() {
        assert_eq!(
            login_shell(Some(OsString::from("/bin/zsh"))),
            OsString::from("/bin/zsh")
        );
    }
}
