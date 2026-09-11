#![cfg(unix)]

use base64::{Engine, engine::general_purpose::STANDARD};
use portable_pty::CommandBuilder;
use prosperod_rs::terminal::{
    Terminal, TerminalEvent, TerminalInput, TerminalQuery, TerminalSize, spawn,
};
use std::time::Duration;

fn guarded(script: &str) -> Terminal {
    let mut command = CommandBuilder::new(env!("CARGO_BIN_EXE_prosperod-rs"));
    command.args([
        "terminal-guard",
        "--parent",
        &std::process::id().to_string(),
        "--shell",
        "/bin/sh",
        "--",
        "-c",
        script,
    ]);
    spawn(command, TerminalSize { cols: 80, rows: 24 }).unwrap()
}

async fn collect(terminal: &Terminal, marker: &str) -> String {
    tokio::time::timeout(Duration::from_secs(3), async {
        let mut cursor = 0;
        let mut bytes = Vec::new();
        loop {
            let page = terminal
                .read(TerminalQuery {
                    after_seq: Some(cursor),
                    wait_ms: Some(100),
                })
                .await
                .unwrap();
            for event in page.events {
                if let TerminalEvent::Output { data_b64 } = event {
                    bytes.extend(STANDARD.decode(data_b64).unwrap());
                }
            }
            cursor = page.next_seq;
            let text = String::from_utf8_lossy(&bytes).into_owned();
            if text.contains(marker) {
                return text;
            }
            assert!(!page.exited, "guard exited early: {text}");
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn guard_preserves_child_exit_status_and_interactive_input() {
    let terminal =
        guarded("stty -echo; printf READY; read value; printf '<%s>' \"$value\"; exit 7");
    collect(&terminal, "READY").await;
    terminal
        .input(TerminalInput {
            data_b64: STANDARD.encode("中文🦀\n"),
        })
        .await
        .unwrap();
    assert!(collect(&terminal, "<中文🦀>").await.contains("READY"));
    tokio::time::timeout(Duration::from_secs(3), terminal.wait_exited())
        .await
        .unwrap();
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
async fn ctrl_c_reaches_the_foreground_child_and_guard_remains_alive() {
    let terminal = guarded(
        "trap 'printf INTERRUPTED' INT; printf READY; read value; printf FINISHED; read value",
    );
    collect(&terminal, "READY").await;
    terminal
        .input(TerminalInput {
            data_b64: STANDARD.encode([3]),
        })
        .await
        .unwrap();
    collect(&terminal, "INTERRUPTED").await;
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
}

#[test]
fn guard_rejects_execution_without_an_owned_controlling_terminal() {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_prosperod-rs"))
        .args([
            "terminal-guard",
            "--parent",
            &std::process::id().to_string(),
            "--shell",
            "/bin/sh",
        ])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("owned PTY session"));
}
