ALTER TABLE managed_accounts ADD COLUMN agent TEXT CHECK(agent IS NULL OR agent IN ('claude','codex','opencode'));
UPDATE managed_accounts
SET agent = CASE
    WHEN api_profile IS NULL THEN 'claude'
    WHEN json_extract(api_profile,'$.protocol') = 'openai_chat_completions' THEN 'opencode'
    WHEN json_extract(api_profile,'$.protocol') = 'openai_responses' THEN 'codex'
    ELSE 'claude'
END;
