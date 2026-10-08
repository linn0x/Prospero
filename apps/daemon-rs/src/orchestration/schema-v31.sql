CREATE TABLE orch_worker_starts (
    operation_id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL CHECK(length(CAST(fingerprint AS BLOB)) BETWEEN 1 AND 4096),
    request TEXT NOT NULL CHECK(length(CAST(request AS BLOB)) BETWEEN 1 AND 65536),
    phase TEXT NOT NULL CHECK(phase IN (
      'queued','preparing','worktree_created','session_created',
      'dispatch_committed','delivering','delivery_unknown','running','failed','cancelled'
    )),
    task_id TEXT NOT NULL CHECK(length(task_id) BETWEEN 1 AND 128),
    run_id TEXT NOT NULL CHECK(length(run_id) BETWEEN 1 AND 128),
    agent TEXT NOT NULL CHECK(length(agent) BETWEEN 1 AND 64),
    account_scope TEXT NOT NULL CHECK(length(account_scope) BETWEEN 1 AND 128),
    plugin_scope TEXT NOT NULL CHECK(length(plugin_scope) BETWEEN 1 AND 128),
    profile_scope TEXT NOT NULL CHECK(length(profile_scope) BETWEEN 1 AND 128),
    ticket INTEGER NOT NULL UNIQUE CHECK(ticket >= 0),
    worktree_repo TEXT,
    worktree_path TEXT,
    worktree_branch TEXT,
    asset_id TEXT,
    session_id TEXT,
    dispatch_id TEXT,
    result TEXT CHECK(result IS NULL OR length(CAST(result AS BLOB)) <= 2097152),
    error TEXT CHECK(error IS NULL OR length(CAST(error AS BLOB)) <= 8192),
    error_code TEXT CHECK(error_code IS NULL OR length(error_code) BETWEEN 1 AND 128),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    updated_at INTEGER NOT NULL CHECK(updated_at >= 0)
) STRICT;
CREATE INDEX orch_worker_starts_queue ON orch_worker_starts(phase,ticket);
CREATE INDEX orch_worker_starts_scope ON orch_worker_starts(phase,agent,account_scope,plugin_scope,profile_scope,run_id);
CREATE UNIQUE INDEX orch_worker_start_task_active ON orch_worker_starts(task_id)
WHERE phase IN ('queued','preparing','worktree_created','session_created','dispatch_committed','delivering');
