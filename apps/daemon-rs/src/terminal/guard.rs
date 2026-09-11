use std::ffi::OsString;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crate::error::{Error, Result};

static STOP: AtomicBool = AtomicBool::new(false);

extern "C" fn stopped(_: i32) {
    STOP.store(true, Ordering::Relaxed);
}

pub fn run(parent: u32, shell: OsString, args: Vec<OsString>) -> Result<i32> {
    let session = unsafe { libc::getpid() };
    if parent < 2
        || unsafe { libc::getppid() } != parent as i32
        || unsafe { libc::getsid(0) } != session
        || unsafe { libc::isatty(0) } != 1
    {
        return Err(Error::Invalid(
            "terminal guard requires an owned PTY session".into(),
        ));
    }
    for signal in [libc::SIGHUP, libc::SIGTERM, libc::SIGINT] {
        let mut action = unsafe { std::mem::zeroed::<libc::sigaction>() };
        action.sa_sigaction = stopped as *const () as usize;
        unsafe {
            libc::sigemptyset(&mut action.sa_mask);
        }
        if unsafe { libc::sigaction(signal, &action, std::ptr::null_mut()) } != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
    }
    unsafe {
        libc::signal(libc::SIGTTOU, libc::SIG_IGN);
    }
    let mut command = Command::new(shell);
    command
        .args(args)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .process_group(0);
    unsafe {
        command.pre_exec(|| {
            if libc::tcsetpgrp(0, libc::getpid()) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            for signal in [libc::SIGHUP, libc::SIGTERM, libc::SIGINT, libc::SIGTTOU] {
                libc::signal(signal, libc::SIG_DFL);
            }
            Ok(())
        });
    }
    let mut child = command
        .spawn()
        .map_err(|_| Error::Invalid("cannot start guarded terminal process".into()))?;
    let outcome = loop {
        if STOP.load(Ordering::Relaxed) || unsafe { libc::getppid() } != parent as i32 {
            break Ok(None);
        }
        match child.try_wait() {
            Ok(Some(status)) => break Ok(Some(status)),
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(error) => break Err(error),
        }
    };
    super::native::terminate_session(session, Some(session));
    let _ = child.kill();
    let _ = child.wait();
    let status = outcome?;
    Ok(status.and_then(|status| status.code()).unwrap_or(1))
}
