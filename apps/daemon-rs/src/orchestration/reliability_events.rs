use rusqlite::{OptionalExtension, params};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::reliability::ExecutionIdentity;
use crate::database::{Store, now, validate_id, validate_text};
use crate::error::{Error, Result};

#[derive(Debug, PartialEq, Eq)]
pub enum ImportOutcome {
    Applied { cursor: i64 },
    Duplicate { cursor: i64 },
    Gap { expected: i64, received: i64 },
}

pub struct HostEventInput<'a> {
    pub identity: &'a ExecutionIdentity,
    pub sequence: i64,
    pub event_id: &'a str,
    pub kind: &'a str,
    pub payload: Value,
}

impl Store {
    pub(crate) fn record_host_observation(
        &mut self,
        host: &super::reliability::HostIdentity,
        retired: bool,
    ) -> Result<()> {
        let object = Sha256::digest(serde_json::to_vec(&[&host.host_id, &host.host_epoch])?)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        self.reliability_transaction(|transaction| {
            let timestamp=now();
            transaction.execute("UPDATE orch_host_registry SET last_seen_at=?3,state=CASE WHEN ?4 THEN 'retired' ELSE state END WHERE host_id=?1 AND host_epoch=?2",params![host.host_id,host.host_epoch,timestamp,retired])?;
            transaction.execute("UPDATE orch_recovery_jobs SET state='complete',revision=revision+1,updated_at=?2 WHERE kind='host' AND object_id=?1 AND owner='host-event-import' AND state!='complete'",params![object,timestamp])?;
            Ok(())
        })
    }

    pub fn runtime_reliability_snapshot(&self) -> Result<Value> {
        use super::reliability::{ExecutionRecord, OperationView};
        let mut executions_query=self.connection.prepare("SELECT json_object('identity',json_object('taskId',task_id,'dispatchId',dispatch_id,'attemptId',attempt_id,'executionEpoch',execution_epoch,'host',CASE WHEN host_id IS NULL THEN NULL ELSE json_object('hostId',host_id,'hostEpoch',host_epoch) END,'configDigest',config_digest),'state',upper(state),'resultState',upper(result_state),'stopGeneration',stop_generation,'exitProofId',exit_proof_id,'createdAt',created_at,'updatedAt',updated_at) FROM orch_executions ORDER BY (state='finalized'),updated_at DESC,attempt_id LIMIT 1001")?;
        let rows = executions_query
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let executions_truncated = rows.len() > 1000;
        let executions = rows
            .into_iter()
            .take(1000)
            .map(|row| serde_json::from_str::<ExecutionRecord>(&row))
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut operations_query=self.connection.prepare("SELECT json_object('operationId',operation_id,'kind',kind,'state',upper(state),'taskId',task_id,'attemptId',attempt_id,'executionEpoch',execution_epoch,'effectState',upper(effect_state),'waitReason',CASE WHEN wait_reason IS NULL THEN NULL ELSE upper(wait_reason) END,'retryAfterMs',retry_after_ms,'nextReconcileAt',next_reconcile_at,'revision',revision) FROM orch_operations_v2 ORDER BY (state IN ('succeeded','failed','cancelled')),updated_at DESC,operation_id LIMIT 1001")?;
        let rows = operations_query
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let operations_truncated = rows.len() > 1000;
        let operations = rows
            .into_iter()
            .take(1000)
            .map(|row| serde_json::from_str::<OperationView>(&row))
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(
            serde_json::json!({"executions":executions,"operations":operations,"executionsTruncated":executions_truncated,"operationsTruncated":operations_truncated}),
        )
    }

    pub fn runtime_reliability_health(
        &self,
    ) -> Result<prospero_protocol_rs::RuntimeReliabilityHealth> {
        use prospero_protocol_rs::{RuntimeHealthStatus, RuntimeReliabilityHealth};
        let timestamp = now();
        self.connection.query_row(
            "SELECT coalesce((SELECT max(?1-updated_at) FROM orch_operations_v2 WHERE state='outcome_unknown'),0), (SELECT count(*) FROM orch_executions WHERE state IN ('stop_requested','stopping','stop_unknown')), (SELECT count(*) FROM orch_host_registry WHERE state='unreachable'), (SELECT count(*) FROM orch_resource_reservations WHERE state='quarantined'), (SELECT count(*) FROM orch_executions WHERE result_state='accepted' AND state NOT IN ('quiesced','exit_confirmed','finalized')), (SELECT count(*) FROM orch_recovery_jobs WHERE state!='complete'), (SELECT count(*) FROM orch_recovery_jobs WHERE state='manual_required'), (SELECT count(*) FROM orch_recovery_jobs WHERE kind='event_gap' AND state!='complete')",
            [timestamp], |row| {
                let backlog: i64 = row.get(5)?;
                let gaps: i64 = row.get(7)?;
                Ok(RuntimeReliabilityHealth {
                    liveness: RuntimeHealthStatus::Healthy,
                    readiness: RuntimeHealthStatus::Healthy,
                    progress: if backlog>0 {RuntimeHealthStatus::Degraded} else {RuntimeHealthStatus::Healthy},
                    consistency: if gaps>0 {RuntimeHealthStatus::Degraded} else {RuntimeHealthStatus::Healthy},
                    observed_at:timestamp, operation_unknown_age_ms:row.get::<_,i64>(0)?.max(0), stop_unconfirmed_count:row.get(1)?, unreachable_host_count:row.get(2)?, quarantined_capacity:row.get(3)?, result_pending_cleanup_count:row.get(4)?, recovery_backlog:backlog, manual_intervention_count:row.get(6)?,event_gap_count:gaps,
                })
            }
        ).map_err(Error::from)
    }

    pub fn import_host_event(&mut self, event: HostEventInput<'_>) -> Result<ImportOutcome> {
        let identity = event.identity;
        let host = identity.host.as_ref().ok_or(Error::Conflict)?;
        validate_id(&identity.attempt_id)?;
        validate_id(&host.host_id)?;
        validate_id(&host.host_epoch)?;
        let legacy_id = format!("{}/{}/{}", host.host_id, host.host_epoch, event.sequence);
        let event_id = if event.event_id == legacy_id {
            format!(
                "legacy-{}",
                Sha256::digest(event.event_id.as_bytes())
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>()
            )
        } else {
            validate_id(event.event_id)?;
            event.event_id.to_owned()
        };
        validate_text(event.kind, 128, false)?;
        if event.sequence <= 0
            || event.sequence > 9_007_199_254_740_991
            || identity.execution_epoch > 9_007_199_254_740_991
        {
            return Err(Error::Invalid(
                "host event identity exceeds supported range".into(),
            ));
        }
        let payload = serde_json::to_string(&event.payload)?;
        if payload.len() > 1024 * 1024 {
            return Err(Error::Invalid("host event exceeds limit".into()));
        }
        let host_key = Sha256::digest(serde_json::to_vec(&[&host.host_id, &host.host_epoch])?)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let execution_epoch = i64::try_from(identity.execution_epoch)
            .map_err(|_| Error::Invalid("execution epoch exceeds supported range".into()))?;
        self.reliability_transaction(|transaction| {
            let bound: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM orch_executions WHERE attempt_id=?1 AND task_id=?2 AND dispatch_id IS ?3 AND execution_epoch=?4 AND host_id=?5 AND host_epoch=?6 AND config_digest=?7)",
                params![identity.attempt_id, identity.task_id, identity.dispatch_id, execution_epoch, host.host_id, host.host_epoch, identity.config_digest],
                |row| row.get(0),
            )?;
            if !bound {
                return Err(Error::Conflict);
            }
            let cursor = transaction.query_row(
                "SELECT cursor_seq FROM orch_host_event_cursors WHERE host_id=?1 AND host_epoch=?2 AND consumer='daemon'",
                params![host.host_id, host.host_epoch], |row| row.get::<_, i64>(0),
            ).optional()?.unwrap_or(0);
            let existing = transaction.query_row(
                "SELECT event_id,event_kind,attempt_id,payload FROM orch_host_events WHERE host_id=?1 AND host_epoch=?2 AND host_event_seq=?3",
                params![host.host_id, host.host_epoch, event.sequence],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?, row.get::<_, String>(3)?)),
            ).optional()?;
            if let Some((id, kind, attempt, previous)) = existing {
                if id != event_id || kind != event.kind || attempt.as_deref() != Some(identity.attempt_id.as_str()) || previous != payload {
                    return Err(Error::Conflict);
                }
                return Ok(ImportOutcome::Duplicate { cursor });
            }
            if event.sequence != cursor + 1 {
                let timestamp = now();
                let object = &host_key;
                let detail = serde_json::json!({"expected": cursor + 1, "received": event.sequence}).to_string();
                transaction.execute(
                    "INSERT INTO orch_recovery_jobs(job_id,kind,object_id,state,owner,next_check_at,revision,detail,created_at,updated_at) VALUES(?1,'event_gap',?2,'pending','host-event-import',?3,1,?4,?3,?3) ON CONFLICT(kind,object_id) DO UPDATE SET state='pending',next_check_at=excluded.next_check_at,revision=orch_recovery_jobs.revision+1,detail=excluded.detail,updated_at=excluded.updated_at",
                    params![uuid::Uuid::new_v4().simple().to_string(), object, timestamp, detail],
                )?;
                return Ok(ImportOutcome::Gap { expected: cursor + 1, received: event.sequence });
            }
            let timestamp = now();
            transaction.execute(
                "INSERT INTO orch_host_events(host_id,host_epoch,host_event_seq,event_id,event_kind,attempt_id,payload,received_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
                params![host.host_id, host.host_epoch, event.sequence, event_id, event.kind, identity.attempt_id, payload, timestamp],
            )?;
            Store::append_event(transaction, "orchestration", "execution.host_event", &identity.attempt_id,
                serde_json::json!({"identity": identity, "hostEventSeq": event.sequence, "eventId": event_id, "sourceEventId":event.event_id, "kind":event.kind,"payload":event.payload}))?;
            transaction.execute(
                "INSERT INTO orch_host_event_cursors(host_id,host_epoch,consumer,cursor_seq,updated_at) VALUES(?1,?2,'daemon',?3,?4) ON CONFLICT(host_id,host_epoch,consumer) DO UPDATE SET cursor_seq=excluded.cursor_seq,updated_at=excluded.updated_at",
                params![host.host_id, host.host_epoch, event.sequence, timestamp],
            )?;
            transaction.execute("UPDATE orch_recovery_jobs SET state='complete',revision=revision+1,updated_at=?3 WHERE kind='event_gap' AND object_id=?1 AND state='pending' AND json_extract(detail,'$.received')<=?2",params![host_key,event.sequence,timestamp])?;
            Ok(ImportOutcome::Applied { cursor: event.sequence })
        })
    }
}

#[cfg(unix)]
pub async fn run_host_event_importer(
    database: crate::worker::Database,
    directory: std::path::PathBuf,
    agents: crate::agent::Agents,
    mut stopping: tokio::sync::watch::Receiver<bool>,
) -> Result<()> {
    let mut offset = 0i64;
    let mut interval = tokio::time::interval_at(
        tokio::time::Instant::now() + std::time::Duration::from_secs(1),
        std::time::Duration::from_secs(1),
    );
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = stopping.changed() => return Ok(()),
            _ = interval.tick() => {
                if !database.health().alive { return Ok(()); }
                match poll_host_events(&database, &directory, &agents, offset).await {
                    Ok(16) => offset = offset.saturating_add(16),
                    _ => offset = 0,
                }
            }
        }
    }
}

#[cfg(not(unix))]
pub async fn run_host_event_importer(
    _database: crate::worker::Database,
    _directory: std::path::PathBuf,
    _agents: crate::agent::Agents,
    _stopping: tokio::sync::watch::Receiver<bool>,
) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
async fn poll_host_events(
    database: &crate::worker::Database,
    directory: &std::path::Path,
    agents: &crate::agent::Agents,
    offset: i64,
) -> Result<usize> {
    use super::reliability::{HostIdentity, VerifiedExitProof};
    use crate::execution_host::launcher::HostHandle;
    use futures_util::{StreamExt, stream};
    let hosts = database.call_control("execution.events.hosts", move |store| {
        let mut query = store.connection.prepare("SELECT h.host_id,h.host_epoch,h.runtime_digest,coalesce(c.cursor_seq,0) FROM orch_host_registry h LEFT JOIN orch_host_event_cursors c ON c.host_id=h.host_id AND c.host_epoch=h.host_epoch AND c.consumer='daemon' WHERE h.state IN ('active','unreachable') ORDER BY h.host_id,h.host_epoch LIMIT 16 OFFSET ?1")?;
        Ok(query.query_map([offset], |row| Ok((HostIdentity{host_id:row.get(0)?,host_epoch:row.get(1)?},row.get::<_,String>(2)?,row.get::<_,i64>(3)?)))?.collect::<rusqlite::Result<Vec<_>>>()?)
    }).await?;
    let scanned = hosts.len();
    let results=stream::iter(hosts.into_iter().map(|(host,digest,mut cursor)| async move {
        let result: Result<()> = async {
            let handle=HostHandle::open(directory,&host)?;
            if handle.manifest.runtime_digest!=digest {return Err(Error::Conflict);}
            let client=handle.client()?;
            let page=tokio::time::timeout(std::time::Duration::from_secs(3),client.events(cursor as u64,100)).await.map_err(|_|Error::Timeout)??;
            for event in page.events {
                let sequence=i64::try_from(event.sequence).map_err(|_|Error::Invalid("event sequence overflow".into()))?;
                let payload:Value=serde_json::from_str(&event.payload)?;
                let matching=database.call_control("execution.events.identity", {
                    let attempt=event.identity.attempt_id.clone();
                    move |store|store.get_reliability_execution(&attempt)
                }).await?;
                if matching.identity!=event.identity {return Err(Error::Conflict);}
                if sequence==cursor+1 {
                    if event.kind=="delivery_received_offline" {
                        let command_id=payload.get("commandId").and_then(Value::as_str).ok_or(Error::Conflict)?;
                        let detail=tokio::time::timeout(std::time::Duration::from_secs(3),client.command_detail(command_id)).await.map_err(|_|Error::Timeout)??;
                        if detail.command.identity!=event.identity {return Err(Error::Conflict);}
                        super::reliability_operations::import_host_result(database,detail.command).await?;
                    } else if event.kind=="exit_confirmed" {
                        let proof:VerifiedExitProof=serde_json::from_value(payload.get("proof").cloned().ok_or(Error::Conflict)?)?;
                        let run_id=super::reliability_operations::confirm_execution_exit(database,event.identity.clone(),proof).await?;
                        let database=database.clone();
                        let agents=agents.clone();
                        tokio::spawn(async move {super::kick_automation(&database,&agents,&run_id).await;});
                    }
                }
                let outcome=database.call_control("execution.events.import",move |store|store.import_host_event(HostEventInput{identity:&event.identity,sequence,event_id:&event.event_id,kind:&event.kind,payload})).await?;
                match outcome {
                    ImportOutcome::Applied{cursor:next}|ImportOutcome::Duplicate{cursor:next}=>cursor=next,
                    ImportOutcome::Gap{..}=>return Ok(()),
                }
            }
            let retire = database.call_control("execution.host.retirable", {
                let host=host.clone();
                move |store| {
                    store.connection.query_row("SELECT NOT EXISTS(SELECT 1 FROM orch_executions e WHERE e.host_id=?1 AND e.host_epoch=?2 AND e.state!='finalized') AND NOT EXISTS(SELECT 1 FROM orch_operations_v2 o JOIN orch_executions e ON e.attempt_id=o.attempt_id WHERE e.host_id=?1 AND e.host_epoch=?2 AND o.state NOT IN ('succeeded','failed','cancelled')) AND NOT EXISTS(SELECT 1 FROM orch_result_receipts r JOIN orch_executions e ON e.attempt_id=r.attempt_id WHERE e.host_id=?1 AND e.host_epoch=?2 AND r.state NOT IN ('accepted','rejected'))", params![host.host_id,host.host_epoch],|row|row.get::<_,bool>(0)).map_err(Error::from)
                }
            }).await?;
            if retire {
                let tail=tokio::time::timeout(std::time::Duration::from_secs(3),client.events(cursor as u64,1)).await.map_err(|_|Error::Timeout)??;
                if tail.events.is_empty() && !tail.gap && tokio::time::timeout(std::time::Duration::from_secs(3),client.shutdown_when_drained(cursor as u64)).await.is_ok_and(|value|value.is_ok()) {
                    database.call_control("execution.host.retire",{
                        let host=host.clone();
                        move |store| store.record_host_observation(&host,true)
                    }).await?;
                    return Ok(());
                }
            }
            database.call_control("execution.host.seen",{
                let host=host.clone();
                move |store| store.record_host_observation(&host,false)
            }).await?;
            Ok(())
        }.await;
        if result.is_err() {
            let object=Sha256::digest(serde_json::to_vec(&[&host.host_id,&host.host_epoch])?).iter().map(|b|format!("{b:02x}")).collect::<String>();
            database.call_control("execution.host.recovery",move |store| {
                let timestamp=now();
                store.connection.execute("INSERT INTO orch_recovery_jobs(job_id,kind,object_id,state,owner,next_check_at,revision,detail,created_at,updated_at) VALUES(?1,'host',?2,'pending','host-event-import',?3,1,'Host observation unavailable',?4,?4) ON CONFLICT(kind,object_id) DO UPDATE SET state='pending',next_check_at=excluded.next_check_at,revision=orch_recovery_jobs.revision+1,updated_at=excluded.updated_at",params![uuid::Uuid::new_v4().simple().to_string(),object,timestamp.saturating_add(30000),timestamp])?;
                Ok(())
            }).await?;
        }
        Ok::<(),Error>(())
    })).buffer_unordered(4).collect::<Vec<_>>().await;
    for result in results {
        result?;
    }
    Ok(scanned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestration::reliability::HostIdentity;
    use crate::orchestration::{CreateRunGraph, GraphNodeInput};
    use serde_json::json;

    fn fixture() -> (tempfile::TempDir, Store, ExecutionIdentity) {
        let directory = tempfile::tempdir().unwrap();
        let mut store = Store::open(directory.path()).unwrap();
        let run = store
            .create_run_graph(CreateRunGraph {
                objective: "host events".into(),
                nodes: vec![GraphNodeInput {
                    client_id: "task".into(),
                    title: "test".into(),
                    spec: "test".into(),
                    skills: vec![],
                    deps: vec![],
                    parent_id: None,
                }],
                coordinator_session_id: None,
                operation_id: "create-events".into(),
            })
            .unwrap();
        let identity = ExecutionIdentity {
            task_id: run.id_map["task"].clone(),
            dispatch_id: None,
            attempt_id: "attempt-events".into(),
            execution_epoch: 1,
            host: Some(HostIdentity {
                host_id: "host-events".into(),
                host_epoch: "epoch-events".into(),
            }),
            config_digest: "a".repeat(64),
        };
        store.connection.execute("INSERT INTO orch_host_registry(host_id,host_epoch,protocol_version,runtime_digest,capabilities,registered_at,state) VALUES('host-events','epoch-events',1,?1,'[]',0,'active')",["a".repeat(64)]).unwrap();
        store.connection.execute("INSERT INTO orch_executions(attempt_id,task_id,execution_epoch,host_id,host_epoch,config_digest,state,created_at,updated_at) VALUES(?1,?2,1,'host-events','epoch-events',?3,'running',0,0)",params![identity.attempt_id,identity.task_id,identity.config_digest]).unwrap();
        (directory, store, identity)
    }

    fn event<'a>(
        identity: &'a ExecutionIdentity,
        sequence: i64,
        value: &str,
    ) -> HostEventInput<'a> {
        HostEventInput {
            identity,
            sequence,
            event_id: if sequence == 1 {
                "event-one"
            } else {
                "event-two"
            },
            kind: "progress",
            payload: json!({"value":value}),
        }
    }

    #[test]
    fn replay_is_idempotent_and_changed_content_conflicts() {
        let (_directory, mut store, identity) = fixture();
        assert_eq!(
            store.import_host_event(event(&identity, 1, "one")).unwrap(),
            ImportOutcome::Applied { cursor: 1 }
        );
        assert_eq!(
            store.import_host_event(event(&identity, 1, "one")).unwrap(),
            ImportOutcome::Duplicate { cursor: 1 }
        );
        assert!(matches!(
            store.import_host_event(event(&identity, 1, "different")),
            Err(Error::Conflict)
        ));
        let count: i64 = store
            .connection
            .query_row("SELECT count(*) FROM orch_host_events", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn gaps_keep_cursor_and_create_durable_recovery_responsibility() {
        let (_directory, mut store, identity) = fixture();
        assert_eq!(
            store.import_host_event(event(&identity, 2, "two")).unwrap(),
            ImportOutcome::Gap {
                expected: 1,
                received: 2
            }
        );
        let count:i64=store.connection.query_row("SELECT count(*) FROM orch_recovery_jobs WHERE kind='event_gap' AND state='pending'",[],|r|r.get(0)).unwrap();
        assert_eq!(count, 1);
        assert_eq!(
            store.import_host_event(event(&identity, 1, "one")).unwrap(),
            ImportOutcome::Applied { cursor: 1 }
        );
        assert_eq!(
            store.import_host_event(event(&identity, 2, "two")).unwrap(),
            ImportOutcome::Applied { cursor: 2 }
        );
    }

    #[test]
    fn legacy_host_event_ids_replay_without_weakening_identity_validation() {
        let (_directory, mut store, identity) = fixture();
        let input = HostEventInput {
            identity: &identity,
            sequence: 1,
            event_id: "host-events/epoch-events/1",
            kind: "progress",
            payload: json!({"legacy":true}),
        };
        assert_eq!(
            store.import_host_event(input).unwrap(),
            ImportOutcome::Applied { cursor: 1 }
        );
        let input = HostEventInput {
            identity: &identity,
            sequence: 1,
            event_id: "host-events/epoch-events/1",
            kind: "progress",
            payload: json!({"legacy":true}),
        };
        assert_eq!(
            store.import_host_event(input).unwrap(),
            ImportOutcome::Duplicate { cursor: 1 }
        );
        let input = HostEventInput {
            identity: &identity,
            sequence: 2,
            event_id: "another-host/epoch-events/2",
            kind: "progress",
            payload: json!({}),
        };
        assert!(store.import_host_event(input).is_err());
    }

    #[test]
    fn successful_host_observation_closes_its_durable_recovery_responsibility() {
        let (_directory, mut store, identity) = fixture();
        let host = identity.host.unwrap();
        let object =
            Sha256::digest(serde_json::to_vec(&[&host.host_id, &host.host_epoch]).unwrap())
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
        store.connection.execute("INSERT INTO orch_recovery_jobs(job_id,kind,object_id,state,owner,next_check_at,revision,created_at,updated_at) VALUES('host-job','host',?1,'pending','host-event-import',0,1,0,0)",[object]).unwrap();
        store.record_host_observation(&host, false).unwrap();
        let state: String = store
            .connection
            .query_row(
                "SELECT state FROM orch_recovery_jobs WHERE job_id='host-job'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(state, "complete");
        store.record_host_observation(&host, true).unwrap();
        let state: String = store
            .connection
            .query_row(
                "SELECT state FROM orch_host_registry WHERE host_id='host-events'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(state, "retired");
    }

    #[test]
    fn stale_epoch_cannot_import_an_event() {
        let (_directory, mut store, mut identity) = fixture();
        identity.execution_epoch = 2;
        assert!(matches!(
            store.import_host_event(event(&identity, 1, "stale")),
            Err(Error::Conflict)
        ));
        identity.execution_epoch = 1;
        identity.host.as_mut().unwrap().host_epoch = "old-host".into();
        assert!(matches!(
            store.import_host_event(event(&identity, 1, "stale")),
            Err(Error::Conflict)
        ));
    }
}
