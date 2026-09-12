-- Stage 8 (Electron 接入): Claude Task-tool subagent visibility.
--
-- One row per subagent known in an agent session. Timeline records belonging
-- to a subagent carry `subagent_id` (kept out of the session's main timeline)
-- so the "查看执行详情" pane can render a faithful transcript while the main
-- chat only shows a single collapsing subagent card.
ALTER TABLE timeline_records ADD COLUMN subagent_id TEXT;

CREATE TABLE agent_subagents (
    session_id TEXT NOT NULL REFERENCES session_heads(id) ON DELETE CASCADE,
    subagent_id TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT,
    task TEXT,
    status TEXT NOT NULL DEFAULT 'starting'
        CHECK(status IN ('starting','running','idle','completed','failed','stopped')),
    can_message INTEGER NOT NULL DEFAULT 1 CHECK(can_message IN (0,1)),
    summary TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(session_id, subagent_id)
) STRICT;
