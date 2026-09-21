use std::io::{Read, Write};
use std::time::Instant;

use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};

use super::*;

pub struct Wake(std::sync::mpsc::SyncSender<ReaderEvent>);

impl Wake {
    pub fn signal(&self) {
        // If full, output already wakes the consumer. Never block input here.
        let _ = self.0.try_send(ReaderEvent::Wake);
    }
}

enum ReaderEvent {
    Wake,
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
    validate_size(size)?;
    let pair = native_pty_system()
        .openpty(pty_size(size))
        .map_err(|_| Error::Invalid("cannot allocate terminal".into()))?;
    #[cfg(unix)]
    set_nonblocking(pair.master.as_ref())?;
    let mut reader = pair.master.try_clone_reader().map_err(|_| Error::Closed)?;
    let mut writer = pair.master.take_writer().map_err(|_| Error::Closed)?;
    let (sender, mut receiver) = mpsc::channel::<Control>(32);
    // At most 1 MiB of reader chunks can await terminal parsing.
    let (output_sender, output_receiver) = std::sync::mpsc::sync_channel::<ReaderEvent>(64);
    let wake = Wake(output_sender.clone());
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
                    Err(error)
                        if matches!(
                            error.kind(),
                            std::io::ErrorKind::Interrupted | std::io::ErrorKind::WouldBlock
                        ) =>
                    {
                        std::thread::sleep(Duration::from_millis(2));
                    }
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
            #[cfg(target_os = "macos")]
            let mut exit_probe = Instant::now();
            #[cfg(target_os = "macos")]
            let mut exiting = false;
            #[cfg(not(target_os = "macos"))]
            let exiting = false;
            loop {
                if ended.is_none() && stop.load(Ordering::Acquire) && !signalled {
                    terminate(pair.master.as_ref(), pid);
                    // Always terminate the owned child as well as its process
                    // group; group discovery can race with shell job control.
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
                for event in output_receiver.try_iter().take(4) {
                    match event {
                        ReaderEvent::Wake => {
                            read_any = true;
                        }
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
                #[cfg(target_os = "macos")]
                if ended.is_none() && !read_any && exit_probe.elapsed() >= Duration::from_millis(50)
                {
                    exit_probe = Instant::now();
                    // Darwin may hold a dying process in tty teardown before
                    // waitpid becomes ready. Drain queued output, then close
                    // our master handles so that exit can finish.
                    if process_is_exiting(pid) {
                        terminate_session(pid as i32, Some(pid as i32));
                        exiting = true;
                        ended = Some(Instant::now());
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
                        Ok(ReaderEvent::Wake) => {}
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
            if !exiting && child.try_wait().ok().flatten().is_none() {
                let _ = child.kill();
            }
            // Release every master handle before reaping. On macOS a process
            // can remain in tty teardown while a master reader is still open.
            stop.store(true, Ordering::Release);
            drop(output_receiver);
            drop(writer);
            drop(pair.master);
            let status = child.wait().ok();
            if exit_code.is_none() {
                exit_code = status.map(|status| status.exit_code());
            }
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

#[cfg(target_os = "macos")]
fn process_is_exiting(pid: u32) -> bool {
    // PROC_FLAG_INEXIT from the public Darwin sys/proc_info.h ABI.
    const INEXIT: u32 = 4;
    let mut info = unsafe { std::mem::zeroed::<libc::proc_bsdinfo>() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
    let read = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size,
        )
    };
    read == size && info.pbi_pid == pid && info.pbi_flags & INEXIT != 0
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
fn set_nonblocking(master: &dyn MasterPty) -> Result<()> {
    let fd = master.as_raw_fd().ok_or(Error::Closed)?;
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

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

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Terminal {
        let (sender, _receiver) = mpsc::channel(32);
        let (notifier, changed) = watch::channel(0);
        let (wake_sender, _wake_receiver) = std::sync::mpsc::sync_channel(1);
        Terminal(Arc::new(Inner {
            sender,
            output: Arc::new(Mutex::new(Output::new(TerminalSize { cols: 80, rows: 24 }))),
            notifier,
            changed,
            stop: Arc::new(AtomicBool::new(false)),
            wake: Wake(wake_sender),
        }))
    }

    #[tokio::test]
    async fn activity_wakeup_does_not_finish_an_output_long_poll() {
        let terminal = fixture();
        let read = terminal.read(TerminalQuery {
            after_seq: Some(0),
            wait_ms: Some(1000),
        });
        tokio::pin!(read);
        assert!(futures_util::poll!(&mut read).is_pending());
        terminal.0.notifier.send_modify(|v| *v += 1);
        assert!(futures_util::poll!(&mut read).is_pending());
        terminal.0.output.lock().unwrap().write(b"echo");
        terminal.0.notifier.send_modify(|v| *v += 1);
        let page = read.await.unwrap();
        assert_eq!(page.next_seq, 1);
        assert_eq!(page.events.len(), 1);
    }

    #[tokio::test]
    async fn activity_wakeup_preserves_the_original_timeout() {
        let terminal = fixture();
        let start = Instant::now();
        let read = terminal.read(TerminalQuery {
            after_seq: Some(0),
            wait_ms: Some(30),
        });
        tokio::pin!(read);
        assert!(futures_util::poll!(&mut read).is_pending());
        terminal.0.notifier.send_modify(|v| *v += 1);
        let page = tokio::time::timeout(Duration::from_secs(1), read)
            .await
            .unwrap()
            .unwrap();
        assert!(page.events.is_empty());
        assert!(start.elapsed() >= Duration::from_millis(30));
    }

    #[test]
    fn control_wakeup_is_immediate_and_never_blocks_on_a_full_output_queue() {
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        let wake = Wake(sender);
        wake.signal();
        wake.signal();
        assert!(matches!(receiver.try_recv(), Ok(ReaderEvent::Wake)));
        assert!(receiver.try_recv().is_err());
    }
}
