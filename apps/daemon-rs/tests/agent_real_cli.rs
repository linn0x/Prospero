#![cfg(unix)]
//! Real Claude CLI acceptance smoke.
//!
//! Ignored by default so ordinary `cargo test` runs never claim these
//! passed. Run them explicitly on a machine with an authenticated `claude`
//! CLI:
//!
//!     PROSPERO_REAL_CLI=1 cargo test -p prosperod-rs --test agent_real_cli -- --ignored --nocapture
//!
//! PROSPERO_CLAUDE_BIN may point at a non-default CLI binary. Last accepted
//! run: 2026-09-11 against Claude Code 2.1.248 (conversation/resume, manual
//! approval allow+deny, yolo interrupt and close-while-running).

use std::time::Duration;

use prosperod_rs::{
    agent::{Agents, CreateAgentSession},
    protocol::{SessionStatus, TimelineBody, TimelineQuery},
    worker::Database,
};
use tempfile::TempDir;

fn enabled() {
    if std::env::var_os("PROSPERO_REAL_CLI").is_none() {
        panic!("set PROSPERO_REAL_CLI=1 to run the real Claude CLI smoke");
    }
}

struct Harness {
    _data: TempDir,
    workspace: TempDir,
    database: Database,
    agents: Agents,
    id: String,
}

impl Harness {
    async fn new(auto_approve: bool) -> Self {
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        let database = Database::open(data.path().to_path_buf()).await.unwrap();
        let agents = Agents::new(database.clone());
        let head = agents
            .create(CreateAgentSession {
                agent: prosperod_rs::protocol::AgentKind::Claude,
                title: "Real CLI acceptance".into(),
                workspace: workspace.path().to_str().unwrap().into(),
                auto_approve,
                mode: None,
                model: None,
                effort: None,
                agent_preset: None,
                account_id: None,
                resume: None,
            })
            .await
            .unwrap();
        Self {
            _data: data,
            workspace,
            database,
            agents,
            id: head.id,
        }
    }

    async fn send(&self, text: &str) {
        self.agents
            .send(&self.id, text.into(), None, Vec::new())
            .await
            .unwrap();
    }

    async fn records(&self) -> Vec<(TimelineBody, String)> {
        let id = self.id.clone();
        self.database
            .call(move |store| {
                let page = store.timeline(
                    &id,
                    TimelineQuery {
                        before: None,
                        after: None,
                        limit: Some(100),
                    },
                )?;
                Ok(page
                    .items
                    .into_iter()
                    .map(|record| (record.body, record.preview))
                    .collect::<Vec<_>>())
            })
            .await
            .unwrap()
    }

    async fn status(&self) -> SessionStatus {
        let id = self.id.clone();
        self.database
            .call(move |store| Ok(store.session(&id)?.status))
            .await
            .unwrap()
    }

    async fn wait_records(
        &self,
        timeout: Duration,
        predicate: impl Fn(&[(TimelineBody, String)]) -> bool,
    ) -> Vec<(TimelineBody, String)> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let records = self.records().await;
            if predicate(&records) {
                return records;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "predicate timed out"
            );
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    async fn wait_finish(&self, finish: &str) {
        self.wait_records(Duration::from_secs(120), |records| {
            records.iter().any(|(body, _)| {
                matches!(
                    body,
                    TimelineBody::TurnEnd { finish: actual, .. } if actual == finish
                )
            })
        })
        .await;
    }

    fn pending_permission(records: &[(TimelineBody, String)]) -> Option<String> {
        records.iter().find_map(|(body, _)| match body {
            TimelineBody::PermissionRequest {
                request_id,
                resolved: false,
                ..
            } => Some(request_id.clone()),
            _ => None,
        })
    }
}

#[tokio::test]
#[ignore = "requires a real authenticated Claude CLI; opt in with PROSPERO_REAL_CLI=1 -- --ignored"]
async fn real_claude_two_turn_resume() {
    enabled();
    let harness = Harness::new(false).await;
    harness
        .send("Reply with exactly the token SMOKE-OK and nothing else.")
        .await;
    harness.wait_finish("completed").await;
    let answer = harness
        .records()
        .await
        .iter()
        .find_map(|(body, preview)| match body {
            TimelineBody::Message { role, .. }
                if *role == prosperod_rs::protocol::MessageRole::Assistant
                    && preview.contains("SMOKE-OK") =>
            {
                Some(preview.clone())
            }
            _ => None,
        })
        .expect("first turn answer should contain SMOKE-OK");
    eprintln!("turn 1 answer: {answer:?}");

    // The CLI can only recall the token inside the same native conversation,
    // proving --resume carried the native session id.
    harness
        .send(
            "What token did I ask you to reply with in the previous message? Answer with only that token.",
        )
        .await;
    harness.wait_finish("completed").await;
    let resumed = harness.records().await.iter().any(|(body, preview)| {
        matches!(
            body,
            TimelineBody::Message { role, .. } if *role == prosperod_rs::protocol::MessageRole::Assistant
        ) && preview.contains("SMOKE-OK")
    });
    assert!(resumed, "second turn must recall SMOKE-OK via resume");
    eprintln!("real CLI: two turns completed, resume verified");
    harness.database.shutdown().await.unwrap();
}

#[tokio::test]
#[ignore = "requires a real authenticated Claude CLI; opt in with PROSPERO_REAL_CLI=1 -- --ignored"]
async fn real_claude_manual_approval_runs_tool() {
    enabled();
    let harness = Harness::new(false).await;
    std::fs::write(harness.workspace.path().join("prospero-gate.txt"), b"gate").unwrap();
    harness
        .send(
            "Run this exact shell command in the workspace, do not ask for clarification: rm -f prospero-gate.txt",
        )
        .await;
    let records = harness
        .wait_records(Duration::from_secs(60), |records| {
            Harness::pending_permission(records).is_some()
        })
        .await;
    let request_id = Harness::pending_permission(&records).unwrap();
    assert_eq!(harness.status().await, SessionStatus::WaitingPermission);
    harness
        .agents
        .respond_permission(&harness.id, &request_id, true)
        .await
        .unwrap();
    let records = harness
        .wait_records(Duration::from_secs(120), |records| {
            records.iter().any(|(body, _)| {
                matches!(
                    body,
                    TimelineBody::TurnEnd { finish, .. } if finish == "completed"
                )
            })
        })
        .await;
    assert!(
        records.iter().any(|(body, _)| matches!(
            body,
            TimelineBody::PermissionRequest { resolved, tool, .. } if *resolved && tool == "Bash"
        )),
        "approval should be resolved for Bash"
    );
    assert!(
        records.iter().any(|(body, _)| matches!(
            body,
            TimelineBody::Tool { state, .. } if *state == prosperod_rs::protocol::ToolState::Success
        )),
        "allowed Bash tool should succeed"
    );
    assert!(
        !harness.workspace.path().join("prospero-gate.txt").exists(),
        "allowed rm must delete the marker file"
    );
    eprintln!("real CLI: manual allow executed the Bash tool");
    harness.database.shutdown().await.unwrap();
}

#[tokio::test]
#[ignore = "requires a real authenticated Claude CLI; opt in with PROSPERO_REAL_CLI=1 -- --ignored"]
async fn real_claude_denied_approval_fails_tool() {
    enabled();
    let harness = Harness::new(false).await;
    std::fs::write(harness.workspace.path().join("prospero-gate.txt"), b"gate").unwrap();
    harness
        .send(
            "Run this exact shell command in the workspace, do not ask for clarification: rm -f prospero-gate.txt",
        )
        .await;
    // A deny is a legitimate answer, but the model may then try follow-up
    // commands; reject every request until the turn ends.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
    let mut denied = 0;
    loop {
        let records = harness.records().await;
        if records.iter().any(|(body, _)| {
            matches!(
                body,
                TimelineBody::TurnEnd { finish, .. } if finish == "completed"
            )
        }) {
            break;
        }
        if let Some(request_id) = Harness::pending_permission(&records) {
            harness
                .agents
                .respond_permission(&harness.id, &request_id, false)
                .await
                .unwrap();
            denied += 1;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "turn did not finish after denies"
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    assert!(denied >= 1, "at least one approval should have been denied");
    let records = harness.records().await;
    assert!(
        records.iter().any(|(body, _)| matches!(
            body,
            TimelineBody::Tool { state, .. } if *state == prosperod_rs::protocol::ToolState::Failed
        )),
        "denied Bash tool should be recorded as failed"
    );
    assert!(
        harness.workspace.path().join("prospero-gate.txt").exists(),
        "denied rm must leave the marker file in place"
    );
    eprintln!("real CLI: denied {denied} approval request(s), tool failed");
    harness.database.shutdown().await.unwrap();
}

#[tokio::test]
#[ignore = "requires a real authenticated Claude CLI; opt in with PROSPERO_REAL_CLI=1 -- --ignored"]
async fn real_claude_interrupt_aborts_running_tool() {
    enabled();
    let harness = Harness::new(true).await;
    harness
        .send("Run this exact shell command in the workspace: sleep 30")
        .await;
    // yolo auto-approves, so the Bash tool starts executing; interrupt then.
    harness
        .wait_records(Duration::from_secs(60), |records| {
            records.iter().any(|(body, _)| matches!(
                body,
                TimelineBody::Tool { state, .. } if *state == prosperod_rs::protocol::ToolState::Running
            ))
        })
        .await;
    harness.agents.interrupt(&harness.id).await.unwrap();
    harness.wait_finish("interrupted").await;
    assert_eq!(harness.status().await, SessionStatus::Idle);
    eprintln!("real CLI: interrupt aborted the running tool");
    harness.database.shutdown().await.unwrap();
}

#[tokio::test]
#[ignore = "requires a real authenticated Claude CLI; opt in with PROSPERO_REAL_CLI=1 -- --ignored"]
async fn real_claude_close_archives_running_turn() {
    enabled();
    let harness = Harness::new(true).await;
    harness
        .send("Run this exact shell command in the workspace: sleep 30")
        .await;
    harness
        .wait_records(Duration::from_secs(60), |records| {
            records.iter().any(|(body, _)| matches!(
                body,
                TimelineBody::Tool { state, .. } if *state == prosperod_rs::protocol::ToolState::Running
            ))
        })
        .await;
    harness.agents.close(&harness.id).await.unwrap();
    let id = harness.id.clone();
    let head = harness
        .database
        .call(move |store| store.session(&id))
        .await
        .unwrap();
    assert_eq!(
        head.lifecycle,
        prosperod_rs::protocol::SessionLifecycle::Archived
    );
    eprintln!("real CLI: close killed the process and archived the session");
    harness.database.shutdown().await.unwrap();
}
