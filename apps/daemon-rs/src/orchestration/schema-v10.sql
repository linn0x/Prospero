-- Stage 8 (Electron 接入): worker worktree assets. A worktree is an external
-- resource whose lifetime is independent of the run history: deleting a run
-- cascades its rows but MUST keep the disk directory indexed, so run_id here is
-- a plain value rather than a foreign key.
ALTER TABLE orch_dispatches ADD COLUMN worktree_path TEXT;

CREATE TABLE orch_worktree_assets (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('run','worker')),
    run_id TEXT NOT NULL,
    task_id TEXT,
    dispatch_id TEXT,
    repo TEXT NOT NULL CHECK(length(CAST(repo AS BLOB)) BETWEEN 1 AND 4096),
    path TEXT NOT NULL CHECK(length(CAST(path AS BLOB)) BETWEEN 1 AND 4096),
    branch TEXT CHECK(branch IS NULL OR length(CAST(branch AS BLOB)) <= 256),
    state TEXT NOT NULL CHECK(state IN (
      'active','preserved','missing','dirty','unmerged',
      'equivalent','safe_to_clean','cleaned','unknown'
    )),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
    run_deleted_at INTEGER CHECK(run_deleted_at IS NULL OR run_deleted_at >= 0),
    last_inspection TEXT,
    cleanup TEXT,
    last_error TEXT CHECK(last_error IS NULL OR length(CAST(last_error AS BLOB)) <= 8192)
) STRICT;
CREATE INDEX orch_worktrees_run ON orch_worktree_assets(run_id,created_at);
CREATE INDEX orch_worktrees_state ON orch_worktree_assets(state,created_at);
CREATE UNIQUE INDEX orch_worktrees_path ON orch_worktree_assets(path);
