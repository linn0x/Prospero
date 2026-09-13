-- Stage 8: persisted API profile native-engine validation.
--
-- Stored separately from the direct protocol probe because the engine check
-- exercises a different path and must be invalidated independently when the
-- profile or credential revision changes.
ALTER TABLE managed_accounts ADD COLUMN api_engine_validation TEXT;
ALTER TABLE managed_accounts ADD COLUMN api_engine_validation_revision TEXT;
