CREATE TABLE terminal_instances (
    runtime_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES session_heads(id) ON DELETE CASCADE,
    session_payload TEXT NOT NULL,
    snapshot TEXT,
    archived_at INTEGER NOT NULL
) STRICT;
CREATE INDEX terminal_instance_sessions ON terminal_instances(session_id, archived_at);
CREATE TABLE terminal_instance_output (
    runtime_id TEXT NOT NULL REFERENCES terminal_instances(runtime_id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY(runtime_id, seq)
) STRICT;
