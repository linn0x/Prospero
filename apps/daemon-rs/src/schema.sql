CREATE TABLE session_heads (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','archived')),
    revision INTEGER NOT NULL CHECK(revision > 0),
    payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) <= 8192)
) STRICT;
CREATE INDEX session_page ON session_heads(created_at DESC,id DESC);
CREATE INDEX session_lifecycle_page ON session_heads(lifecycle,created_at DESC,id DESC);
CREATE TABLE stream_heads (
    scope TEXT PRIMARY KEY,
    last_seq INTEGER NOT NULL CHECK(last_seq >= 0),
    floor_seq INTEGER NOT NULL CHECK(floor_seq BETWEEN 0 AND last_seq)
) STRICT;
CREATE TABLE change_events (
    scope TEXT NOT NULL REFERENCES stream_heads(scope),
    seq INTEGER NOT NULL CHECK(seq > 0),
    kind TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) <= 16384),
    PRIMARY KEY(scope,seq)
) STRICT;
CREATE TABLE content_heads (
    session_id TEXT NOT NULL REFERENCES session_heads(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    bytes INTEGER NOT NULL CHECK(bytes BETWEEN 0 AND 1073741824),
    PRIMARY KEY(session_id,id)
) STRICT;
CREATE TABLE content_chunks (
    session_id TEXT NOT NULL,
    content_id TEXT NOT NULL,
    offset INTEGER NOT NULL CHECK(offset >= 0),
    body BLOB NOT NULL CHECK(length(body) BETWEEN 1 AND 65536),
    PRIMARY KEY(session_id,content_id,offset),
    FOREIGN KEY(session_id,content_id) REFERENCES content_heads(session_id,id) ON DELETE CASCADE
) STRICT;
