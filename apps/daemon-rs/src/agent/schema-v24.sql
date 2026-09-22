-- Cross-model child agents are independent structured sessions.  The parent
-- link is durable so a completed child can report its final summary back to
-- the parent timeline even after the desktop renderer reconnects.
CREATE TABLE cross_model_children (
    child_session_id TEXT PRIMARY KEY REFERENCES session_heads(id) ON DELETE CASCADE,
    parent_session_id TEXT NOT NULL REFERENCES session_heads(id) ON DELETE CASCADE,
    task TEXT NOT NULL CHECK(length(CAST(task AS BLOB)) BETWEEN 1 AND 65536),
    source_id TEXT NOT NULL,
    route_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('starting','running','completed','failed','stopped')),
    result TEXT CHECK(result IS NULL OR length(CAST(result AS BLOB)) <= 65536),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    updated_at INTEGER NOT NULL CHECK(updated_at >= 0)
) STRICT;
CREATE INDEX cross_model_children_parent ON cross_model_children(parent_session_id, created_at DESC);
