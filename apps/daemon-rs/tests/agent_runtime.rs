#![cfg(unix)]
//! Agent runtime tests use a tiny fake `claude` CLI (Python) speaking the
//! headless stream-json protocol. Scenario is selected by a `scenario` file
//! in the turn workspace so the process-global PROSPERO_CLAUDE_BIN variable
//! can point at one shared script.

use std::time::Duration;

use prosperod_rs::{
    agent::{Agents, CreateAgentSession, PermissionMode},
    protocol::{TimelineBody, TimelineQuery},
    worker::Database,
};
use tempfile::TempDir;

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

const FAKE_CLI: &str = r#"#!/usr/bin/env python3
import json, os, sys, time

cwd = os.getcwd()
scenario = open(os.path.join(cwd, "scenario")).read().strip()
resume = None
for arg in sys.argv[1:]:
    if arg.startswith("--resume="):
        resume = arg.split("=", 1)[1]

def emit(payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()

emit({"type": "system", "subtype": "init", "session_id": "native-1"})
line = sys.stdin.readline()
with open(os.path.join(cwd, "turns.log"), "a") as log:
    log.write(("resume=" + str(resume)) + "\n")

def text_block(text):
    emit({"type": "stream_event", "event": {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}})
    emit({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text}}})
    emit({"type": "stream_event", "event": {"type": "content_block_stop", "index": 0}})

def result(error=None, reason=None):
    payload = {"type": "result", "subtype": "success", "is_error": bool(error)}
    if error:
        payload["errors"] = [error]
    if reason:
        payload["terminal_reason"] = reason
    emit(payload)
    sys.stdout.flush()
    time.sleep(0.2)

if scenario == "chat":
    text_block("hello from fake claude")
    result()
elif scenario == "resume":
    text_block("second turn" if resume else "first turn")
    result()
elif scenario == "approval":
    emit({"type": "assistant", "message": {"role": "assistant", "content": [
        {"type": "tool_use", "id": "call_1", "name": "Bash", "input": {"command": "rm -rf /"}}]}})
    emit({"type": "control_request", "request_id": "req-1",
          "request": {"subtype": "can_use_tool", "tool_name": "Bash",
                      "input": {"command": "rm -rf /"}}})
    answer = sys.stdin.readline()
    allowed = '"allow"' in answer
    emit({"type": "user", "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "call_1",
         "is_error": not allowed,
         "content": "removed" if allowed else "denied by user"}]}})
    result()
elif scenario == "interrupt":
    emit({"type": "assistant", "message": {"role": "assistant", "content": [
        {"type": "tool_use", "id": "call_1", "name": "Bash", "input": {"command": "sleep"}}]}})
    emit({"type": "control_request", "request_id": "req-9",
          "request": {"subtype": "can_use_tool", "tool_name": "Bash",
                      "input": {"command": "sleep"}}})
    while True:
        frame = sys.stdin.readline()
        if not frame:
            break
        if '"interrupt"' in frame:
            result(reason="aborted_streaming")
            break
elif scenario == "failure":
    result(error="boom")
elif scenario == "planflag":
    with open(os.path.join(cwd, "args.log"), "w") as log:
        log.write("\n".join(sys.argv[1:]))
    text_block("planned")
    result()
elif scenario == "hang":
    with open(os.path.join(cwd, "fake.pid"), "w") as pid:
        pid.write(str(os.getpid()))
    time.sleep(30)
else:
    result(error="unknown scenario")
"#;

struct Harness {
    _data: TempDir,
    workspace: TempDir,
    database: Database,
    agents: Agents,
}

impl Harness {
    async fn new(scenario: &str) -> Self {
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        std::fs::write(workspace.path().join("scenario"), scenario).unwrap();
        let cli = data.path().join("fake-claude.py");
        std::fs::write(&cli, FAKE_CLI).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        unsafe {
            std::env::set_var("PROSPERO_CLAUDE_BIN", &cli);
        }
        let database = Database::open(data.path().to_path_buf()).await.unwrap();
        let agents = Agents::new(database.clone());
        Self {
            _data: data,
            workspace,
            database,
            agents,
        }
    }

    async fn create(&self) -> prosperod_rs::protocol::SessionHead {
        self.agents
            .create(CreateAgentSession {
                title: "Agent test".into(),
                workspace: self.workspace.path().to_str().unwrap().into(),
                auto_approve: false,
            })
            .await
            .unwrap()
    }

    async fn records(&self, id: &str) -> Vec<(String, TimelineBody, String)> {
        let id = id.to_owned();
        self.database
            .call(move |store| {
                let page = store.timeline(&id, TimelineQuery::default())?;
                Ok(page
                    .items
                    .into_iter()
                    .map(|record| (record.id, record.body, record.preview))
                    .collect::<Vec<_>>())
            })
            .await
            .unwrap()
    }

    async fn status(&self, id: &str) -> prosperod_rs::protocol::SessionStatus {
        let id = id.to_owned();
        self.database
            .call(move |store| Ok(store.session(&id)?.status))
            .await
            .unwrap()
    }

    async fn wait_for(
        &self,
        id: &str,
        predicate: impl Fn(&[(String, TimelineBody, String)]) -> bool,
    ) -> Vec<(String, TimelineBody, String)> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let records = self.records(id).await;
            if predicate(&records) {
                return records;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "timeline predicate timed out"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        unsafe {
            std::env::remove_var("PROSPERO_CLAUDE_BIN");
        }
    }
}

#[tokio::test]
async fn single_turn_streams_into_timeline() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new("chat").await;
    let head = harness.create().await;
    harness.agents.send(&head.id, "hi".into()).await.unwrap();

    let records = harness
        .wait_for(&head.id, |records| {
            records.iter().any(|(_, body, _)| {
                matches!(
                    body,
                    TimelineBody::TurnEnd { finish } if finish == "completed"
                )
            })
        })
        .await;
    assert!(records.iter().any(|(id, body, _)| matches!(
        body,
        TimelineBody::Message {
            role: prosperod_rs::protocol::MessageRole::User,
            ..
        }
    ) && id.ends_with("-user")));
    assert!(records.iter().any(|(_, body, preview)| matches!(
        body,
        TimelineBody::Message {
            role: prosperod_rs::protocol::MessageRole::Assistant,
            ..
        }
    ) && preview == "hello from fake claude"));
    assert_eq!(
        harness.status(&head.id).await,
        prosperod_rs::protocol::SessionStatus::Idle
    );
}

#[tokio::test]
async fn multi_turn_resumes_native_session() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new("resume").await;
    let head = harness.create().await;
    harness.agents.send(&head.id, "one".into()).await.unwrap();
    harness
        .wait_for(&head.id, |records| {
            records.iter().any(|(_, body, _)| {
                matches!(
                    body,
                    TimelineBody::TurnEnd { finish } if finish == "completed"
                )
            })
        })
        .await;
    harness.agents.send(&head.id, "two".into()).await.unwrap();
    harness
        .wait_for(&head.id, |records| {
            records
                .iter()
                .filter(|(_, body, _)| matches!(body, TimelineBody::TurnEnd { .. }))
                .count()
                == 2
        })
        .await;
    assert!(
        harness
            .records(&head.id)
            .await
            .iter()
            .any(|(_, body, preview)| matches!(
                body,
                TimelineBody::Message {
                    role: prosperod_rs::protocol::MessageRole::Assistant,
                    ..
                }
            ) && preview == "second turn")
    );
    let log = std::fs::read_to_string(harness.workspace.path().join("turns.log")).unwrap();
    let turns: Vec<&str> = log.lines().collect();
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[0], "resume=None");
    assert_eq!(turns[1], "resume=native-1");
}

#[tokio::test]
async fn permission_roundtrip_executes_tool() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new("approval").await;
    let head = harness.create().await;
    harness.agents.send(&head.id, "go".into()).await.unwrap();

    let records = harness
        .wait_for(&head.id, |records| {
            records.iter().any(|(_, body, _)| {
                matches!(
                    body,
                    TimelineBody::PermissionRequest { resolved, .. } if !resolved
                )
            })
        })
        .await;
    let request_id = records
        .iter()
        .find_map(|(_, body, _)| match body {
            TimelineBody::PermissionRequest {
                request_id,
                resolved: false,
                ..
            } => Some(request_id.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(
        harness.status(&head.id).await,
        prosperod_rs::protocol::SessionStatus::WaitingPermission
    );
    harness
        .agents
        .respond_permission(&head.id, &request_id, true)
        .await
        .unwrap();

    let records = harness
        .wait_for(&head.id, |records| {
            records.iter().any(|(_, body, _)| {
                matches!(
                    body,
                    TimelineBody::TurnEnd { finish } if finish == "completed"
                )
            })
        })
        .await;
    assert!(records.iter().any(|(_, body, _)| matches!(
        body,
        TimelineBody::PermissionRequest { resolved, tool, .. } if *resolved && tool == "Bash"
    )));
    assert!(records.iter().any(|(_, body, preview)| matches!(
        body,
        TimelineBody::Tool {
            state: prosperod_rs::protocol::ToolState::Success,
            ..
        }
    ) && preview == "removed"));
}

#[tokio::test]
async fn interrupt_rejects_permission_and_marks_turn_interrupted() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new("interrupt").await;
    let head = harness.create().await;
    harness.agents.send(&head.id, "go".into()).await.unwrap();
    harness
        .wait_for(&head.id, |records| {
            records.iter().any(|(_, body, _)| {
                matches!(
                    body,
                    TimelineBody::PermissionRequest {
                        resolved: false,
                        ..
                    }
                )
            })
        })
        .await;
    harness.agents.interrupt(&head.id).await.unwrap();
    let records = harness
        .wait_for(&head.id, |records| {
            records.iter().any(|(_, body, _)| {
                matches!(
                    body,
                    TimelineBody::TurnEnd { finish } if finish == "interrupted"
                )
            })
        })
        .await;
    assert!(records.iter().any(|(_, body, _)| matches!(
        body,
        TimelineBody::PermissionRequest { resolved: true, .. }
    )));
    assert_eq!(
        harness.status(&head.id).await,
        prosperod_rs::protocol::SessionStatus::Idle
    );
}

#[tokio::test]
async fn provider_failure_marks_turn_and_session_failed() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new("failure").await;
    let head = harness.create().await;
    harness.agents.send(&head.id, "go".into()).await.unwrap();
    let records = harness
        .wait_for(&head.id, |records| {
            records.iter().any(|(_, body, _)| {
                matches!(
                    body,
                    TimelineBody::TurnEnd { finish } if finish == "failed"
                )
            })
        })
        .await;
    assert!(
        records
            .iter()
            .any(|(_, body, preview)| matches!(body, TimelineBody::Error) && preview == "boom")
    );
    assert_eq!(
        harness.status(&head.id).await,
        prosperod_rs::protocol::SessionStatus::Failed
    );
}

#[tokio::test]
async fn recovery_archives_active_run_without_replaying_turn() {
    let _guard = SERIAL.lock().await;
    let data = TempDir::new().unwrap();
    let workspace = TempDir::new().unwrap();
    std::fs::write(workspace.path().join("scenario"), "hang").unwrap();
    let cli = data.path().join("fake-claude.py");
    std::fs::write(&cli, FAKE_CLI).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    unsafe {
        std::env::set_var("PROSPERO_CLAUDE_BIN", &cli);
    }
    let database = Database::open(data.path().to_path_buf()).await.unwrap();
    let agents = Agents::new(database.clone());
    let head = agents
        .create(CreateAgentSession {
            title: "Recovery".into(),
            workspace: workspace.path().to_str().unwrap().into(),
            auto_approve: false,
        })
        .await
        .unwrap();
    agents.send(&head.id, "go".into()).await.unwrap();
    let pid_path = workspace.path().join("fake.pid");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while !pid_path.exists() {
        assert!(tokio::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    // Daemon shuts down (SIGKILL to the process group) while a turn runs.
    agents.shutdown().await.unwrap();
    database.shutdown().await.unwrap();

    // A fresh daemon recovers: the run must be archived, never replayed.
    let database = Database::open(data.path().to_path_buf()).await.unwrap();
    let agents = Agents::new(database.clone());
    let recovered = agents.recover().await.unwrap();
    assert_eq!(recovered, 1);
    let id = head.id.clone();
    let stored = database
        .call(move |store| store.session(&id))
        .await
        .unwrap();
    assert_eq!(
        stored.lifecycle,
        prosperod_rs::protocol::SessionLifecycle::Archived
    );
    assert_eq!(stored.status, prosperod_rs::protocol::SessionStatus::Failed);
    let log = std::fs::read_to_string(workspace.path().join("turns.log")).unwrap();
    assert_eq!(log.lines().count(), 1);
    unsafe {
        std::env::remove_var("PROSPERO_CLAUDE_BIN");
    }
}

#[tokio::test]
async fn plan_mode_is_persisted_and_passed_to_the_cli() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new("planflag").await;
    let head = harness.create().await;

    // The catalog starts on default; switching to plan persists immediately.
    assert_eq!(
        harness.agents.mode(&head.id).await.unwrap(),
        PermissionMode::Default
    );
    harness
        .agents
        .set_mode(&head.id, PermissionMode::Plan)
        .await
        .unwrap();
    assert_eq!(
        harness.agents.mode(&head.id).await.unwrap(),
        PermissionMode::Plan
    );
    harness
        .agents
        .send(&head.id, "plan this".into())
        .await
        .unwrap();
    harness
        .wait_for(&head.id, |records| {
            records.iter().any(|(_, body, _)| {
                matches!(
                    body,
                    TimelineBody::TurnEnd { finish } if finish == "completed"
                )
            })
        })
        .await;
    let planned_args = std::fs::read_to_string(harness.workspace.path().join("args.log")).unwrap();
    let planned: Vec<&str> = planned_args.lines().collect();
    assert!(
        planned
            .windows(2)
            .any(|pair| pair == ["--permission-mode", "plan"]),
        "plan turn must carry --permission-mode plan: {planned:?}"
    );

    // Back to default: the next resumed turn must not carry the flag.
    harness
        .agents
        .set_mode(&head.id, PermissionMode::Default)
        .await
        .unwrap();
    harness
        .agents
        .send(&head.id, "now do it".into())
        .await
        .unwrap();
    harness
        .wait_for(&head.id, |records| {
            records
                .iter()
                .filter(|(_, body, _)| matches!(body, TimelineBody::TurnEnd { .. }))
                .count()
                == 2
        })
        .await;
    let default_args = std::fs::read_to_string(harness.workspace.path().join("args.log")).unwrap();
    assert!(
        !default_args.contains("--permission-mode"),
        "default turn must not carry a permission-mode flag: {default_args:?}"
    );
}
