use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::time::Instant;

use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};

use super::*;

fn pty_size(size: TerminalSize) -> PtySize {
    PtySize {
        rows: size.rows,
        cols: size.cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

pub fn spawn(command: CommandBuilder, size: TerminalSize) -> Result<Terminal> {
    size.validate()?;
    let pair = native_pty_system()
        .openpty(pty_size(size))
        .map_err(|_| Error::Invalid("cannot allocate terminal".into()))?;
    let fd = pair.master.as_raw_fd().ok_or(Error::Closed)?;
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let mut reader = pair.master.try_clone_reader().map_err(|_| Error::Closed)?;
    let mut writer = pair.master.take_writer().map_err(|_| Error::Closed)?;
    let (wake, mut awakened) = UnixStream::pair()?;
    wake.set_nonblocking(true)?;
    awakened.set_nonblocking(true)?;
    let (sender, mut receiver) = mpsc::channel::<Control>(32);
    let output = Arc::new(Mutex::new(Output::new(size)));
    let stop = Arc::new(AtomicBool::new(false));
    let (changed, updates) = watch::channel(0);
    let terminal = Terminal(Arc::new(Inner {
        sender,
        output: output.clone(),
        changed: updates,
        stop: stop.clone(),
        wake,
    }));
    let (ready, started) = std::sync::mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("prospero-pty".into())
        .spawn(move || {
            let mut child = match pair.slave.spawn_command(command) {
                Ok(child) => child,
                Err(_) => {
                    let _ = ready.send(Err(Error::Invalid("cannot start terminal process".into())));
                    return;
                }
            };
            drop(pair.slave);
            let Some(pid) = child.process_id().map(|pid| pid as i32) else {
                let _ = child.kill();
                let _ = child.wait();
                let _ = ready.send(Err(Error::Closed));
                return;
            };
            if ready.send(Ok(())).is_err() {
                stop.store(true, Ordering::Release);
            }
            let mut current_size = size;
            let mut buffer = [0; 16384];
            let mut ended = None;
            let mut exit_code = None;
            let mut signalled = false;
            loop {
                if ended.is_none() && stop.load(Ordering::Acquire) && !signalled {
                    terminate(pair.master.as_ref(), pid);
                    signalled = true;
                    ended = Some(Instant::now());
                }
                if ended.is_none() && exited(pid) {
                    terminate(pair.master.as_ref(), pid);
                    exit_code = child.wait().ok().map(|status| status.exit_code());
                    ended = Some(Instant::now());
                }
                let mut read_any = false;
                for _ in 0..16 {
                    match reader.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(count) => {
                            read_any = true;
                            if let Ok(mut output) = output.lock() {
                                output.write(&buffer[..count]);
                            }
                            changed.send_modify(|v| *v = v.wrapping_add(1));
                        }
                        Err(error)
                            if matches!(
                                error.kind(),
                                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                            ) =>
                        {
                            break;
                        }
                        Err(_) => {
                            stop.store(true, Ordering::Release);
                            break;
                        }
                    }
                }
                if let Some(ended) = ended {
                    if !read_any || ended.elapsed() >= Duration::from_millis(100) {
                        break;
                    }
                } else if let Ok(control) = receiver.try_recv() {
                    match control {
                        Control::Input(bytes, reply) => {
                            if !reply.is_closed() {
                                let result = write_input(writer.as_mut(), &bytes, &stop);
                                if result.is_err() {
                                    stop.store(true, Ordering::Release);
                                }
                                let _ = reply.send(result.map_err(|_| Error::TerminalInput));
                            }
                        }
                        Control::Resize(size, reply) => {
                            if !reply.is_closed() {
                                let result = if current_size == size {
                                    Ok(())
                                } else {
                                    pair.master
                                        .resize(pty_size(size))
                                        .map_err(|_| Error::Closed)
                                        .map(|_| {
                                            current_size = size;
                                            if let Ok(mut output) = output.lock() {
                                                output.push(TerminalEvent::Resize { size }, 0);
                                            }
                                            changed.send_modify(|v| *v = v.wrapping_add(1));
                                        })
                                };
                                let _ = reply.send(result);
                            }
                        }
                    }
                }
                if !read_any {
                    let mut fds = [
                        libc::pollfd {
                            fd,
                            events: libc::POLLIN,
                            revents: 0,
                        },
                        libc::pollfd {
                            fd: awakened.as_raw_fd(),
                            events: libc::POLLIN,
                            revents: 0,
                        },
                    ];
                    unsafe {
                        libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, 250);
                    }
                    let _ = awakened.read(&mut [0]);
                }
            }
            let status = child.wait().ok();
            if exit_code.is_none() {
                exit_code = status.map(|status| status.exit_code());
            }
            drop(writer);
            drop(reader);
            drop(pair.master);
            stop.store(true, Ordering::Release);
            if let Ok(mut output) = output.lock() {
                output.exited = true;
                output.exit_code = exit_code;
            }
            changed.send_modify(|v| *v = v.wrapping_add(1));
        })?;
    started.recv().map_err(|_| Error::Closed)??;
    Ok(terminal)
}

fn terminate(master: &dyn MasterPty, pid: i32) {
    for process in processes() {
        if unsafe { libc::getsid(process) } == pid {
            unsafe {
                libc::kill(process, libc::SIGKILL);
            }
        }
    }
    if let Some(group) = master.process_group_leader().filter(|group| *group > 0) {
        unsafe {
            libc::kill(-group, libc::SIGKILL);
        }
    }
    unsafe {
        libc::kill(-pid, libc::SIGKILL);
    }
}

fn exited(pid: i32) -> bool {
    let mut info = unsafe { std::mem::zeroed::<libc::siginfo_t>() };
    let result = unsafe {
        libc::waitid(
            libc::P_PID,
            pid as libc::id_t,
            &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    };
    result == 0 && unsafe { info.si_pid() } == pid
}

fn processes() -> Vec<i32> {
    #[cfg(target_os = "macos")]
    {
        let mut pids = vec![0_i32; 65536];
        let count =
            unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), (pids.len() * 4) as i32) };
        pids.truncate((count.max(0) as usize).min(pids.len()));
        pids
    }
    #[cfg(target_os = "linux")]
    {
        std::fs::read_dir("/proc")
            .into_iter()
            .flatten()
            .filter_map(|entry| entry.ok()?.file_name().to_str()?.parse().ok())
            .take(65536)
            .collect()
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        Vec::new()
    }
}

fn write_input(writer: &mut dyn Write, bytes: &[u8], stop: &AtomicBool) -> Result<()> {
    let deadline = Instant::now() + Duration::from_millis(200);
    let mut offset = 0;
    while offset < bytes.len() {
        if stop.load(Ordering::Acquire) {
            return Err(Error::Closed);
        }
        if Instant::now() >= deadline {
            return Err(Error::Timeout);
        }
        match writer.write(&bytes[offset..]) {
            Ok(0) => return Err(Error::Closed),
            Ok(count) => offset += count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(2))
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}
