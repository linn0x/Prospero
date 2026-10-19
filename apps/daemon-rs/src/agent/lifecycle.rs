use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, watch};
use tokio::time::Duration;

use crate::error::{Error, Result};
pub(crate) use crate::protocol::{
    ControlEffectState, DriverError, DriverErrorCategory, DriverPhase,
};

pub(crate) fn driver_error_from_error(error: &Error, phase: DriverPhase) -> DriverError {
    if let Error::Invalid(message) = error {
        return driver_error_from_message(message.clone(), phase);
    }
    let (category, code, retryable, control_effect_state) = match error {
        Error::Timeout => (
            DriverErrorCategory::Transport,
            "driver_timeout",
            true,
            ControlEffectState::Unknown,
        ),
        Error::Io(_) | Error::Closed => (
            if phase == DriverPhase::Create {
                DriverErrorCategory::ExecutorExit
            } else {
                DriverErrorCategory::Transport
            },
            "driver_transport",
            true,
            if phase == DriverPhase::Create {
                ControlEffectState::Failed
            } else {
                ControlEffectState::Unknown
            },
        ),
        Error::Storage(_) | Error::DatabaseOperationFailed(_) => (
            DriverErrorCategory::Storage,
            "driver_storage",
            true,
            ControlEffectState::Unknown,
        ),
        Error::Feature(code, _) if code == "driver_exit_unknown" => (
            DriverErrorCategory::Ownership,
            "driver_exit_unknown",
            false,
            ControlEffectState::Unknown,
        ),
        Error::Feature(_, _) => (
            DriverErrorCategory::Configuration,
            "driver_unavailable",
            false,
            ControlEffectState::Failed,
        ),
        Error::Unauthorized => (
            DriverErrorCategory::Authentication,
            "driver_authentication",
            false,
            ControlEffectState::Failed,
        ),
        Error::Backpressure(_)
        | Error::Busy
        | Error::ApiTestBusy
        | Error::ApiTestInFlight
        | Error::InUse => (
            DriverErrorCategory::Capacity,
            "driver_capacity",
            true,
            ControlEffectState::None,
        ),
        Error::Conflict | Error::Invalid(_) | Error::NotFound | Error::Schema => (
            DriverErrorCategory::Validation,
            "driver_validation",
            false,
            ControlEffectState::Failed,
        ),
        Error::TerminalInput => (
            DriverErrorCategory::Cancelled,
            "driver_cancelled",
            false,
            ControlEffectState::Received,
        ),
        Error::DatabaseUnavailable(_) | Error::AlreadyRunning | Error::Forbidden => (
            DriverErrorCategory::Ownership,
            "driver_ownership",
            false,
            ControlEffectState::Unknown,
        ),
        Error::Json(_) => (
            DriverErrorCategory::Validation,
            "driver_invalid_response",
            false,
            ControlEffectState::Unknown,
        ),
    };
    DriverError {
        category,
        code: code.into(),
        phase,
        retryable,
        retry_after_ms: match error {
            Error::Backpressure(pressure) => Some(pressure.retry_after_ms),
            _ => None,
        },
        control_effect_state,
        attempt_id: None,
        operation_id: None,
        diagnostic_ref: None,
        message: match std::error::Error::source(error) {
            Some(source) => format!("{error}: {source}"),
            None => error.to_string(),
        },
    }
}

pub(crate) fn driver_error_from_message(message: String, phase: DriverPhase) -> DriverError {
    let lower = message.to_ascii_lowercase();
    let (category, code, retryable, control_effect_state) = if lower.contains("429")
        || lower.contains("rate limit")
        || lower.contains("too many requests")
    {
        (
            DriverErrorCategory::RateLimit,
            "driver_rate_limited",
            true,
            ControlEffectState::Unknown,
        )
    } else if lower.contains("unauthorized")
        || lower.contains("authentication")
        || lower.contains("invalid api key")
    {
        (
            DriverErrorCategory::Authentication,
            "driver_authentication",
            false,
            ControlEffectState::Failed,
        )
    } else if lower.contains("not installed")
        || lower.contains("unsupported")
        || lower.contains("configuration")
    {
        (
            DriverErrorCategory::Configuration,
            "driver_configuration",
            false,
            ControlEffectState::Failed,
        )
    } else if lower.contains("disk") || lower.contains("database") || lower.contains("storage") {
        (
            DriverErrorCategory::Storage,
            "driver_storage",
            true,
            ControlEffectState::Unknown,
        )
    } else if lower.contains("timeout")
        || lower.contains("timed out")
        || lower.contains("connection")
        || lower.contains("disconnected")
        || lower.contains("closed")
        || lower.contains("broken pipe")
        || lower.contains("超时")
        || lower.contains("关闭")
    {
        (
            DriverErrorCategory::Transport,
            "driver_transport",
            true,
            ControlEffectState::Unknown,
        )
    } else if lower.contains("exited") || lower.contains("process") || lower.contains("退出") {
        (
            DriverErrorCategory::ExecutorExit,
            "driver_executor_exit",
            true,
            ControlEffectState::Unknown,
        )
    } else {
        (
            DriverErrorCategory::Validation,
            "driver_backend_error",
            false,
            ControlEffectState::Failed,
        )
    };
    DriverError {
        category,
        code: code.into(),
        phase,
        retryable,
        retry_after_ms: message
            .split_once("retry_after_ms=")
            .and_then(|(_, value)| {
                value
                    .split(|character: char| !character.is_ascii_digit())
                    .next()
            })
            .and_then(|value| value.parse().ok()),
        control_effect_state,
        attempt_id: None,
        operation_id: None,
        diagnostic_ref: None,
        message,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Quiescence {
    Confirmed,
    DirectChildExited,
    Unknown,
}

pub(crate) async fn http_response_error(backend: &str, mut response: reqwest::Response) -> Error {
    let status = response.status();
    let retry_after = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let retry_after_ms = retry_after
        .as_deref()
        .and_then(|value| value.parse::<u64>().ok())
        .and_then(|seconds| seconds.checked_mul(1000));
    let mut diagnostic = Vec::new();
    let body = tokio::time::timeout(Duration::from_secs(2), async {
        while let Ok(Some(chunk)) = response.chunk().await {
            let remaining = 16_384_usize.saturating_sub(diagnostic.len());
            diagnostic.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
            if diagnostic.len() >= 16_384 {
                break;
            }
        }
    })
    .await;
    let retry = retry_after_ms
        .map(|value| format!(" [retry_after_ms={value}]"))
        .unwrap_or_default();
    let original_retry = retry_after
        .map(|value| format!(" [retry-after={value}]"))
        .unwrap_or_default();
    Error::Invalid(format!(
        "{backend} HTTP {status}{retry}{original_retry}: {}{}",
        String::from_utf8_lossy(&diagnostic),
        if body.is_err() {
            " [diagnostic body timed out]"
        } else {
            ""
        }
    ))
}

pub(crate) fn cleanup_error(error: Error, quiescence: Quiescence) -> Error {
    if quiescence == Quiescence::Unknown {
        Error::Feature(
            "driver_exit_unknown".into(),
            format!("{error}; executor exit could not be confirmed"),
        )
    } else {
        error
    }
}

pub(crate) fn exit_unknown(error: &Error) -> bool {
    matches!(error, Error::Feature(code, _) if code == "driver_exit_unknown")
}

impl Quiescence {
    pub(crate) fn permits_direct_release(self) -> bool {
        matches!(self, Self::Confirmed | Self::DirectChildExited)
    }
}

#[derive(Clone)]
pub(crate) struct ProcessLifecycle {
    pid: u32,
    exited: watch::Sender<bool>,
    reaped: Arc<AtomicBool>,
    control: Arc<Mutex<()>>,
    #[cfg(windows)]
    process: Option<Arc<std::os::windows::io::OwnedHandle>>,
}

impl ProcessLifecycle {
    pub(crate) fn new(pid: u32) -> Self {
        Self {
            pid,
            exited: watch::channel(false).0,
            reaped: Arc::new(AtomicBool::new(false)),
            control: Arc::new(Mutex::new(())),
            #[cfg(windows)]
            process: {
                use std::os::windows::io::FromRawHandle;
                use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_TERMINATE};
                let handle = unsafe { OpenProcess(PROCESS_TERMINATE, 0, pid) };
                if handle.is_null() {
                    None
                } else {
                    Some(Arc::new(unsafe {
                        std::os::windows::io::OwnedHandle::from_raw_handle(handle)
                    }))
                }
            },
        }
    }

    pub(crate) fn pid(&self) -> u32 {
        self.pid
    }

    async fn confirm_reaped(&self, _status: std::process::ExitStatus) -> Quiescence {
        self.reaped.store(true, Ordering::Release);
        if self.confirmed_exit() {
            self.exited.send_replace(true);
            self.exit_proof()
        } else {
            Quiescence::Unknown
        }
    }

    fn exit_proof(&self) -> Quiescence {
        if cfg!(unix) {
            Quiescence::Confirmed
        } else {
            Quiescence::DirectChildExited
        }
    }

    fn confirmed_exit(&self) -> bool {
        self.reaped.load(Ordering::Acquire) && (!cfg!(unix) || process_group_is_empty(self.pid))
    }

    fn signal_owned_process(&self) -> std::io::Result<()> {
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            let handle = self.process.as_ref().ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "owned process handle is unavailable",
                )
            })?;
            if unsafe {
                windows_sys::Win32::System::Threading::TerminateProcess(handle.as_raw_handle(), 1)
            } != 0
            {
                Ok(())
            } else {
                Err(std::io::Error::last_os_error())
            }
        }
        #[cfg(not(windows))]
        {
            signal_process_tree(self.pid)
        }
    }

    pub(crate) async fn request_termination(&self) -> ControlEffectState {
        let _guard = self.control.lock().await;
        if *self.exited.subscribe().borrow() {
            return ControlEffectState::None;
        }
        if self.reaped.load(Ordering::Acquire) {
            return ControlEffectState::Unknown;
        }
        match self.signal_owned_process() {
            Ok(()) => ControlEffectState::Received,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                ControlEffectState::Unknown
            }
            Err(_) => ControlEffectState::Failed,
        }
    }

    pub(crate) async fn await_quiescence(&self, timeout: Duration) -> Quiescence {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            if *self.exited.subscribe().borrow() || self.confirmed_exit() {
                self.exited.send_replace(true);
                return self.exit_proof();
            }
            if tokio::time::Instant::now() >= deadline {
                return Quiescence::Unknown;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    async fn wait_child(&self, child: &mut Child) -> Quiescence {
        loop {
            let _guard = self.control.lock().await;
            if *self.exited.subscribe().borrow() {
                return self.exit_proof();
            }
            if self.reaped.load(Ordering::Acquire) {
                drop(_guard);
                return self.await_quiescence(Duration::from_secs(2)).await;
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    let quiescence = self.confirm_reaped(status).await;
                    drop(_guard);
                    return if quiescence == Quiescence::Unknown {
                        self.await_quiescence(Duration::from_secs(2)).await
                    } else {
                        quiescence
                    };
                }
                Ok(None) => {}
                Err(_) => return Quiescence::Unknown,
            }
            drop(_guard);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    async fn terminate_child(&self, child: &mut Child, timeout: Duration) -> Quiescence {
        let deadline = tokio::time::Instant::now() + timeout;
        let mut signal_sent = false;
        loop {
            let _guard = self.control.lock().await;
            if *self.exited.subscribe().borrow() {
                return self.exit_proof();
            }
            if self.reaped.load(Ordering::Acquire) {
                drop(_guard);
                return self
                    .await_quiescence(
                        deadline.saturating_duration_since(tokio::time::Instant::now()),
                    )
                    .await;
            }
            if !signal_sent {
                let _ = self.signal_owned_process();
                let _ = child.start_kill();
                signal_sent = true;
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    let quiescence = self.confirm_reaped(status).await;
                    drop(_guard);
                    return if quiescence == Quiescence::Unknown {
                        self.await_quiescence(
                            deadline.saturating_duration_since(tokio::time::Instant::now()),
                        )
                        .await
                    } else {
                        quiescence
                    };
                }
                Ok(None) if tokio::time::Instant::now() < deadline => {}
                Ok(None) | Err(_) => return Quiescence::Unknown,
            }
            drop(_guard);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}

pub(crate) struct ChildGuard {
    child: Option<Child>,
    lifecycle: ProcessLifecycle,
}

impl ChildGuard {
    pub(crate) fn new(mut child: Child) -> Result<Self> {
        let Some(pid) = child.id() else {
            let _ = child.start_kill();
            return Err(Error::Closed);
        };
        Ok(Self {
            child: Some(child),
            lifecycle: ProcessLifecycle::new(pid),
        })
    }

    pub(crate) fn lifecycle(&self) -> ProcessLifecycle {
        self.lifecycle.clone()
    }

    pub(crate) fn child_mut(&mut self) -> &mut Child {
        self.child.as_mut().expect("child guard is armed")
    }

    pub(crate) fn into_child(mut self) -> (Child, ProcessLifecycle) {
        (
            self.child.take().expect("child guard is armed"),
            self.lifecycle.clone(),
        )
    }

    pub(crate) async fn terminate(&mut self, timeout: Duration) -> Quiescence {
        let Some(child) = self.child.as_mut() else {
            return self.lifecycle.await_quiescence(timeout).await;
        };
        self.lifecycle.terminate_child(child, timeout).await
    }

    pub(crate) async fn wait_for_exit(&mut self) -> Quiescence {
        let Some(child) = self.child.as_mut() else {
            return Quiescence::Unknown;
        };
        self.lifecycle.wait_child(child).await
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut()
            && !self.lifecycle.reaped.load(Ordering::Acquire)
        {
            let _ = self.lifecycle.signal_owned_process();
            let _ = child.start_kill();
        }
    }
}

pub(crate) async fn terminate_child(
    child: &mut Child,
    lifecycle: &ProcessLifecycle,
    timeout: Duration,
) -> Quiescence {
    lifecycle.terminate_child(child, timeout).await
}

pub(crate) async fn await_child_exit(
    child: &mut Child,
    lifecycle: &ProcessLifecycle,
) -> Quiescence {
    lifecycle.wait_child(child).await
}

pub(crate) fn signal_process_tree(pid: u32) -> std::io::Result<()> {
    if pid == 0 || pid > i32::MAX as u32 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "invalid owned process group",
        ));
    }
    #[cfg(unix)]
    {
        let result = unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
        if result == 0 {
            return Ok(());
        }
        Err(std::io::Error::last_os_error())
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "process tree termination is unavailable on this platform",
        ))
    }
}

fn process_group_is_empty(pid: u32) -> bool {
    #[cfg(unix)]
    {
        let result = unsafe { libc::kill(-(pid as i32), 0) };
        result != 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

pub(crate) fn configure_process_group(command: &mut Command) {
    #[cfg(unix)]
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Stdio;

    #[cfg(unix)]
    #[tokio::test]
    async fn child_guard_confirms_exit_after_startup_failure() {
        let mut command = Command::new("/bin/sleep");
        command.arg("30").stdout(Stdio::null());
        configure_process_group(&mut command);
        let child = command.spawn().unwrap();
        let mut guard = ChildGuard::new(child).unwrap();
        let result = guard.terminate(Duration::from_secs(2)).await;
        assert_eq!(result, Quiescence::Confirmed);
        assert_eq!(
            guard
                .lifecycle()
                .await_quiescence(Duration::from_millis(1))
                .await,
            Quiescence::Confirmed
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn process_lifecycle_does_not_infer_exit_from_signal_acceptance() {
        let mut command = Command::new("/bin/sleep");
        command.arg("30").stdout(Stdio::null());
        configure_process_group(&mut command);
        let child = command.spawn().unwrap();
        let mut guard = ChildGuard::new(child).unwrap();
        let lifecycle = guard.lifecycle();
        assert_eq!(
            lifecycle.request_termination().await,
            ControlEffectState::Received
        );
        assert_eq!(
            lifecycle.await_quiescence(Duration::from_secs(2)).await,
            Quiescence::Unknown
        );
        assert_eq!(
            guard.terminate(Duration::from_secs(2)).await,
            Quiescence::Confirmed
        );
    }
}

#[cfg(all(test, unix))]
mod conformance {
    use super::*;
    use crate::agent::claude::{AdapterEvent, TurnOptions};
    use crate::agent::store::{ApprovalPolicy, PermissionMode};
    use std::os::unix::fs::PermissionsExt;

    struct BackendEnvironment(Vec<(&'static str, Option<std::ffi::OsString>)>);

    impl Drop for BackendEnvironment {
        fn drop(&mut self) {
            for (name, value) in &self.0 {
                unsafe {
                    if let Some(value) = value {
                        std::env::set_var(name, value);
                    } else {
                        std::env::remove_var(name);
                    }
                }
            }
        }
    }

    #[tokio::test]
    async fn all_backends_rollback_abrupt_executor_exit() {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("executor.py");
        let pid_file = directory.path().join("pids");
        std::fs::write(&script, format!("#!/usr/bin/env python3\nimport os\nwith open({:?}, 'a') as f: f.write(str(os.getpid())+' '+os.environ.get('PROSPERO_EXECUTION_HOST_SOCKET','missing')+'\\n')\n", pid_file.to_str().unwrap())).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let names = [
            "PROSPERO_CLAUDE_BIN",
            "PROSPERO_CODEX_BIN",
            "PROSPERO_DEEPSEEK_BIN",
            "PROSPERO_OPENCODE_BIN",
        ];
        let _environment = BackendEnvironment(
            names
                .iter()
                .map(|name| (*name, std::env::var_os(name)))
                .collect(),
        );
        for name in names {
            unsafe {
                std::env::set_var(name, &script);
            }
        }
        let options = TurnOptions {
            policy: ApprovalPolicy::Manual,
            mode: PermissionMode::Default,
            model: None,
            effort: None,
            agent_preset: None,
            environment: vec![(
                "PROSPERO_EXECUTION_HOST_SOCKET".into(),
                "isolated.socket".into(),
            )],
            api_profile: None,
        };
        let workspace = directory.path().to_str().unwrap();
        let mut claude =
            crate::agent::claude::spawn_turn(workspace, "test", &[], None, &options).unwrap();
        let mut events = claude.take_events().unwrap();
        let terminal = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match events.recv().await {
                    Some(AdapterEvent::Finish { error, .. }) => break error,
                    Some(_) => {}
                    None => panic!("Claude disconnected without terminal failure"),
                }
            }
        })
        .await
        .unwrap();
        assert!(
            terminal
                .unwrap()
                .contains("closed before a terminal result")
        );
        assert_eq!(
            claude
                .lifecycle()
                .await_quiescence(Duration::from_secs(2))
                .await,
            Quiescence::Confirmed
        );
        let data = directory.path().join("data");
        std::fs::create_dir_all(&data).unwrap();
        assert!(
            crate::agent::codex::spawn_turn(&data, workspace, "test", None, &options)
                .await
                .is_err()
        );
        assert!(
            crate::agent::deepseek::spawn_turn(workspace, "test", &[], None, &options)
                .await
                .is_err()
        );
        assert!(
            crate::agent::opencode::spawn_turn(workspace, "test", &[], None, &options)
                .await
                .is_err()
        );
        let pids = std::fs::read_to_string(pid_file).unwrap();
        assert_eq!(pids.lines().count(), 4);
        assert!(
            pids.lines().all(|line| line.ends_with(" isolated.socket")),
            "every backend must inherit its execution-scoped Host environment: {pids}"
        );
        for pid in pids.lines().map(|pid| {
            pid.split_whitespace()
                .next()
                .unwrap()
                .parse::<i32>()
                .unwrap()
        }) {
            assert_ne!(
                unsafe { libc::kill(pid, 0) },
                0,
                "executor {pid} survived startup rollback"
            );
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::ESRCH)
            );
        }
    }

    #[tokio::test]
    async fn waiting_for_exit_does_not_block_termination() {
        let mut command = Command::new("/bin/sleep");
        command.arg("30");
        configure_process_group(&mut command);
        let mut guard = ChildGuard::new(command.spawn().unwrap()).unwrap();
        let lifecycle = guard.lifecycle();
        let waiter = tokio::spawn(async move { guard.wait_for_exit().await });
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(
            tokio::time::timeout(Duration::from_millis(200), lifecycle.request_termination())
                .await
                .unwrap(),
            ControlEffectState::Received
        );
        assert_eq!(waiter.await.unwrap(), Quiescence::Confirmed);
    }

    #[tokio::test]
    async fn reaped_leader_does_not_prove_descendant_exit_or_allow_signalling() {
        let directory = tempfile::tempdir().unwrap();
        let child_file = directory.path().join("child");
        let mut command = Command::new("/bin/sh");
        command
            .arg("-c")
            .arg("sleep 30 & echo $! > \"$1\"")
            .arg("test")
            .arg(&child_file);
        configure_process_group(&mut command);
        let mut guard = ChildGuard::new(command.spawn().unwrap()).unwrap();
        assert_eq!(guard.wait_for_exit().await, Quiescence::Unknown);
        let pid = std::fs::read_to_string(child_file)
            .unwrap()
            .trim()
            .parse::<i32>()
            .unwrap();
        assert_eq!(
            guard.lifecycle().request_termination().await,
            ControlEffectState::Unknown
        );
        assert_eq!(unsafe { libc::kill(pid, 0) }, 0);
        assert_eq!(unsafe { libc::kill(pid, libc::SIGKILL) }, 0);
        assert_eq!(
            guard
                .lifecycle()
                .await_quiescence(Duration::from_secs(3))
                .await,
            Quiescence::Confirmed
        );
    }

    #[tokio::test]
    async fn http_rate_limit_preserves_retry_after_and_backend_evidence() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            tokio::time::timeout(Duration::from_secs(2), async {
                while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                    let mut chunk = [0; 1024];
                    let received = socket.read(&mut chunk).await.unwrap();
                    assert!(received > 0, "request closed before its headers completed");
                    request.extend_from_slice(&chunk[..received]);
                    assert!(
                        request.len() <= 16_384,
                        "request headers exceeded test limit"
                    );
                }
            })
            .await
            .unwrap();
            assert!(request.starts_with(b"GET / HTTP/1.1\r\n"));
            let body = "provider original diagnostic evidence";
            let response = format!(
                "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 2\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        });
        let response = reqwest::get(format!("http://{address}/")).await.unwrap();
        let error = http_response_error("fake backend", response).await;
        let structured = driver_error_from_error(&error, DriverPhase::Send);
        assert_eq!(structured.category, DriverErrorCategory::RateLimit);
        assert_eq!(structured.retry_after_ms, Some(2000));
        assert!(
            structured
                .message
                .contains("provider original diagnostic evidence")
        );
        server.await.unwrap();
    }

    #[test]
    fn errors_preserve_evidence_and_unknown_effects() {
        let transport = driver_error_from_error(
            &Error::Io(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "backend pipe evidence",
            )),
            DriverPhase::Send,
        );
        assert_eq!(transport.category, DriverErrorCategory::Transport);
        assert_eq!(transport.control_effect_state, ControlEffectState::Unknown);
        assert!(transport.message.contains("backend pipe evidence"));
        let limited = driver_error_from_error(
            &Error::Invalid("HTTP 429 rate limited; provider diagnostic abc".into()),
            DriverPhase::Create,
        );
        assert_eq!(limited.category, DriverErrorCategory::RateLimit);
        assert!(limited.retryable);
        assert!(limited.message.contains("provider diagnostic abc"));
        let unknown = driver_error_from_error(
            &cleanup_error(Error::Timeout, Quiescence::Unknown),
            DriverPhase::Create,
        );
        assert_eq!(unknown.category, DriverErrorCategory::Ownership);
        assert_eq!(unknown.control_effect_state, ControlEffectState::Unknown);
        assert!(!unknown.retryable);
    }
}
