use std::io::{Read, Write};
use std::time::Instant;

use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};

use super::*;

pub struct Wake;

impl Wake {
    pub fn signal(&self) {}
}

enum ReaderEvent {
    Output(Vec<u8>),
    Closed,
}

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
    let mut reader = pair.master.try_clone_reader().map_err(|_| Error::Closed)?;
    let mut writer = pair.master.take_writer().map_err(|_| Error::Closed)?;
    let wake = Wake;
    let (sender, mut receiver) = mpsc::channel::<Control>(32);
    let (output_sender, output_receiver) = std::sync::mpsc::channel::<ReaderEvent>();
    let output = Arc::new(Mutex::new(Output::new(size)));
    let stop = Arc::new(AtomicBool::new(false));
    let (changed, updates) = watch::channel(0);
    let terminal = Terminal(Arc::new(Inner {
        sender,
        output: output.clone(),
        notifier: changed.clone(),
        changed: updates,
        stop: stop.clone(),
        wake,
    }));
    let (ready, started) = std::sync::mpsc::sync_channel(1);
    let reader_stop = stop.clone();
    std::thread::Builder::new()
        .name("prospero-pty-reader".into())
        .spawn(move || {
            let mut buffer = [0; 16384];
            while !reader_stop.load(Ordering::Acquire) {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => {
                        if output_sender
                            .send(ReaderEvent::Output(buffer[..count].to_vec()))
                            .is_err()
                        {
                            return;
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                    Err(_) => break,
                }
            }
            let _ = output_sender.send(ReaderEvent::Closed);
        })?;
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
            let Some(pid) = child.process_id() else {
                let _ = child.kill();
                let _ = child.wait();
                let _ = ready.send(Err(Error::Closed));
                return;
            };
            if ready.send(Ok(())).is_err() {
                stop.store(true, Ordering::Release);
            }
            let mut current_size = size;
            let mut ended = None;
            let mut exit_code = None;
            let mut signalled = false;
            let mut output_closed = false;
            loop {
                if ended.is_none() && stop.load(Ordering::Acquire) && !signalled {
                    terminate(pair.master.as_ref(), pid);
                    #[cfg(windows)]
                    let _ = child.kill();
                    signalled = true;
                    ended = Some(Instant::now());
                }
                if ended.is_none() {
                    match child.try_wait() {
                        Ok(Some(status)) => {
                            terminate(pair.master.as_ref(), pid);
                            exit_code = Some(status.exit_code());
                            ended = Some(Instant::now());
                        }
                        Ok(None) => {}
                        Err(_) => {
                            stop.store(true, Ordering::Release);
                            ended = Some(Instant::now());
                        }
                    }
                }
                let mut read_any = false;
                for event in output_receiver.try_iter().take(16) {
                    match event {
                        ReaderEvent::Output(bytes) => {
                            read_any = true;
                            accept_output(&output, &changed, writer.as_mut(), &stop, &bytes);
                        }
                        ReaderEvent::Closed => {
                            output_closed = true;
                            stop.store(true, Ordering::Release);
                        }
                    }
                }
                if let Some(ended) = ended
                    && (output_closed
                        || (!read_any && ended.elapsed() >= Duration::from_millis(100)))
                {
                    break;
                }
                while let Ok(control) = receiver.try_recv() {
                    handle_control(
                        control,
                        pair.master.as_ref(),
                        &mut writer,
                        &mut current_size,
                        &output,
                        &changed,
                        &stop,
                    );
                }
                if !read_any {
                    match output_receiver.recv_timeout(Duration::from_millis(20)) {
                        Ok(ReaderEvent::Output(bytes)) => {
                            accept_output(&output, &changed, writer.as_mut(), &stop, &bytes);
                        }
                        Ok(ReaderEvent::Closed) => {
                            output_closed = true;
                            stop.store(true, Ordering::Release);
                        }
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                            output_closed = true;
                            stop.store(true, Ordering::Release);
                        }
                    }
                }
            }
            let status = child.wait().ok();
            if exit_code.is_none() {
                exit_code = status.map(|status| status.exit_code());
            }
            drop(writer);
            drop(pair.master);
            stop.store(true, Ordering::Release);
            if let Ok(mut output) = output.lock() {
                output.set_exited(exit_code);
            }
            changed.send_modify(|v| *v = v.wrapping_add(1));
        })?;
    started.recv().map_err(|_| Error::Closed)??;
    Ok(terminal)
}

fn accept_output(
    output: &Arc<Mutex<Output>>,
    changed: &watch::Sender<u64>,
    writer: &mut dyn Write,
    stop: &AtomicBool,
    bytes: &[u8],
) {
    let responses = if let Ok(mut output) = output.lock() {
        output.write(bytes)
    } else {
        Vec::new()
    };
    changed.send_modify(|v| *v = v.wrapping_add(1));
    for response in responses {
        if write_input(writer, &response, stop).is_err() {
            stop.store(true, Ordering::Release);
            break;
        }
    }
}

fn handle_control(
    control: Control,
    master: &dyn MasterPty,
    writer: &mut dyn Write,
    current_size: &mut TerminalSize,
    output: &Arc<Mutex<Output>>,
    changed: &watch::Sender<u64>,
    stop: &AtomicBool,
) {
    match control {
        Control::Input(bytes, reply) => {
            if !reply.is_closed() {
                let result = write_input(writer, &bytes, stop);
                if result.is_err() {
                    stop.store(true, Ordering::Release);
                }
                let _ = reply.send(result.map_err(|_| Error::TerminalInput));
            }
        }
        Control::Resize(size, reply) => {
            if !reply.is_closed() {
                let result = if *current_size == size {
                    Ok(())
                } else {
                    master
                        .resize(pty_size(size))
                        .map_err(|_| Error::Closed)
                        .map(|_| {
                            *current_size = size;
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

#[cfg(unix)]
fn terminate(master: &dyn MasterPty, pid: u32) {
    let pid = pid as i32;
    terminate_session(pid, None);
    if let Some(group) = master.process_group_leader().filter(|group| *group > 0) {
        unsafe {
            libc::kill(-group, libc::SIGKILL);
        }
    }
    unsafe {
        libc::kill(-pid, libc::SIGKILL);
    }
}

#[cfg(windows)]
fn terminate(_master: &dyn MasterPty, _pid: u32) {}

#[cfg(unix)]
pub(super) fn terminate_session(session: i32, keep: Option<i32>) {
    for process in processes() {
        if process > 0 && Some(process) != keep && unsafe { libc::getsid(process) } == session {
            unsafe {
                libc::kill(process, libc::SIGKILL);
            }
        }
    }
}

#[cfg(unix)]
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
