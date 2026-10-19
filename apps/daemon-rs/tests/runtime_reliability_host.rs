#![cfg(unix)]

use prosperod_rs::{
    agent::CreateAgentSession,
    execution_host::launcher::{HostHandle, HostManifest, ensure_host},
    execution_host::{HostClient, HostEventPage, HostRequest, HostResponse},
    orchestration::reliability::{
        ControlEffectState, ExecutionIdentity, HostCommand, HostCommandKind, HostCommandState,
        HostIdentity, InteractionReply, VerifiedExitProof, host_command_fingerprint,
    },
    protocol::AgentKind,
};
use std::{
    fs,
    io::Write,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tempfile::TempDir;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
    time::{sleep, timeout},
};

const FAKE_CLAUDE: &str = r##"#!/usr/bin/env python3
import json
import os
import signal
import sys
import time

def emit(value):
    sys.stdout.write(json.dumps(value) + "\n")
    sys.stdout.flush()

signal.signal(signal.SIGINT, signal.SIG_IGN)
signal.signal(signal.SIGTERM, signal.SIG_IGN)
with open("executor.pid", "w") as output:
    output.write(str(os.getpid()))
with open("starts.log", "a") as output:
    output.write("started\n")
emit({"type": "system", "subtype": "init", "session_id": "fake-native-session"})
for line in sys.stdin:
    frame = json.loads(line)
    if frame.get("type") != "user":
        continue
    emit({"type": "assistant", "message": {"role": "assistant", "content": [
        {"type": "tool_use", "id": "call-approval", "name": "Bash", "input": {"command": "printf fixture"}}
    ]}})
    emit({"type": "control_request", "request_id": "approval-42", "request": {
        "subtype": "can_use_tool", "tool_name": "Bash", "input": {"command": "printf fixture"}
    }})
    answer = sys.stdin.readline()
    with open("approval.log", "w") as output:
        output.write(answer)
    emit({"type": "user", "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "call-approval", "is_error": '"deny"' in answer,
         "content": "permission reply observed"}
    ]}})
    while True:
        time.sleep(1)
"##;

const DELAYED_OUTPUT_CLAUDE: &str = r##"#!/usr/bin/env python3
import json
import subprocess
import sys
import time

print(json.dumps({"type":"system","subtype":"init","session_id":"delayed-output-session"}), flush=True)
for line in sys.stdin:
    if json.loads(line).get("type") != "user":
        continue
    subprocess.Popen([sys.executable, "-c", """
import os
import time
open("holder-ready", "w").close()
deadline = time.monotonic() + 45
while not os.path.exists("allow-holder-exit") and time.monotonic() < deadline:
    time.sleep(0.01)
open("holder-exited", "w").close()
"""], start_new_session=True)
    while True:
        time.sleep(1)
"##;

struct HolderExit(PathBuf);
impl Drop for HolderExit {
    fn drop(&mut self) {
        let _ = fs::write(&self.0, b"exit");
    }
}

fn host_identity() -> HostIdentity {
    HostIdentity {
        host_id: "host-runtime-reliability-test".into(),
        host_epoch: "epoch-runtime-reliability-test".into(),
    }
}

fn identity() -> ExecutionIdentity {
    ExecutionIdentity {
        task_id: "task-runtime-reliability-host".into(),
        dispatch_id: Some("dispatch-runtime-reliability-host".into()),
        attempt_id: "attempt-runtime-reliability-host".into(),
        execution_epoch: 1,
        host: Some(host_identity()),
        config_digest: "a".repeat(64),
    }
}

fn command(kind: HostCommandKind, name: &str, payload: String) -> HostCommand {
    let mut command = HostCommand {
        command_id: format!("command-runtime-{name}"),
        operation_id: format!("operation-runtime-{name}"),
        identity: identity(),
        kind,
        fingerprint: String::new(),
        payload,
    };
    command.fingerprint = host_command_fingerprint(&command).unwrap();
    command
}

fn start_command(workspace: &str) -> HostCommand {
    let session = CreateAgentSession {
        agent: AgentKind::Claude,
        title: "runtime reliability Host fixture".into(),
        workspace: workspace.into(),
        auto_approve: false,
        mode: None,
        model: None,
        effort: None,
        agent_preset: None,
        account_id: None,
        resume: None,
    };
    command(
        HostCommandKind::Start,
        "start",
        serde_json::json!({"session": session, "prompt": "wait for one permission reply"})
            .to_string(),
    )
}

struct Cleanup {
    data_dir: PathBuf,
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        let directory = self
            .data_dir
            .join("execution-hosts")
            .join(host_identity().host_id)
            .join(host_identity().host_epoch);
        let Ok(bytes) = fs::read(directory.join("manifest.json")) else {
            return;
        };
        let Ok(manifest) = serde_json::from_slice::<HostManifest>(&bytes) else {
            return;
        };
        let Ok(token) = fs::read_to_string(directory.join("token")) else {
            return;
        };
        if let Ok(mut stream) = std::os::unix::net::UnixStream::connect(&manifest.socket_path) {
            let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
            let request = HostRequest::Shutdown {
                token,
                acknowledged_sequence: None,
            };
            if let Ok(mut bytes) = serde_json::to_vec(&request) {
                bytes.push(b'\n');
                let _ = stream.write_all(&bytes);
            }
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while manifest.socket_path.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(25));
        }
    }
}

#[tokio::test]
async fn daemon_child_connects_and_holds_client_until_killed() {
    let Some(data_dir) = std::env::var_os("PROSPERO_W09_DAEMON_CHILD") else {
        return;
    };
    let workspace = std::env::var("PROSPERO_W09_WORKSPACE").unwrap();
    let handle = ensure_host(
        Path::new(&data_dir),
        Path::new(env!("CARGO_BIN_EXE_prospero-execution-host")),
        host_identity(),
    )
    .await
    .unwrap();
    let mut terminate =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).unwrap();
    let client = handle.client().unwrap();
    client.command(start_command(&workspace)).await.unwrap();
    println!("DAEMON_COMMAND_ACCEPTED");
    std::io::stdout().flush().unwrap();
    terminate.recv().await;
}

#[tokio::test]
async fn host_survives_daemon_child_exit_and_preserves_pending_interaction() {
    let temporary = TempDir::new().unwrap();
    let data_dir = temporary.path().join("daemon-home");
    fs::create_dir(&data_dir).unwrap();
    fs::set_permissions(&data_dir, fs::Permissions::from_mode(0o700)).unwrap();
    let _cleanup = Cleanup {
        data_dir: data_dir.clone(),
    };
    let workspace = temporary.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    let fake_claude = temporary.path().join("fake-claude.py");
    fs::write(&fake_claude, FAKE_CLAUDE).unwrap();
    fs::set_permissions(&fake_claude, fs::Permissions::from_mode(0o700)).unwrap();
    let mut daemon = start_test_daemon(&data_dir, &workspace, &fake_claude).await;
    let first = HostHandle::open(&data_dir, &host_identity()).unwrap();
    let client = first.client().unwrap();
    let initial = wait_for_interaction(&client, false).await;
    assert!(
        initial
            .events
            .iter()
            .any(|event| event.payload.contains("approval-42"))
    );
    assert!(!workspace.join("approval.log").exists());
    daemon.kill().await.unwrap();
    daemon.wait().await.unwrap();
    sleep(Duration::from_millis(150)).await;
    assert!(!workspace.join("approval.log").exists());
    let reconnected = ensure_host(
        &data_dir,
        Path::new(env!("CARGO_BIN_EXE_prospero-execution-host")),
        host_identity(),
    )
    .await
    .unwrap();
    assert_eq!(first.manifest.pid, reconnected.manifest.pid);
    let client = reconnected.client().unwrap();
    assert!(matches!(
        client.health().await.unwrap(),
        HostResponse::Health { ready: true, .. }
    ));
    let mut graceful = start_test_daemon(&data_dir, &workspace, &fake_claude).await;
    let graceful_pid = graceful.id().unwrap();
    assert_eq!(unsafe { libc::kill(graceful_pid as i32, libc::SIGTERM) }, 0);
    assert!(
        timeout(Duration::from_secs(5), graceful.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
    assert!(!workspace.join("approval.log").exists());
    assert!(client.health().await.is_ok());
    assert!(client.shutdown_when_drained(0).await.is_err());
    assert!(client.health().await.is_ok());
    let start = start_command(workspace.to_str().unwrap());
    wait_for_command(&client, &start.command_id, HostCommandState::Completed).await;
    assert_eq!(
        client.command(start.clone()).await.unwrap().state,
        HostCommandState::Completed
    );
    assert_eq!(
        fs::read_to_string(workspace.join("starts.log"))
            .unwrap()
            .lines()
            .count(),
        1
    );
    let mut forged = start.clone();
    forged.fingerprint = "f".repeat(64);
    assert!(client.command(forged).await.is_err());
    let mut conflict = start;
    conflict.payload.push(' ');
    conflict.fingerprint = host_command_fingerprint(&conflict).unwrap();
    assert!(client.command(conflict).await.is_err());
    let mut stale = command(HostCommandKind::Snapshot, "stale", "{}".into());
    stale.identity.dispatch_id = Some("other-dispatch".into());
    stale.fingerprint = host_command_fingerprint(&stale).unwrap();
    assert!(client.command(stale).await.is_err());
    let result_payload = serde_json::json!({"submissionId":"offline-result", "summary":"original offline evidence", "metadata":{"accepted":false}}).to_string();
    let result = command(HostCommandKind::Result, "result", result_payload.clone());
    client.command(result.clone()).await.unwrap();
    wait_for_event_kind(&client, "delivery_received_offline").await;
    let detail = client.command_detail(&result.command_id).await.unwrap();
    assert_eq!(detail.command.payload, result_payload);
    assert_eq!(detail.receipt.state, HostCommandState::Received);
    assert_eq!(detail.receipt.effect_state, ControlEffectState::Received);
    assert!(!workspace.join("approval.log").exists());
    let reply = InteractionReply {
        operation_id: "operation-runtime-reply".into(),
        command_id: "command-runtime-reply".into(),
        identity: identity(),
        request_id: "approval-42".into(),
        allow: Some(false),
        answers: Vec::new(),
        cancelled: false,
    };
    client.interaction_reply(reply.clone()).await.unwrap();
    let response = wait_for_command(&client, &reply.command_id, HostCommandState::Completed).await;
    assert_eq!(response.effect_state, ControlEffectState::Delivered);
    wait_for_interaction(&client, true).await;
    timeout(Duration::from_secs(5), async {
        while !workspace.join("approval.log").exists() {
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let answer = fs::read_to_string(workspace.join("approval.log")).unwrap();
    assert!(answer.contains("approval-42") && answer.contains("deny"));
    let stop = command(HostCommandKind::Stop, "stop", "{}".into());
    client.command(stop.clone()).await.unwrap();
    let stopped = wait_for_command(&client, &stop.command_id, HostCommandState::Completed).await;
    let proof: VerifiedExitProof =
        serde_json::from_str(stopped.receipt.as_deref().unwrap()).unwrap();
    assert_eq!(proof.attempt_id, identity().attempt_id);
    assert_eq!(proof.host, identity().host);
    wait_for_event_kind(&client, "exit_confirmed").await;
    assert_eq!(
        client.command(stop).await.unwrap().state,
        HostCommandState::Completed
    );
    client.shutdown().await.unwrap();
    timeout(Duration::from_secs(10), async {
        while reconnected.manifest.socket_path.exists() {
            sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn same_stop_query_confirms_later_output_exit_once() {
    let temporary = TempDir::new().unwrap();
    let data_dir = temporary.path().join("daemon-home");
    fs::create_dir(&data_dir).unwrap();
    fs::set_permissions(&data_dir, fs::Permissions::from_mode(0o700)).unwrap();
    let _cleanup = Cleanup {
        data_dir: data_dir.clone(),
    };
    let workspace = temporary.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    let _holder_exit = HolderExit(workspace.join("allow-holder-exit"));
    let fake = temporary.path().join("delayed-claude.py");
    fs::write(&fake, DELAYED_OUTPUT_CLAUDE).unwrap();
    fs::set_permissions(&fake, fs::Permissions::from_mode(0o700)).unwrap();
    let mut daemon = start_test_daemon(&data_dir, &workspace, &fake).await;
    let handle = HostHandle::open(&data_dir, &host_identity()).unwrap();
    let client = handle.client().unwrap();
    let start = start_command(workspace.to_str().unwrap());
    wait_for_command(&client, &start.command_id, HostCommandState::Completed).await;
    timeout(Duration::from_secs(10), async {
        while !workspace.join("holder-ready").exists() {
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let stop = command(
        HostCommandKind::Stop,
        "later-stop",
        "{\"stopGeneration\":1}".into(),
    );
    client.command(stop.clone()).await.unwrap();
    wait_for_event_kind(&client, "command_outcome_unknown").await;
    assert_eq!(
        client.command(stop.clone()).await.unwrap().state,
        HostCommandState::Unknown
    );
    let unresolved = client.events(0, 1000).await.unwrap();
    assert!(
        !unresolved
            .events
            .iter()
            .any(|event| event.kind == "exit_confirmed")
    );
    fs::write(workspace.join("allow-holder-exit"), b"exit").unwrap();
    timeout(Duration::from_secs(5), async {
        while !workspace.join("holder-exited").exists() {
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let (first, second) = tokio::join!(
        client.command_detail(&stop.command_id),
        client.command_detail(&stop.command_id)
    );
    let first = first.unwrap();
    let second = second.unwrap();
    assert!(
        first.receipt.state == HostCommandState::Completed
            || second.receipt.state == HostCommandState::Completed,
        "first={:?}, second={:?}",
        first.receipt,
        second.receipt,
    );
    let receipt = wait_for_command(&client, &stop.command_id, HostCommandState::Completed).await;
    let proof: VerifiedExitProof =
        serde_json::from_str(receipt.receipt.as_deref().unwrap()).unwrap();
    assert_eq!(proof.attempt_id, identity().attempt_id);
    assert_eq!(proof.host, identity().host);
    assert_eq!(
        client.command(stop.clone()).await.unwrap().receipt,
        receipt.receipt
    );
    let next_stop = command(
        HostCommandKind::Stop,
        "later-second-stop",
        "{\"stopGeneration\":2}".into(),
    );
    client.command(next_stop.clone()).await.unwrap();
    let next_receipt =
        wait_for_command(&client, &next_stop.command_id, HostCommandState::Completed).await;
    assert_eq!(next_receipt.receipt, receipt.receipt);
    let late_send = command(
        HostCommandKind::Send,
        "late-message",
        "{\"text\":\"must remain stopped\"}".into(),
    );
    assert!(client.command(late_send).await.is_err());
    let events = client.events(0, 1000).await.unwrap();
    assert_eq!(
        events
            .events
            .iter()
            .filter(|event| event.kind == "exit_confirmed")
            .count(),
        1
    );
    let detail = client.command_detail(&stop.command_id).await.unwrap();
    assert_eq!(detail.command.command_id, stop.command_id);
    assert_eq!(detail.receipt.receipt, receipt.receipt);
    daemon.kill().await.unwrap();
    daemon.wait().await.unwrap();
    client.shutdown().await.unwrap();
}

async fn start_test_daemon(
    data_dir: &Path,
    workspace: &Path,
    fake_claude: &Path,
) -> tokio::process::Child {
    let mut daemon = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "daemon_child_connects_and_holds_client_until_killed",
            "--nocapture",
        ])
        .env("PROSPERO_W09_DAEMON_CHILD", data_dir)
        .env("PROSPERO_W09_WORKSPACE", workspace)
        .env("PROSPERO_CLAUDE_BIN", fake_claude)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(daemon.stdout.take().unwrap()).lines();
    timeout(Duration::from_secs(20), async {
        while let Some(line) = lines.next_line().await.unwrap() {
            if line == "DAEMON_COMMAND_ACCEPTED" {
                return;
            }
        }
        panic!("test daemon exited before command acceptance");
    })
    .await
    .unwrap();
    tokio::spawn(async move { while matches!(lines.next_line().await, Ok(Some(_))) {} });
    daemon
}

async fn wait_for_command(
    client: &HostClient,
    id: &str,
    state: HostCommandState,
) -> prosperod_rs::orchestration::reliability::CommandReceipt {
    timeout(Duration::from_secs(15), async {
        loop {
            let detail = client.command_detail(id).await.unwrap();
            if detail.receipt.state == state {
                return detail.receipt;
            }
            assert_ne!(
                detail.receipt.state,
                HostCommandState::Unknown,
                "{}",
                detail.receipt.receipt.unwrap_or_default()
            );
            sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap()
}

async fn wait_for_interaction(client: &HostClient, resolved: bool) -> HostEventPage {
    timeout(Duration::from_secs(15), async {
        loop {
            let page = client.events(0, 1000).await.unwrap();
            if page.events.iter().any(|event| {
                let payload: serde_json::Value = serde_json::from_str(&event.payload).unwrap();
                event.kind == "driver_timeline"
                    && payload["body"]["requestId"] == "approval-42"
                    && payload["body"]["resolved"] == resolved
            }) {
                return page;
            }
            sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap()
}

async fn wait_for_event_kind(client: &HostClient, kind: &str) {
    timeout(Duration::from_secs(10), async {
        loop {
            if client
                .events(0, 1000)
                .await
                .unwrap()
                .events
                .iter()
                .any(|event| event.kind == kind)
            {
                return;
            }
            sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap();
}
