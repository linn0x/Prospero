-- Stage 8: third-party Anthropic-compatible API profiles.
--
-- A managed account may own a non-secret API profile (base URL, model,
-- declared capabilities). The API Key stays in the account's mode-0600
-- credential file and never enters SQLite. The validation row is keyed by a
-- sha256 revision over profile+credential, so a stale probe result can never
-- be displayed after the connection or key changes.
ALTER TABLE managed_accounts ADD COLUMN api_profile TEXT;
ALTER TABLE managed_accounts ADD COLUMN api_validation TEXT;
ALTER TABLE managed_accounts ADD COLUMN api_validation_revision TEXT;
