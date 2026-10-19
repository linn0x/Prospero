CREATE TABLE orch_exit_proofs (
    id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL,
    execution_epoch INTEGER NOT NULL CHECK(execution_epoch BETWEEN 1 AND 9007199254740991),
    host_id TEXT,
    host_epoch TEXT,
    config_digest TEXT NOT NULL CHECK(length(config_digest) = 64),
    proof_kind TEXT NOT NULL CHECK(proof_kind IN ('host_process_exit','driver_quiescence','startup_not_started','registered_resource_release')),
    verifier TEXT NOT NULL CHECK(verifier IN ('execution_host','driver','startup_coordinator','resource_handler')),
    evidence_digest TEXT NOT NULL CHECK(length(evidence_digest) = 64),
    verified_at INTEGER NOT NULL CHECK(verified_at >= 0),
    UNIQUE(id,attempt_id,execution_epoch,host_id,host_epoch,config_digest),
    UNIQUE(id,attempt_id)
) STRICT;
CREATE TABLE orch_host_registry (
    host_id TEXT NOT NULL CHECK(length(host_id) BETWEEN 1 AND 128),
    host_epoch TEXT NOT NULL CHECK(length(host_epoch) BETWEEN 1 AND 128),
    protocol_version INTEGER NOT NULL CHECK(protocol_version > 0),
    runtime_digest TEXT NOT NULL CHECK(length(runtime_digest) = 64),
    capabilities TEXT NOT NULL CHECK(json_valid(capabilities)),
    registered_at INTEGER NOT NULL CHECK(registered_at >= 0),
    last_seen_at INTEGER CHECK(last_seen_at IS NULL OR last_seen_at >= registered_at),
    state TEXT NOT NULL CHECK(state IN ('active','unreachable','retired','incompatible')),
    PRIMARY KEY(host_id,host_epoch)
) STRICT;
CREATE TABLE orch_executions (
    attempt_id TEXT PRIMARY KEY CHECK(length(attempt_id) BETWEEN 1 AND 128),
    task_id TEXT NOT NULL REFERENCES orch_tasks(id) ON DELETE CASCADE,
    dispatch_id TEXT UNIQUE REFERENCES orch_dispatches(id),
    execution_epoch INTEGER NOT NULL CHECK(execution_epoch BETWEEN 1 AND 9007199254740991),
    host_id TEXT,
    host_epoch TEXT,
    config_digest TEXT NOT NULL CHECK(length(config_digest) = 64),
    state TEXT NOT NULL CHECK(state IN ('planned','starting','running','waiting_input','stop_requested','stopping','start_unknown','stop_unknown','owner_unreachable','manual_required','quiesced','exit_confirmed','finalized')),
    result_state TEXT NOT NULL DEFAULT 'none' CHECK(result_state IN ('none','submitted','accepted','rejected')),
    stop_generation INTEGER NOT NULL DEFAULT 0 CHECK(stop_generation BETWEEN 0 AND 9007199254740991),
    exit_proof_id TEXT,
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
    UNIQUE(task_id,execution_epoch),
    UNIQUE(attempt_id,task_id,execution_epoch),
    UNIQUE(attempt_id,execution_epoch),
    UNIQUE(attempt_id,task_id,execution_epoch,host_id,host_epoch,config_digest),
    UNIQUE(attempt_id,execution_epoch,host_id,host_epoch,config_digest),
    FOREIGN KEY(host_id,host_epoch) REFERENCES orch_host_registry(host_id,host_epoch),
    FOREIGN KEY(exit_proof_id,attempt_id,execution_epoch,host_id,host_epoch,config_digest) REFERENCES orch_exit_proofs(id,attempt_id,execution_epoch,host_id,host_epoch,config_digest),
    CHECK((host_id IS NULL) = (host_epoch IS NULL)),
    CHECK(state NOT IN ('quiesced','exit_confirmed','finalized') OR exit_proof_id IS NOT NULL)
) STRICT;
CREATE UNIQUE INDEX orch_execution_task_unsettled
    ON orch_executions(task_id)
    WHERE state NOT IN ('finalized');
CREATE INDEX orch_execution_host_state
    ON orch_executions(host_id,host_epoch,state);
CREATE TRIGGER orch_exit_proof_identity_insert
BEFORE INSERT ON orch_exit_proofs
WHEN NOT EXISTS (
    SELECT 1 FROM orch_executions e
    WHERE e.attempt_id=NEW.attempt_id
      AND e.execution_epoch=NEW.execution_epoch
      AND e.host_id IS NEW.host_id
      AND e.host_epoch IS NEW.host_epoch
      AND e.config_digest=NEW.config_digest
)
BEGIN
    SELECT RAISE(ABORT,'exit proof identity mismatch');
END;
CREATE TRIGGER orch_execution_exit_proof_identity_update
BEFORE UPDATE OF exit_proof_id,state ON orch_executions
WHEN NEW.exit_proof_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM orch_exit_proofs p
    WHERE p.id=NEW.exit_proof_id AND p.attempt_id=NEW.attempt_id
      AND p.execution_epoch=NEW.execution_epoch
      AND p.host_id IS NEW.host_id AND p.host_epoch IS NEW.host_epoch
      AND p.config_digest=NEW.config_digest
)
BEGIN
    SELECT RAISE(ABORT,'execution exit proof identity mismatch');
END;
CREATE TRIGGER orch_execution_closed_state_monotonic
BEFORE UPDATE OF state ON orch_executions
WHEN (OLD.state='finalized' AND NEW.state!='finalized')
  OR (OLD.state IN ('quiesced','exit_confirmed') AND NEW.state NOT IN ('quiesced','exit_confirmed','finalized'))
BEGIN
    SELECT RAISE(ABORT,'closed execution state cannot reopen');
END;
CREATE TRIGGER orch_execution_result_monotonic
BEFORE UPDATE OF result_state ON orch_executions
WHEN (OLD.result_state='accepted' AND NEW.result_state!='accepted')
  OR (OLD.result_state='rejected' AND NEW.result_state!='rejected' AND NOT (NEW.result_state='submitted' AND EXISTS(SELECT 1 FROM orch_result_receipts r WHERE r.attempt_id=NEW.attempt_id AND r.execution_epoch=NEW.execution_epoch AND r.state='received')))
BEGIN
    SELECT RAISE(ABORT,'terminal result state is monotonic');
END;
CREATE TABLE orch_operations_v2 (
    operation_id TEXT PRIMARY KEY CHECK(length(operation_id) BETWEEN 1 AND 128),
    kind TEXT NOT NULL CHECK(kind IN ('start','stop','message','result','interaction_reply','reconcile')),
    request_version INTEGER NOT NULL CHECK(request_version > 0),
    fingerprint TEXT NOT NULL CHECK(length(fingerprint) = 64),
    request TEXT NOT NULL CHECK(length(CAST(request AS BLOB)) BETWEEN 1 AND 1048576),
    state TEXT NOT NULL CHECK(state IN ('accepted','running','waiting','succeeded','failed','cancelled','outcome_unknown')),
    task_id TEXT REFERENCES orch_tasks(id) ON DELETE CASCADE,
    attempt_id TEXT REFERENCES orch_executions(attempt_id),
    execution_epoch INTEGER CHECK(execution_epoch IS NULL OR execution_epoch > 0),
    effect_state TEXT NOT NULL CHECK(effect_state IN ('none','received','delivered','unknown','failed')),
    wait_reason TEXT CHECK(wait_reason IS NULL OR wait_reason IN ('account_throttled','host_pressure','start_queue_full','dependency_blocked','waiting_input','owner_unreachable','config_invalid','host_incompatible','storage_unavailable','manual_required')),
    retry_after_ms INTEGER CHECK(retry_after_ms IS NULL OR retry_after_ms BETWEEN 0 AND 9007199254740991),
    next_reconcile_at INTEGER CHECK(next_reconcile_at IS NULL OR next_reconcile_at BETWEEN 0 AND 9007199254740991),
    revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
    result TEXT CHECK(result IS NULL OR length(CAST(result AS BLOB)) <= 2097152),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
    CHECK((attempt_id IS NULL) = (execution_epoch IS NULL)),
    CHECK((attempt_id IS NULL) = (task_id IS NULL)),
    FOREIGN KEY(attempt_id,task_id,execution_epoch) REFERENCES orch_executions(attempt_id,task_id,execution_epoch),
    CHECK(state != 'outcome_unknown' OR (wait_reason IS NOT NULL AND next_reconcile_at IS NOT NULL))
) STRICT;
CREATE INDEX orch_operations_state_due
    ON orch_operations_v2(state,next_reconcile_at,created_at);
CREATE INDEX orch_operations_attempt
    ON orch_operations_v2(attempt_id,created_at);
CREATE TRIGGER orch_operation_revision_monotonic
BEFORE UPDATE ON orch_operations_v2
WHEN NEW.revision != OLD.revision + 1 OR NEW.updated_at < OLD.updated_at
BEGIN
    SELECT RAISE(ABORT,'operation revision must advance');
END;
CREATE TRIGGER orch_operation_terminal_monotonic
BEFORE UPDATE OF state ON orch_operations_v2
WHEN OLD.state IN ('succeeded','failed','cancelled') AND NEW.state != OLD.state
BEGIN
    SELECT RAISE(ABORT,'terminal operation state is monotonic');
END;
CREATE TABLE orch_host_commands (
    command_id TEXT PRIMARY KEY CHECK(length(command_id) BETWEEN 1 AND 128),
    operation_id TEXT NOT NULL REFERENCES orch_operations_v2(operation_id),
    attempt_id TEXT NOT NULL REFERENCES orch_executions(attempt_id),
    task_id TEXT NOT NULL,
    execution_epoch INTEGER NOT NULL CHECK(execution_epoch BETWEEN 1 AND 9007199254740991),
    host_id TEXT,
    host_epoch TEXT,
    config_digest TEXT NOT NULL CHECK(length(config_digest) = 64),
    command_kind TEXT NOT NULL CHECK(command_kind IN ('start','stop','send','result','interaction_reply','snapshot','reconcile')),
    fingerprint TEXT NOT NULL CHECK(length(fingerprint) = 64),
    payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) BETWEEN 1 AND 1048576),
    state TEXT NOT NULL CHECK(state IN ('pending','sent','received','completed','unknown','rejected')),
    effect_state TEXT NOT NULL DEFAULT 'none' CHECK(effect_state IN ('none','received','delivered','unknown','failed')),
    receipt TEXT CHECK(receipt IS NULL OR length(CAST(receipt AS BLOB)) <= 1048576),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
    FOREIGN KEY(attempt_id,task_id,execution_epoch,host_id,host_epoch,config_digest) REFERENCES orch_executions(attempt_id,task_id,execution_epoch,host_id,host_epoch,config_digest)
) STRICT;
CREATE INDEX orch_host_commands_outbox ON orch_host_commands(state,created_at);
CREATE INDEX orch_host_commands_attempt ON orch_host_commands(attempt_id,created_at);
CREATE TRIGGER orch_host_command_terminal_monotonic
BEFORE UPDATE OF state ON orch_host_commands
WHEN OLD.state IN ('completed','rejected') AND NEW.state != OLD.state
BEGIN
    SELECT RAISE(ABORT,'terminal command receipt is monotonic');
END;
CREATE TABLE orch_result_receipts (
    submission_id TEXT PRIMARY KEY CHECK(length(submission_id) BETWEEN 1 AND 128),
    attempt_id TEXT NOT NULL REFERENCES orch_executions(attempt_id),
    execution_epoch INTEGER NOT NULL CHECK(execution_epoch BETWEEN 1 AND 9007199254740991),
    fingerprint TEXT NOT NULL CHECK(length(fingerprint) = 64),
    submission TEXT NOT NULL CHECK(length(CAST(submission AS BLOB)) BETWEEN 1 AND 1048576),
    state TEXT NOT NULL CHECK(state IN ('received','submitted','accepted','rejected','outcome_unknown')),
    receipt TEXT CHECK(receipt IS NULL OR length(CAST(receipt AS BLOB)) <= 2097152),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
    UNIQUE(attempt_id,submission_id),
    FOREIGN KEY(attempt_id,execution_epoch) REFERENCES orch_executions(attempt_id,execution_epoch)
) STRICT;
CREATE INDEX orch_result_receipts_attempt ON orch_result_receipts(attempt_id,created_at);
CREATE TABLE orch_resource_reservations (
    reservation_id TEXT PRIMARY KEY CHECK(length(reservation_id) BETWEEN 1 AND 128),
    attempt_id TEXT NOT NULL REFERENCES orch_executions(attempt_id),
    resource_kind TEXT NOT NULL CHECK(length(resource_kind) BETWEEN 1 AND 64),
    resource_scope TEXT NOT NULL CHECK(length(resource_scope) BETWEEN 1 AND 256),
    state TEXT NOT NULL CHECK(state IN ('held','quarantined','released')),
    release_proof_id TEXT,
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
    FOREIGN KEY(release_proof_id,attempt_id) REFERENCES orch_exit_proofs(id,attempt_id),
    CHECK(state != 'released' OR release_proof_id IS NOT NULL),
    UNIQUE(attempt_id,resource_kind,resource_scope)
) STRICT;
CREATE INDEX orch_resource_reservations_state ON orch_resource_reservations(state,resource_kind,resource_scope);
CREATE TRIGGER orch_reservation_release_proof_insert
BEFORE INSERT ON orch_resource_reservations
WHEN NEW.state='released' AND NOT EXISTS (
    SELECT 1 FROM orch_executions e JOIN orch_exit_proofs p ON p.id=NEW.release_proof_id
    WHERE e.attempt_id=NEW.attempt_id AND e.exit_proof_id=p.id
      AND e.state IN ('quiesced','exit_confirmed','finalized')
      AND p.attempt_id=e.attempt_id AND p.execution_epoch=e.execution_epoch
      AND p.host_id IS e.host_id AND p.host_epoch IS e.host_epoch
      AND p.config_digest=e.config_digest
)
BEGIN
    SELECT RAISE(ABORT,'reservation release requires quiesced execution proof');
END;
CREATE TRIGGER orch_reservation_release_proof_update
BEFORE UPDATE OF state,release_proof_id ON orch_resource_reservations
WHEN NEW.state='released' AND NOT EXISTS (
    SELECT 1 FROM orch_executions e JOIN orch_exit_proofs p ON p.id=NEW.release_proof_id
    WHERE e.attempt_id=NEW.attempt_id AND e.exit_proof_id=p.id
      AND e.state IN ('quiesced','exit_confirmed','finalized')
      AND p.attempt_id=e.attempt_id AND p.execution_epoch=e.execution_epoch
      AND p.host_id IS e.host_id AND p.host_epoch IS e.host_epoch
      AND p.config_digest=e.config_digest
)
BEGIN
    SELECT RAISE(ABORT,'reservation release requires quiesced execution proof');
END;
CREATE TABLE orch_recovery_jobs (
    job_id TEXT PRIMARY KEY CHECK(length(job_id) BETWEEN 1 AND 128),
    kind TEXT NOT NULL CHECK(kind IN ('operation','execution','host','result','reservation','event_gap','legacy_session')),
    object_id TEXT NOT NULL CHECK(length(object_id) BETWEEN 1 AND 128),
    state TEXT NOT NULL CHECK(state IN ('pending','running','manual_required','complete')),
    owner TEXT NOT NULL CHECK(length(owner) BETWEEN 1 AND 128),
    next_check_at INTEGER NOT NULL CHECK(next_check_at >= 0),
    revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
    detail TEXT CHECK(detail IS NULL OR length(CAST(detail AS BLOB)) <= 8192),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
    UNIQUE(kind,object_id)
) STRICT;
CREATE INDEX orch_recovery_jobs_due ON orch_recovery_jobs(state,next_check_at,created_at);
CREATE TRIGGER orch_operation_unknown_recovery_insert
BEFORE INSERT ON orch_operations_v2
WHEN NEW.state='outcome_unknown' AND NOT EXISTS (
    SELECT 1 FROM orch_recovery_jobs WHERE kind='operation' AND object_id=NEW.operation_id
)
BEGIN
    SELECT RAISE(ABORT,'unknown operation requires recovery job');
END;
CREATE TRIGGER orch_operation_unknown_recovery_update
BEFORE UPDATE OF state ON orch_operations_v2
WHEN NEW.state='outcome_unknown' AND NOT EXISTS (
    SELECT 1 FROM orch_recovery_jobs WHERE kind='operation' AND object_id=NEW.operation_id
)
BEGIN
    SELECT RAISE(ABORT,'unknown operation requires recovery job');
END;
CREATE TRIGGER orch_execution_unknown_recovery_insert
BEFORE INSERT ON orch_executions
WHEN NEW.state IN ('start_unknown','stop_unknown','owner_unreachable','manual_required') AND NOT EXISTS (
    SELECT 1 FROM orch_recovery_jobs WHERE kind='execution' AND object_id=NEW.attempt_id
)
BEGIN
    SELECT RAISE(ABORT,'unknown execution requires recovery job');
END;
CREATE TRIGGER orch_execution_unknown_recovery_update
BEFORE UPDATE OF state ON orch_executions
WHEN NEW.state IN ('start_unknown','stop_unknown','owner_unreachable','manual_required') AND NOT EXISTS (
    SELECT 1 FROM orch_recovery_jobs WHERE kind='execution' AND object_id=NEW.attempt_id
)
BEGIN
    SELECT RAISE(ABORT,'unknown execution requires recovery job');
END;
CREATE TABLE orch_host_events (
    host_id TEXT NOT NULL,
    host_epoch TEXT NOT NULL,
    host_event_seq INTEGER NOT NULL CHECK(host_event_seq BETWEEN 1 AND 9007199254740991),
    event_id TEXT NOT NULL CHECK(length(event_id) BETWEEN 1 AND 128),
    event_kind TEXT NOT NULL CHECK(length(event_kind) BETWEEN 1 AND 128),
    attempt_id TEXT REFERENCES orch_executions(attempt_id),
    payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) <= 1048576),
    received_at INTEGER NOT NULL CHECK(received_at >= 0),
    PRIMARY KEY(host_id,host_epoch,host_event_seq),
    UNIQUE(host_id,host_epoch,event_id),
    FOREIGN KEY(host_id,host_epoch) REFERENCES orch_host_registry(host_id,host_epoch)
) STRICT;
CREATE TABLE orch_host_event_cursors (
    host_id TEXT NOT NULL,
    host_epoch TEXT NOT NULL,
    consumer TEXT NOT NULL CHECK(length(consumer) BETWEEN 1 AND 128),
    cursor_seq INTEGER NOT NULL CHECK(cursor_seq BETWEEN 0 AND 9007199254740991),
    updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
    PRIMARY KEY(host_id,host_epoch,consumer),
    FOREIGN KEY(host_id,host_epoch) REFERENCES orch_host_registry(host_id,host_epoch)
) STRICT;
ALTER TABLE agent_runs ADD COLUMN execution_unknown INTEGER NOT NULL DEFAULT 0 CHECK(execution_unknown IN (0,1));
CREATE TRIGGER orch_dispatch_legacy_unknown_insert
BEFORE INSERT ON orch_dispatches
WHEN NEW.state IN ('starting','running') AND EXISTS (
    SELECT 1 FROM orch_dispatches d JOIN agent_runs a ON a.session_id=d.session_id
    WHERE d.task_id=NEW.task_id AND d.id!=NEW.id AND (a.active=1 OR a.execution_unknown=1)
)
BEGIN
    SELECT RAISE(ABORT,'legacy execution exit remains unknown');
END;
CREATE TRIGGER orch_dispatch_legacy_unknown_update
BEFORE UPDATE OF task_id,session_id,state ON orch_dispatches
WHEN NEW.state IN ('starting','running') AND EXISTS (
    SELECT 1 FROM orch_dispatches d JOIN agent_runs a ON a.session_id=d.session_id
    WHERE d.task_id=NEW.task_id AND d.id!=NEW.id AND (a.active=1 OR a.execution_unknown=1)
)
BEGIN
    SELECT RAISE(ABORT,'legacy execution exit remains unknown');
END;
