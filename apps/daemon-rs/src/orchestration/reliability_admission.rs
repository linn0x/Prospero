use rusqlite::{OptionalExtension, params};

use crate::database::{Store, now, validate_id, validate_text};
use crate::error::{Error, Result};

pub struct ResourceClaim {
    pub kind: String,
    pub scope: String,
    pub limit: u32,
}

#[derive(Debug, PartialEq, Eq)]
pub enum AdmissionDecision {
    Reserved,
    Waiting {
        kind: String,
        scope: String,
        used: u32,
        limit: u32,
    },
}

pub(crate) fn reserve_execution_resources_tx(
    transaction: &rusqlite::Transaction<'_>,
    attempt_id: &str,
    claims: &[ResourceClaim],
) -> Result<AdmissionDecision> {
    validate_id(attempt_id)?;
    if claims.is_empty() || claims.len() > 32 {
        return Err(Error::Invalid("expected 1 to 32 resource claims".into()));
    }
    let mut unique = std::collections::HashSet::new();
    for claim in claims {
        validate_text(&claim.kind, 64, false)?;
        validate_text(&claim.scope, 256, false)?;
        if !unique.insert((&claim.kind, &claim.scope)) {
            return Err(Error::Invalid("duplicate resource claim".into()));
        }
    }
    let state: String = transaction
        .query_row(
            "SELECT state FROM orch_executions WHERE attempt_id=?1",
            [attempt_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or(Error::NotFound)?;
    if !matches!(
        state.as_str(),
        "planned"
            | "starting"
            | "running"
            | "waiting_input"
            | "start_unknown"
            | "stop_requested"
            | "stopping"
            | "stop_unknown"
            | "owner_unreachable"
            | "manual_required"
    ) {
        return Err(Error::Conflict);
    }
    for claim in claims {
        let released: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM orch_resource_reservations WHERE attempt_id=?1 AND resource_kind=?2 AND resource_scope=?3 AND state='released')",params![attempt_id,claim.kind,claim.scope],|r|r.get(0))?;
        if released {
            return Err(Error::Conflict);
        }
        let held: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM orch_resource_reservations WHERE attempt_id=?1 AND resource_kind=?2 AND resource_scope=?3 AND state IN ('held','quarantined'))",params![attempt_id,claim.kind,claim.scope],|r|r.get(0))?;
        if held {
            continue;
        }
        let used: u32 = transaction.query_row("SELECT count(*) FROM orch_resource_reservations WHERE resource_kind=?1 AND resource_scope=?2 AND state IN ('held','quarantined')",params![claim.kind,claim.scope],|r|r.get(0))?;
        if used >= claim.limit {
            return Ok(AdmissionDecision::Waiting {
                kind: claim.kind.clone(),
                scope: claim.scope.clone(),
                used,
                limit: claim.limit,
            });
        }
    }
    let timestamp = now();
    for claim in claims {
        transaction.execute("INSERT INTO orch_resource_reservations(reservation_id,attempt_id,resource_kind,resource_scope,state,created_at,updated_at) VALUES(?1,?2,?3,?4,'held',?5,?5) ON CONFLICT(attempt_id,resource_kind,resource_scope) DO NOTHING",params![uuid::Uuid::new_v4().simple().to_string(),attempt_id,claim.kind,claim.scope,timestamp])?;
    }
    Ok(AdmissionDecision::Reserved)
}

impl Store {
    pub fn reserve_execution_resources(
        &mut self,
        attempt_id: &str,
        claims: &[ResourceClaim],
    ) -> Result<AdmissionDecision> {
        self.reliability_transaction(|transaction| {
            reserve_execution_resources_tx(transaction, attempt_id, claims)
        })
    }

    pub fn quarantine_execution_resources(&mut self, attempt_id: &str) -> Result<usize> {
        validate_id(attempt_id)?;
        self.reliability_transaction(|transaction| {
            Ok(transaction.execute("UPDATE orch_resource_reservations SET state='quarantined',updated_at=?2 WHERE attempt_id=?1 AND state='held'",params![attempt_id,now()])?)
        })
    }

    pub fn release_execution_resources(
        &mut self,
        attempt_id: &str,
        proof_id: &str,
    ) -> Result<usize> {
        validate_id(attempt_id)?;
        validate_id(proof_id)?;
        self.reliability_transaction(|transaction| {
            let verified:bool=transaction.query_row("SELECT EXISTS(SELECT 1 FROM orch_executions e JOIN orch_exit_proofs p ON p.id=e.exit_proof_id AND p.attempt_id=e.attempt_id WHERE e.attempt_id=?1 AND p.id=?2 AND e.state IN ('quiesced','exit_confirmed','finalized'))",params![attempt_id,proof_id],|r|r.get(0))?;
            if !verified { return Err(Error::Conflict); }
            Ok(transaction.execute("UPDATE orch_resource_reservations SET state='released',release_proof_id=?2,updated_at=?3 WHERE attempt_id=?1 AND state IN ('held','quarantined')",params![attempt_id,proof_id,now()])?)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestration::{CreateRunGraph, GraphNodeInput};

    fn fixture() -> (tempfile::TempDir, Store) {
        let directory = tempfile::tempdir().unwrap();
        let mut store = Store::open(directory.path()).unwrap();
        let run = store
            .create_run_graph(CreateRunGraph {
                objective: "admission".into(),
                coordinator_session_id: None,
                operation_id: "create-resources".into(),
                nodes: (0..2)
                    .map(|n| GraphNodeInput {
                        client_id: n.to_string(),
                        title: "task".into(),
                        spec: "test".into(),
                        skills: vec![],
                        deps: vec![],
                        parent_id: None,
                    })
                    .collect(),
            })
            .unwrap();
        for n in 0..2 {
            store.connection.execute("INSERT INTO orch_executions(attempt_id,task_id,execution_epoch,config_digest,state,created_at,updated_at) VALUES(?1,?2,1,?3,'planned',0,0)",params![format!("attempt-{n}"),run.id_map[&n.to_string()],"a".repeat(64)]).unwrap();
        }
        (directory, store)
    }

    fn claim(scope: &str, limit: u32) -> ResourceClaim {
        ResourceClaim {
            kind: "execution".into(),
            scope: scope.into(),
            limit,
        }
    }

    #[test]
    fn quarantine_still_counts_and_age_never_releases() {
        let (_directory, mut store) = fixture();
        assert_eq!(
            store
                .reserve_execution_resources("attempt-0", &[claim("host", 1)])
                .unwrap(),
            AdmissionDecision::Reserved
        );
        assert_eq!(
            store.quarantine_execution_resources("attempt-0").unwrap(),
            1
        );
        store
            .connection
            .execute(
                "UPDATE orch_resource_reservations SET created_at=0,updated_at=0",
                [],
            )
            .unwrap();
        assert_eq!(
            store
                .reserve_execution_resources("attempt-1", &[claim("host", 1)])
                .unwrap(),
            AdmissionDecision::Waiting {
                kind: "execution".into(),
                scope: "host".into(),
                used: 1,
                limit: 1
            }
        );
        assert!(matches!(
            store.release_execution_resources("attempt-0", "not-a-proof"),
            Err(Error::Conflict)
        ));
    }

    #[test]
    fn multidimensional_rejection_does_not_partially_reserve() {
        let (_directory, mut store) = fixture();
        store
            .reserve_execution_resources("attempt-0", &[claim("account", 1)])
            .unwrap();
        assert!(matches!(
            store
                .reserve_execution_resources("attempt-1", &[claim("host", 5), claim("account", 1)])
                .unwrap(),
            AdmissionDecision::Waiting { .. }
        ));
        let count: i64 = store
            .connection
            .query_row(
                "SELECT count(*) FROM orch_resource_reservations WHERE attempt_id='attempt-1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn repeated_claim_is_idempotent_and_lower_limit_keeps_existing_reservation() {
        let (_directory, mut store) = fixture();
        store
            .reserve_execution_resources("attempt-0", &[claim("host", 1)])
            .unwrap();
        assert_eq!(
            store
                .reserve_execution_resources("attempt-0", &[claim("host", 0)])
                .unwrap(),
            AdmissionDecision::Reserved
        );
        let count: i64 = store
            .connection
            .query_row("SELECT count(*) FROM orch_resource_reservations", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(count, 1);
    }
}
