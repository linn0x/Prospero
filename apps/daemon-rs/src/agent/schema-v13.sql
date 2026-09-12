-- Stage 8 (Electron 接入): busy-turn message queue ("排队/引导").
--
-- Messages sent while a turn is running (or waiting for approval/input) wait
-- here instead of being rejected. Rows are drained FIFO by the runtime when
-- the turn ends; steer failures degrade to a front-of-queue 'guide' row.
-- `position` is a synthetic ordering key so front inserts (guide) keep a
-- stable order without rewriting existing rows.
CREATE TABLE agent_message_queue (
    session_id TEXT NOT NULL REFERENCES session_heads(id) ON DELETE CASCADE,
    queue_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'queue' CHECK(kind IN ('queue','guide')),
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(session_id, queue_id)
) STRICT;

CREATE INDEX agent_message_queue_order ON agent_message_queue(session_id, position);
