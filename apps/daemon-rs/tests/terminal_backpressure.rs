#![cfg(unix)]

use std::time::Duration;

use base64::{Engine, engine::general_purpose::STANDARD};
use portable_pty::CommandBuilder;
use prosperod_rs::terminal::{
    Terminal, TerminalEvent, TerminalInput, TerminalQuery, TerminalSize, spawn,
};

fn fixture(script: &str) -> Terminal {
    let mut command = CommandBuilder::new("python3");
    command.args(["-u", "-c", script]);
    spawn(command, TerminalSize { cols: 80, rows: 24 }).unwrap()
}

async fn read_until(terminal: &Terminal, cursor: &mut i64, marker: &[u8]) -> Vec<u8> {
    tokio::time::timeout(Duration::from_secs(20), async {
        let mut bytes = Vec::new();
        loop {
            let page = terminal
                .read(TerminalQuery {
                    after_seq: Some(*cursor),
                    wait_ms: Some(50),
                })
                .await
                .unwrap();
            assert!(
                !page.resync_required,
                "test reader must consume every output page"
            );
            *cursor = page.next_seq;
            for event in page.events {
                if let TerminalEvent::Output { data_b64 } = event {
                    bytes.extend(STANDARD.decode(data_b64).unwrap());
                }
            }
            if bytes.windows(marker.len()).any(|window| window == marker) {
                return bytes;
            }
            assert!(
                !page.exited,
                "fixture exited early: {}",
                String::from_utf8_lossy(&bytes)
            );
        }
    })
    .await
    .expect("fixture output timeout")
}

#[tokio::test]
async fn megabyte_paste_survives_paused_stdin_and_concurrent_stdout() {
    let terminal = fixture(
        r#"
import os, time, tty, hashlib
tty.setraw(0)
os.write(1, b'READY')
time.sleep(0.5)
# Output exceeds a PTY buffer before consuming stdin; a blocking writer loop
# would deadlock here even though the child is healthy.
for _ in range(16):
    os.write(1, b'output\r\n' * 1024)
data = bytearray()
while len(data) < 1048576:
    data.extend(os.read(0, min(8192, 1048576 - len(data))))
os.write(1, b'CHECKSUM:' + hashlib.sha256(data).hexdigest().encode() + b':DONE')
"#,
    );
    let mut cursor = 0;
    read_until(&terminal, &mut cursor, b"READY").await;
    let sender = terminal.clone();
    let input = tokio::spawn(async move {
        for _ in 0..128 {
            sender
                .input(TerminalInput {
                    data_b64: STANDARD.encode(vec![b'x'; 8192]),
                })
                .await
                .unwrap();
        }
    });
    let bytes = read_until(&terminal, &mut cursor, b":DONE").await;
    input.await.unwrap();
    use sha2::{Digest, Sha256};
    let hash: String = Sha256::digest(vec![b'x'; 1048576])
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let expected = format!("CHECKSUM:{hash}:DONE");
    assert!(
        bytes
            .windows(expected.len())
            .any(|window| window == expected.as_bytes())
    );
    tokio::time::timeout(Duration::from_secs(3), terminal.wait_exited())
        .await
        .unwrap();
}

#[tokio::test]
async fn stop_cancels_a_blocked_writer_without_waiting_for_stdin() {
    let terminal =
        fixture("import os,time,tty\ntty.setraw(0)\nos.write(1,b'READY')\ntime.sleep(60)");
    let mut cursor = 0;
    read_until(&terminal, &mut cursor, b"READY").await;
    let sender = terminal.clone();
    let input = tokio::spawn(async move {
        for _ in 0..128 {
            sender
                .input(TerminalInput {
                    data_b64: STANDARD.encode(vec![b'x'; 8192]),
                })
                .await?;
        }
        Ok::<_, prosperod_rs::error::Error>(())
    });
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(
        !input.is_finished(),
        "writer must remain pending while stdin is blocked"
    );
    assert!(
        !terminal
            .read(TerminalQuery::default())
            .await
            .unwrap()
            .exited
    );
    terminal.stop();
    tokio::time::timeout(Duration::from_secs(3), terminal.wait_exited())
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(1), input)
            .await
            .unwrap()
            .unwrap()
            .is_err()
    );
}
