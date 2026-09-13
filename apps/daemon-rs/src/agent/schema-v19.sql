-- Stage 8 (Electron 接入): allow native Codex structured sessions to share
-- the agent_runs table with Claude. SQLite cannot alter a CHECK constraint in
-- place, so rebuild the table with the widened agent enum.
CREATE TABLE agent_runs_v19 (
    session_id TEXT PRIMARY KEY REFERENCES session_heads(id) ON DELETE CASCADE,
    agent TEXT NOT NULL CHECK(agent IN ('claude','codex')),
    active INTEGER NOT NULL CHECK(active IN (0,1)),
    approval_policy TEXT NOT NULL CHECK(approval_policy IN ('manual','auto')),
    turn INTEGER NOT NULL DEFAULT 0 CHECK(turn >= 0),
    native_id TEXT CHECK(native_id IS NULL OR length(native_id) <= 256),
    permission_mode TEXT NOT NULL DEFAULT 'default' CHECK(permission_mode IN ('default','plan')),
    model TEXT,
    effort TEXT,
    account_id TEXT
) STRICT;
INSERT INTO agent_runs_v19(session_id,agent,active,approval_policy,turn,native_id,permission_mode,model,effort,account_id)
    SELECT session_id,agent,active,approval_policy,turn,native_id,permission_mode,model,effort,account_id FROM agent_runs;
DROP TABLE agent_runs;
ALTER TABLE agent_runs_v19 RENAME TO agent_runs;
CREATE INDEX agent_active ON agent_runs(session_id) WHERE active=1;
