-- The health monitor resolves durable worker ownership and excludes shared
-- live sessions every five seconds. These lookups must remain indexed as the
-- worker-start ledger and dispatch history grow.
CREATE INDEX orch_worker_starts_dispatch_owner
    ON orch_worker_starts(dispatch_id,session_id,task_id)
    WHERE dispatch_id IS NOT NULL;
CREATE INDEX orch_dispatch_active_session
    ON orch_dispatches(session_id)
    WHERE state IN ('starting','running');

-- Pending cross-model checks are inspected by parent session during the same
-- health pass; the due-time index does not cover that lookup.
CREATE INDEX cross_model_checks_parent_state
    ON cross_model_checks(parent_session_id,state,due_at);
