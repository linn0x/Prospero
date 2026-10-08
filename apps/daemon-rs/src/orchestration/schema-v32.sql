CREATE TABLE timeline_checkpoints (
    session_id TEXT PRIMARY KEY REFERENCES session_heads(id) ON DELETE CASCADE,
    last_output_at INTEGER CHECK(last_output_at IS NULL OR last_output_at >= 0),
    last_progress_at INTEGER CHECK(last_progress_at IS NULL OR last_progress_at >= 0)
) STRICT;
