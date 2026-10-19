#[path = "runtime_reliability/fake_executor.rs"]
mod fake_executor;

use fake_executor::{
    CommandDisposition, FakeExecutionOutcome, FakeExecutor, FakeFaultProfile, FakeHostIdentity,
};
use serde_json::json;
use std::{fs, time::Duration};
use tempfile::TempDir;
use tokio::sync::{oneshot, watch};
use tokio::time::sleep;

fn identity() -> FakeHostIdentity {
    FakeHostIdentity {
        host_id: "host-test".into(),
        host_epoch: "host-epoch-test".into(),
        task_id: "task-test".into(),
        attempt_id: "attempt-test".into(),
        execution_epoch: 1,
    }
}

#[test]
fn accepted_command_is_replayed_after_fake_host_restart() {
    let directory = TempDir::new().unwrap();
    let mut first = FakeExecutor::open(directory.path(), identity()).unwrap();
    let accepted = first
        .accept(
            "operation-1",
            "command-1",
            json!({"kind":"start","prompt":"x"}),
        )
        .unwrap();
    assert_eq!(accepted.disposition, CommandDisposition::Accepted);

    let mut restarted = FakeExecutor::open(directory.path(), identity()).unwrap();
    let replay = restarted
        .accept(
            "operation-1",
            "command-1",
            json!({"kind":"start","prompt":"x"}),
        )
        .unwrap();
    assert_eq!(replay.disposition, CommandDisposition::Replayed);
    assert_eq!(replay.receipt.command_id, accepted.receipt.command_id);
    assert!(!replay.response_lost);
    assert_eq!(restarted.command_count(), 1);
}

#[test]
fn same_command_id_with_different_payload_conflicts() {
    let directory = TempDir::new().unwrap();
    let mut host = FakeExecutor::open(directory.path(), identity()).unwrap();
    host.accept(
        "operation-1",
        "command-1",
        json!({"kind":"send","text":"one"}),
    )
    .unwrap();

    let error = host
        .accept(
            "operation-1",
            "command-1",
            json!({"kind":"send","text":"two"}),
        )
        .unwrap_err();

    assert_eq!(error.to_string(), "command fingerprint conflict");
    assert_eq!(host.command_count(), 1);
}

#[test]
fn event_sequence_and_execution_identity_survive_replay() {
    let directory = TempDir::new().unwrap();
    let mut first = FakeExecutor::open(directory.path(), identity()).unwrap();
    let event = first.append_event("running", json!({"pid": 123})).unwrap();
    assert_eq!(event.sequence, 1);

    let mut restarted = FakeExecutor::open(directory.path(), identity()).unwrap();
    let next = restarted
        .append_event("stopped", json!({"exitCode": 0}))
        .unwrap();

    assert_eq!(next.sequence, 2);
    assert_eq!(next.identity.execution_epoch, 1);
    assert_eq!(next.identity.attempt_id, "attempt-test");
    assert_eq!(restarted.event_count(), 2);
}

#[tokio::test]
async fn fault_profile_covers_wait_output_child_and_ignored_cancel() {
    let directory = TempDir::new().unwrap();
    let mut host = FakeExecutor::open(directory.path(), identity()).unwrap();
    let profile = FakeFaultProfile {
        start_delay_ms: 5,
        rate_limit_delay_ms: 5,
        ignore_cancellation: true,
        spawn_child_process: true,
        output_pressure_bytes: 8192,
        wait_for_approval: true,
        ..FakeFaultProfile::default()
    };
    let (cancel_tx, cancel_rx) = watch::channel(false);
    let (force_tx, force_rx) = oneshot::channel();
    let (approval_tx, approval_rx) = oneshot::channel();
    let task = tokio::spawn(async move {
        host.run_profile(&profile, cancel_rx, force_rx, approval_rx)
            .await
            .unwrap()
    });
    approval_tx.send(()).unwrap();
    sleep(Duration::from_millis(20)).await;
    cancel_tx.send(true).unwrap();
    sleep(Duration::from_millis(10)).await;
    force_tx.send(()).unwrap();

    assert_eq!(task.await.unwrap(), FakeExecutionOutcome::ExitConfirmed);
    assert_eq!(
        fs::metadata(directory.path().join("fake-output.bin"))
            .unwrap()
            .len(),
        8192
    );
    let events = fs::read_to_string(directory.path().join("fake-host.jsonl")).unwrap();
    assert!(events.contains("waiting_rate_limit"));
    assert!(events.contains("waiting_input"));
    assert!(events.contains("child_process_started"));
    assert!(events.contains("output_pressure"));
    assert!(events.contains("cancellation_ignored"));
}

#[tokio::test]
async fn unknown_external_effect_stays_manual_required_in_fixture() {
    let directory = TempDir::new().unwrap();
    let mut host = FakeExecutor::open(directory.path(), identity()).unwrap();
    let profile = FakeFaultProfile {
        unknown_external_effect: true,
        ..FakeFaultProfile::default()
    };
    let (_cancel_tx, cancel_rx) = watch::channel(false);
    let (_force_tx, force_rx) = oneshot::channel();
    let (_approval_tx, approval_rx) = oneshot::channel();

    assert_eq!(
        host.run_profile(&profile, cancel_rx, force_rx, approval_rx)
            .await
            .unwrap(),
        FakeExecutionOutcome::ManualRequired
    );
}

#[test]
fn acceptance_can_persist_before_losing_the_fake_response() {
    let directory = TempDir::new().unwrap();
    let mut host = FakeExecutor::open(directory.path(), identity()).unwrap();
    let profile = FakeFaultProfile {
        disconnect_after_accept: true,
        ..FakeFaultProfile::default()
    };

    let accepted = host
        .accept_with_profile(
            "operation-1",
            "command-1",
            json!({"kind":"start"}),
            &profile,
        )
        .unwrap();

    assert!(accepted.response_lost);
    assert_eq!(host.command_count(), 1);
}
