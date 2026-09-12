-- Stage 8 (Electron 接入): managed Claude accounts.
--
-- Managed accounts have isolated CLAUDE_CONFIG_DIR roots and private
-- credentials under the daemon data directory; secrets never enter SQLite.
-- account_id is NULL for the native environment, otherwise the managed row
-- owns the run (FK is enforced in application code because ALTER TABLE cannot
-- add a deferred foreign key on an existing table).
CREATE TABLE managed_accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
    is_default INTEGER NOT NULL CHECK(is_default IN (0,1)),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    updated_at INTEGER NOT NULL CHECK(updated_at >= 0)
) STRICT;
ALTER TABLE agent_runs ADD COLUMN account_id TEXT;
ALTER TABLE terminal_runs ADD COLUMN account_id TEXT;
