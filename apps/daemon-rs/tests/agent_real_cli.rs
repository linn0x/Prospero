#![cfg(unix)]
//! Real Claude CLI acceptance smoke.
//!
//! Ignored by default so ordinary `cargo test` runs never claim it passed.
//! Run it explicitly on a machine with an authenticated `claude` CLI:
//!
//!     PROSPERO_REAL_CLI=1 cargo test -p prosperod-rs --test agent_real_cli -- --ignored --nocapture
//!
//! PROSPERO_CLAUDE_BIN may point at a non-default CLI binary.

use std::time::Duration;

use prosperod_rs::{
    agent::{Agents, CreateAgentSession},
    protocol::TimelineBody,
    worker::Database,
};
use tempfile::TempDir;

#[tokio::test]
#[ignore = "requires a real authenticated Claude CLI; opt in with PROSPERO_REAL_CLI=1 -- --ignored"]
async fn real_claude_two_turn_smoke() {
    if std::env::var_os("PROSPERO_REAL_CLI").is_none() {
        panic!("set PROSPERO_REAL_CLI=1 to run the real Claude CLI smoke");
    }
    let data = TempDir::new().unwrap();
    let workspace = TempDir::new().unwrap();
    let database = Database::open(data.path().to_path_buf()).await.unwrap();
    let agents = Agents::new(database.clone());
    let head = agents
        .create(CreateAgentSession {
            title: "Real CLI smoke".into(),
            workspace: workspace.path().to_str().unwrap().into(),
            auto_approve: false,
        })
        .await
        .unwrap();

    agents
        .send(
            &head.id,
            "Reply with exactly the token SMOKE-OK and nothing else.".into(),
        )
        .await
        .unwrap();
    wait_finish(&database, &head.id, "completed", Duration::from_secs(120)).await;
    let first = records(&database, &head.id).await;
    let answer = first
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

    // Second turn proves the native session id is resumed: the CLI can only
    // know the previous token inside the same native conversation.
    agents
        .send(
            &head.id,
            "What token did I ask you to reply with in the previous message? Answer with only that token.".into(),
        )
        .await
        .unwrap();
    wait_finish(&database, &head.id, "completed", Duration::from_secs(120)).await;
    let second = records(&database, &head.id).await;
    let resumed = second.iter().any(|(body, preview)| {
        matches!(
            body,
            TimelineBody::Message { role, .. } if *role == prosperod_rs::protocol::MessageRole::Assistant
        ) && preview.contains("SMOKE-OK")
    });
    assert!(
        resumed,
        "second turn must recall SMOKE-OK via the resumed native session"
    );
    eprintln!("real CLI smoke: two turns completed, resume verified");
    database.shutdown().await.unwrap();
}

async fn records(database: &Database, id: &str) -> Vec<(TimelineBody, String)> {
    let id = id.to_owned();
    database
        .call(move |store| {
            let page = store.timeline(
                &id,
                prosperod_rs::protocol::TimelineQuery {
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

async fn wait_finish(database: &Database, id: &str, finish: &str, timeout: Duration) {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if records(database, id).await.iter().any(|(body, _)| {
            matches!(
                body,
                TimelineBody::TurnEnd { finish: actual } if actual == finish
            )
        }) {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for turn_end {finish}"
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}
