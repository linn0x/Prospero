#![cfg(unix)]

use prosperod_rs::{
    execution_budget::{BudgetClient, BudgetDecision, ensure_budget},
    orchestration::reliability::{
        ExecutionIdentity, ExitProofKind, ExitProofVerifier, HostIdentity, VerifiedExitProof,
    },
};
use std::{
    fs, io::Write, os::unix::fs::PermissionsExt, path::Path, process::Stdio, time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    time::{sleep, timeout},
};

fn identity(name: &str) -> ExecutionIdentity {
    ExecutionIdentity {
        task_id: format!("task-{name}"),
        dispatch_id: Some(format!("dispatch-{name}")),
        attempt_id: format!("attempt-{name}"),
        execution_epoch: 1,
        host: Some(HostIdentity {
            host_id: format!("host-{name}"),
            host_epoch: "epoch".into(),
        }),
        config_digest: "a".repeat(64),
    }
}

#[tokio::test]
async fn budget_daemon_child_reserves_once() {
    let Ok(name) = std::env::var("PROSPERO_W09_BUDGET_CHILD") else {
        return;
    };
    let client = BudgetClient::from_environment().unwrap();
    let decision = client
        .reserve(identity(&name), format!("daemon-{name}"))
        .await
        .unwrap();
    println!(
        "BUDGET_RESULT:{}",
        serde_json::to_string(&decision).unwrap()
    );
    std::io::stdout().flush().unwrap();
}

async fn daemon(directory: &Path, name: &str) -> BudgetDecision {
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "budget_daemon_child_reserves_once",
            "--nocapture",
        ])
        .env("PROSPERO_W09_BUDGET_CHILD", name)
        .env("PROSPERO_EXECUTION_BUDGET_DIR", directory)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let result = timeout(Duration::from_secs(10), async {
        while let Some(line) = lines.next_line().await.unwrap() {
            if let Some(json) = line.strip_prefix("BUDGET_RESULT:") {
                return serde_json::from_str(json).unwrap();
            }
        }
        panic!("budget daemon child exited without a result");
    })
    .await
    .unwrap();
    assert!(child.wait().await.unwrap().success());
    result
}

fn spawn_broker(directory: &Path, capacity: u32) -> Child {
    Command::new(env!("CARGO_BIN_EXE_prospero-budget-host"))
        .arg("--directory")
        .arg(directory)
        .arg("--capacity")
        .arg(capacity.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .unwrap()
}

async fn connect(directory: &Path) -> BudgetClient {
    timeout(Duration::from_secs(10), async {
        loop {
            if let Ok(client) = BudgetClient::from_directory(directory)
                && client.health().await.is_ok()
            {
                return client;
            }
            sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn two_daemon_processes_share_one_budget_and_restart_preserves_claims() {
    let directory = tempfile::tempdir().unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let mut broker = spawn_broker(directory.path(), 1);
    let client = connect(directory.path()).await;
    let epoch = client.health().await.unwrap().broker_epoch;
    let (first, second) =
        tokio::join!(daemon(directory.path(), "a"), daemon(directory.path(), "b"));
    let winner = match (first, second) {
        (
            BudgetDecision::Granted(claim),
            BudgetDecision::Waiting {
                used: 1,
                capacity: 1,
            },
        ) => claim,
        (
            BudgetDecision::Waiting {
                used: 1,
                capacity: 1,
            },
            BudgetDecision::Granted(claim),
        ) => claim,
        other => panic!("two daemons exceeded their shared capacity: {other:?}"),
    };
    assert_eq!(client.health().await.unwrap().held, 1);
    let mut duplicate = spawn_broker(directory.path(), 100);
    assert!(
        !timeout(Duration::from_secs(5), duplicate.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
    assert_eq!(client.health().await.unwrap().capacity, 1);
    broker.kill().await.unwrap();
    broker.wait().await.unwrap();
    assert!(client.health().await.is_err());
    let mut broker = spawn_broker(directory.path(), 1);
    let client = connect(directory.path()).await;
    assert_ne!(client.health().await.unwrap().broker_epoch, epoch);
    assert_eq!(client.health().await.unwrap().held, 1);
    let reconnect = ensure_budget(
        directory.path(),
        Path::new(env!("CARGO_BIN_EXE_prospero-budget-host")),
        1,
    )
    .await
    .unwrap();
    assert_eq!(
        client.health().await.unwrap().broker_epoch,
        reconnect.health().await.unwrap().broker_epoch
    );
    assert_eq!(
        client
            .quarantine(winner.identity.clone())
            .await
            .unwrap()
            .state,
        "quarantined"
    );
    assert_eq!(client.health().await.unwrap().quarantined, 1);
    assert_eq!(
        client
            .reserve(winner.identity.clone(), winner.daemon_id.clone())
            .await
            .unwrap()
            .granted_id(),
        Some(winner.claim_id.as_str())
    );
    let loser = if winner.daemon_id == "daemon-a" {
        "b"
    } else {
        "a"
    };
    assert!(matches!(
        client
            .reserve(identity(loser), format!("daemon-{loser}"))
            .await
            .unwrap(),
        BudgetDecision::Waiting {
            used: 1,
            capacity: 1
        }
    ));
    let proof = VerifiedExitProof {
        proof_id: "test-proof".into(),
        attempt_id: winner.identity.attempt_id.clone(),
        execution_epoch: 1,
        host: winner.identity.host.clone(),
        config_digest: winner.identity.config_digest.clone(),
        kind: ExitProofKind::StartupNotStarted,
        verifier: ExitProofVerifier::StartupCoordinator,
        evidence_digest: "b".repeat(64),
        verified_at: 1,
    };
    client
        .release(winner.identity.clone(), proof.clone())
        .await
        .unwrap();
    client.release(winner.identity, proof).await.unwrap();
    assert!(matches!(
        client
            .reserve(identity(loser), format!("daemon-{loser}"))
            .await
            .unwrap(),
        BudgetDecision::Granted(_)
    ));
    client.shutdown().await.unwrap();
    assert!(
        timeout(Duration::from_secs(5), broker.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
}

trait GrantedId {
    fn granted_id(&self) -> Option<&str>;
}
impl GrantedId for BudgetDecision {
    fn granted_id(&self) -> Option<&str> {
        match self {
            Self::Granted(claim) => Some(&claim.claim_id),
            _ => None,
        }
    }
}

#[tokio::test]
async fn concurrent_reserve_and_release_converge_to_released_without_capacity_leak() {
    let directory = tempfile::tempdir().unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let mut broker = spawn_broker(directory.path(), 1);
    let client = connect(directory.path()).await;
    for index in 0..16 {
        let identity = identity(&format!("ordered-{index}"));
        let proof = VerifiedExitProof {
            proof_id: format!("proof-{index}"),
            attempt_id: identity.attempt_id.clone(),
            execution_epoch: 1,
            host: identity.host.clone(),
            config_digest: identity.config_digest.clone(),
            kind: ExitProofKind::StartupNotStarted,
            verifier: ExitProofVerifier::StartupCoordinator,
            evidence_digest: "b".repeat(64),
            verified_at: 1,
        };
        let (reserved, released) = tokio::join!(
            client.reserve(identity.clone(), "daemon-ordering".into()),
            client.release(identity.clone(), proof.clone()),
        );
        assert_eq!(released.unwrap().state, "released");
        if let Ok(decision) = reserved {
            assert!(matches!(decision, BudgetDecision::Granted(_)));
        }
        assert!(
            client
                .reserve(identity.clone(), "daemon-ordering".into())
                .await
                .is_err()
        );
        assert_eq!(
            client.release(identity, proof).await.unwrap().state,
            "released"
        );
        let status = client.health().await.unwrap();
        assert_eq!(status.held, 0);
        assert_eq!(status.quarantined, 0);
        assert_eq!(status.released, index + 1);
    }
    client.shutdown().await.unwrap();
    assert!(
        timeout(Duration::from_secs(5), broker.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
}
