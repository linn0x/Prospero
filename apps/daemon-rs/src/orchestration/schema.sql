-- Stage 7: DAG orchestration. Readiness is *derived* (pending task whose deps
-- are all 'done'); there is deliberately no ready column to go stale. The
-- anti-join in list_ready_tasks is served by orch_deps_dep, so settling one
-- task never scans the whole graph.
CREATE TABLE orch_runs (
    id TEXT PRIMARY KEY,
    objective TEXT NOT NULL CHECK(length(CAST(objective AS BLOB)) BETWEEN 1 AND 4096),
    status TEXT NOT NULL CHECK(status IN ('active','completed','abandoned')),
    coordinator_session_id TEXT CHECK(coordinator_session_id IS NULL OR length(coordinator_session_id) <= 128),
    automation TEXT CHECK(automation IS NULL OR length(CAST(automation AS BLOB)) <= 32768),
    graph_revision INTEGER NOT NULL CHECK(graph_revision >= 0),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    updated_at INTEGER NOT NULL CHECK(updated_at >= 0)
) STRICT;
CREATE INDEX orch_runs_created ON orch_runs(created_at DESC,id DESC);
CREATE TABLE orch_tasks (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES orch_runs(id) ON DELETE CASCADE,
    title TEXT NOT NULL CHECK(length(CAST(title AS BLOB)) BETWEEN 1 AND 1024),
    spec TEXT NOT NULL CHECK(length(CAST(spec AS BLOB)) BETWEEN 1 AND 8192),
    skills TEXT NOT NULL DEFAULT '[]',
    parent_id TEXT REFERENCES orch_tasks(id),
    status TEXT NOT NULL CHECK(status IN ('pending','dispatched','blocked','done','failed','cancelled')),
    result TEXT CHECK(result IS NULL OR length(CAST(result AS BLOB)) <= 8192),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    updated_at INTEGER NOT NULL CHECK(updated_at >= 0)
) STRICT;
CREATE INDEX orch_tasks_run ON orch_tasks(run_id,created_at,id);
CREATE INDEX orch_tasks_status ON orch_tasks(run_id,status);
CREATE TABLE orch_task_deps (
    run_id TEXT NOT NULL REFERENCES orch_runs(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL REFERENCES orch_tasks(id) ON DELETE CASCADE,
    dep_id TEXT NOT NULL REFERENCES orch_tasks(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK(position >= 0),
    PRIMARY KEY(run_id,task_id,dep_id)
) STRICT;
-- Reverse edge index: when one task settles only its dependents' rows are read.
CREATE INDEX orch_deps_dep ON orch_task_deps(run_id,dep_id,task_id);
CREATE TABLE orch_dispatches (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES orch_runs(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL REFERENCES orch_tasks(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 128),
    state TEXT NOT NULL CHECK(state IN ('starting','running','succeeded','failed','abandoned')),
    outcome TEXT CHECK(outcome IS NULL OR length(CAST(outcome AS BLOB)) <= 8192),
    started_at INTEGER NOT NULL CHECK(started_at >= 0),
    settled_at INTEGER CHECK(settled_at IS NULL OR settled_at >= 0)
) STRICT;
CREATE INDEX orch_dispatch_run ON orch_dispatches(run_id,started_at);
CREATE INDEX orch_dispatch_task ON orch_dispatches(task_id,started_at);
-- Hard guarantee of "不重复派发": at most one live dispatch per task, enforced
-- by the database even if two writers race.
CREATE UNIQUE INDEX orch_dispatch_active
    ON orch_dispatches(task_id) WHERE state IN ('starting','running');
CREATE TABLE orch_gates (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES orch_runs(id) ON DELETE CASCADE,
    task_id TEXT REFERENCES orch_tasks(id) ON DELETE CASCADE,
    question TEXT NOT NULL CHECK(length(CAST(question AS BLOB)) BETWEEN 1 AND 4096),
    options TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL CHECK(status IN ('pending','resolved','cancelled')),
    decision TEXT CHECK(decision IS NULL OR length(CAST(decision AS BLOB)) <= 4096),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    resolved_at INTEGER CHECK(resolved_at IS NULL OR resolved_at >= 0)
) STRICT;
CREATE INDEX orch_gates_run ON orch_gates(run_id,created_at);
CREATE INDEX orch_gates_pending ON orch_gates(run_id,task_id) WHERE status='pending';
-- Idempotency ledger for retried control calls (worker dispatch in particular).
CREATE TABLE orch_operations (
    id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL CHECK(length(CAST(fingerprint AS BLOB)) BETWEEN 1 AND 4096),
    -- The frozen replay of a graph create can carry a full 200-node result;
    -- bound it generously rather than truncating an idempotent replay.
    result TEXT NOT NULL CHECK(length(CAST(result AS BLOB)) <= 2097152),
    created_at INTEGER NOT NULL CHECK(created_at >= 0)
) STRICT;
-- Collaboration messages (note/ask/reply/report); ask/reply pair by thread.
CREATE TABLE orch_messages (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES orch_runs(id) ON DELETE CASCADE,
    sender TEXT NOT NULL CHECK(length(CAST(sender AS BLOB)) BETWEEN 1 AND 128),
    recipient TEXT NOT NULL CHECK(length(CAST(recipient AS BLOB)) BETWEEN 1 AND 128),
    kind TEXT NOT NULL CHECK(kind IN ('note','ask','reply','report')),
    subject TEXT NOT NULL CHECK(length(CAST(subject AS BLOB)) BETWEEN 1 AND 1024),
    body TEXT NOT NULL CHECK(length(CAST(body AS BLOB)) BETWEEN 1 AND 8192),
    thread_id TEXT CHECK(thread_id IS NULL OR length(thread_id) <= 128),
    task_id TEXT CHECK(task_id IS NULL OR length(task_id) <= 128),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    read_at INTEGER CHECK(read_at IS NULL OR read_at >= 0),
    answered_at INTEGER CHECK(answered_at IS NULL OR answered_at >= 0)
) STRICT;
CREATE INDEX orch_messages_run ON orch_messages(run_id,created_at);
CREATE INDEX orch_messages_unread ON orch_messages(recipient,run_id) WHERE read_at IS NULL;
