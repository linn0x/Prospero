-- Stage 8 (Electron 接入): per-session Claude collaboration mode. The headless
-- CLI is spawned per turn, so the selected mode is persisted here and applied
-- as `--permission-mode` on the next turn's process.
ALTER TABLE agent_runs ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'default'
    CHECK(permission_mode IN ('default','plan'));
