-- Stage 8 (Electron 接入): launch model/effort selection on agent sessions.
--
-- The choice is made at session creation (desktop launch dialog catalog) and
-- applied as `--model` / `--effort` on every chained CLI turn, mirroring the
-- legacy adapter's persisted selectedModel/selectedEffort.
ALTER TABLE agent_runs ADD COLUMN model TEXT;
ALTER TABLE agent_runs ADD COLUMN effort TEXT;
