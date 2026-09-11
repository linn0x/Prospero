#![cfg(unix)]

use std::time::{Duration, Instant};

use base64::{Engine, engine::general_purpose::STANDARD};
use portable_pty::CommandBuilder;
use prosperod_rs::terminal::{
    Terminal, TerminalEvent, TerminalInput, TerminalQuery, TerminalSize, spawn,
};

fn start(script: &str) -> Terminal {
    let mut command = CommandBuilder::new("/bin/sh");
    command.args(["-c", script]);
    spawn(command, TerminalSize { cols: 80, rows: 24 }).unwrap()
}

async fn wait(terminal: &Terminal) {
    tokio::time::timeout(Duration::from_secs(3), terminal.wait_exited())
        .await
        .unwrap();
}

async fn output(terminal: &Terminal) -> Vec<u8> {
    let mut after = 0;
    let mut output = Vec::new();
    loop {
        let page = terminal
            .read(TerminalQuery {
                after_seq: Some(after),
                wait_ms: Some(100),
            })
            .await
            .unwrap();
        assert!(!page.resync_required);
        for event in page.events {
            if let TerminalEvent::Output { data_b64 } = event {
                output.extend(STANDARD.decode(data_b64).unwrap());
            }
        }
        after = page.next_seq;
        if after == page.latest_seq && page.exited {
            return output;
        }
    }
}

#[tokio::test]
async fn real_pty_preserves_split_unicode_ansi_and_exit_code() {
    let terminal = start(
        r"printf '\033[31m\344'; sleep 0.03; printf '\270\255\360\237\246\200\033[0m'; exit 7",
    );
    wait(&terminal).await;
    assert_eq!(output(&terminal).await, "\x1b[31m中🦀\x1b[0m".as_bytes());
    assert_eq!(
        terminal
            .read(TerminalQuery::default())
            .await
            .unwrap()
            .exit_code,
        Some(7)
    );
}

#[tokio::test]
async fn input_is_not_duplicated_and_resize_is_ordered() {
    let terminal =
        start("stty -echo; printf READY; read value; stty size; printf '<%s>' \"$value\"");
    let page = terminal
        .read(TerminalQuery {
            after_seq: Some(0),
            wait_ms: Some(1000),
        })
        .await
        .unwrap();
    assert!(!page.events.is_empty());
    let size = TerminalSize {
        cols: 100,
        rows: 30,
    };
    terminal.resize(size).await.unwrap();
    terminal.resize(size).await.unwrap();
    terminal
        .input(TerminalInput {
            data_b64: STANDARD.encode("中文🦀\n"),
        })
        .await
        .unwrap();
    wait(&terminal).await;
    assert_eq!(
        String::from_utf8(output(&terminal).await).unwrap(),
        "READY30 100\r\n<中文🦀>"
    );
    let page = terminal.read(TerminalQuery::default()).await.unwrap();
    assert_eq!(
        page.events
            .iter()
            .filter(|event| matches!(event, TerminalEvent::Resize { .. }))
            .count(),
        1
    );
}

#[tokio::test]
async fn excess_output_requires_resync_and_queries_stay_bounded() {
    let terminal = start("dd if=/dev/zero bs=65536 count=48 2>/dev/null");
    wait(&terminal).await;
    let page = terminal.read(TerminalQuery::default()).await.unwrap();
    assert!(page.resync_required);
    assert!(page.events.is_empty());
    assert!(page.latest_seq - page.floor_seq <= 512);
    let mut after = page.floor_seq;
    let mut bytes = 0;
    while after < page.latest_seq {
        let next = terminal
            .read(TerminalQuery {
                after_seq: Some(after),
                wait_ms: None,
            })
            .await
            .unwrap();
        assert!(next.events.len() <= 64);
        let mut page_bytes = 0;
        for event in next.events {
            if let TerminalEvent::Output { data_b64 } = event {
                page_bytes += STANDARD.decode(data_b64).unwrap().len();
            }
        }
        assert!(page_bytes <= 65536);
        bytes += page_bytes;
        assert!(next.next_seq > after);
        after = next.next_seq;
    }
    assert!(bytes <= 1024 * 1024);
    assert!(
        terminal
            .read(TerminalQuery {
                after_seq: Some(after + 1),
                wait_ms: None
            })
            .await
            .is_err()
    );
    assert!(
        terminal
            .read(TerminalQuery {
                after_seq: Some(-1),
                wait_ms: None
            })
            .await
            .is_err()
    );
}

#[tokio::test]
async fn close_wakes_readers_and_cleans_background_and_foreground_jobs() {
    let terminal = start("sleep 60 & echo $!; sleep 60 & echo $!; wait");
    let mut pids = Vec::new();
    let mut after = 0;
    let mut bytes = Vec::new();
    for _ in 0..20 {
        let page = terminal
            .read(TerminalQuery {
                after_seq: Some(after),
                wait_ms: Some(100),
            })
            .await
            .unwrap();
        after = page.next_seq;
        for event in page.events {
            if let TerminalEvent::Output { data_b64 } = event {
                bytes.extend(STANDARD.decode(data_b64).unwrap());
            }
        }
        pids = String::from_utf8_lossy(&bytes)
            .split_whitespace()
            .filter_map(|value| value.parse::<i32>().ok())
            .collect();
        if pids.len() == 2 {
            break;
        }
    }
    assert_eq!(pids.len(), 2);
    let reader = terminal.clone();
    let reading = tokio::spawn(async move {
        reader
            .read(TerminalQuery {
                after_seq: Some(after),
                wait_ms: Some(5000),
            })
            .await
            .unwrap()
    });
    let started = Instant::now();
    terminal.stop();
    wait(&terminal).await;
    assert!(reading.await.unwrap().exited);
    assert!(started.elapsed() < Duration::from_millis(500));
    for pid in pids {
        for _ in 0..100 {
            if unsafe { libc::kill(pid, 0) } != 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_ne!(unsafe { libc::kill(pid, 0) }, 0, "child {pid} survived");
    }
}

#[tokio::test]
async fn rejects_invalid_input_and_dimensions() {
    let terminal = start("sleep 60");
    assert!(
        terminal
            .input(TerminalInput {
                data_b64: "!".into()
            })
            .await
            .is_err()
    );
    assert!(
        terminal
            .input(TerminalInput {
                data_b64: STANDARD.encode(vec![b'x'; 8193])
            })
            .await
            .is_err()
    );
    assert!(
        terminal
            .resize(TerminalSize { cols: 0, rows: 24 })
            .await
            .is_err()
    );
    terminal.stop();
    wait(&terminal).await;
    assert!(
        terminal
            .input(TerminalInput {
                data_b64: STANDARD.encode("x")
            })
            .await
            .is_err()
    );
}

#[tokio::test]
async fn backpressure_stops_the_session_and_never_recommends_replaying_partial_input() {
    let terminal = start("stty raw -echo; printf READY; sleep 60");
    let page = terminal
        .read(TerminalQuery {
            after_seq: Some(0),
            wait_ms: Some(1000),
        })
        .await
        .unwrap();
    assert!(!page.events.is_empty());
    let mut failure = None;
    for _ in 0..256 {
        if let Err(error) = terminal
            .input(TerminalInput {
                data_b64: STANDARD.encode(vec![b'x'; 8192]),
            })
            .await
        {
            failure = Some(error.public());
            break;
        }
    }
    terminal.stop();
    wait(&terminal).await;
    let failure = failure.expect("bounded input buffer must apply backpressure");
    assert_eq!(failure.code, "terminal_input_failed");
    assert!(!failure.retryable);
}

#[tokio::test]
async fn dropping_the_last_handle_terminates_the_owned_process() {
    let terminal = start("echo $$; sleep 60");
    let page = terminal
        .read(TerminalQuery {
            after_seq: Some(0),
            wait_ms: Some(1000),
        })
        .await
        .unwrap();
    let bytes: Vec<_> = page
        .events
        .into_iter()
        .filter_map(|event| match event {
            TerminalEvent::Output { data_b64 } => Some(STANDARD.decode(data_b64).unwrap()),
            _ => None,
        })
        .flatten()
        .collect();
    let pid: i32 = String::from_utf8(bytes).unwrap().trim().parse().unwrap();
    drop(terminal);
    for _ in 0..100 {
        if unsafe { libc::kill(pid, 0) } != 0 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("owned terminal process survived handle disposal");
}
