CREATE TABLE agent_runs_v22 (
    session_id TEXT PRIMARY KEY REFERENCES session_heads(id) ON DELETE CASCADE,
    agent TEXT NOT NULL CHECK(agent IN ('claude','codex','deepseek','opencode')),
    active INTEGER NOT NULL CHECK(active IN (0,1)),
    approval_policy TEXT NOT NULL CHECK(approval_policy IN ('manual','auto')),
    turn INTEGER NOT NULL DEFAULT 0 CHECK(turn >= 0),
    native_id TEXT CHECK(native_id IS NULL OR length(native_id) <= 256),
    permission_mode TEXT NOT NULL DEFAULT 'default' CHECK(permission_mode IN ('default','plan')),
    model TEXT,
    effort TEXT,
    account_id TEXT,
    agent_preset TEXT
) STRICT;
INSERT INTO agent_runs_v22(session_id,agent,active,approval_policy,turn,native_id,permission_mode,model,effort,account_id,agent_preset)
    SELECT session_id,agent,active,approval_policy,turn,native_id,permission_mode,model,effort,account_id,agent_preset FROM agent_runs;
DROP TABLE agent_runs;
ALTER TABLE agent_runs_v22 RENAME TO agent_runs;
CREATE INDEX agent_active ON agent_runs(session_id) WHERE active=1;
