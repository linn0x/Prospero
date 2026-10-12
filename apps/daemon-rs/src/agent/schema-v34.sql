UPDATE session_heads
SET payload = json_patch(payload, (
    SELECT json_object('accountId', COALESCE(account_id, CASE agent WHEN 'codex' THEN 'native-codex' WHEN 'claude' THEN 'native-claude' END), 'model', model, 'effort', effort,
        'approvalPolicy', CASE approval_policy WHEN 'auto' THEN 'yolo' ELSE 'standard' END)
    FROM agent_runs WHERE session_id = session_heads.id
))
WHERE EXISTS (SELECT 1 FROM agent_runs WHERE session_id = session_heads.id);

UPDATE session_heads
SET payload = json_patch(payload, (
    SELECT json_object('accountId', account_id)
    FROM terminal_runs WHERE session_id = session_heads.id
))
WHERE EXISTS (SELECT 1 FROM terminal_runs WHERE session_id = session_heads.id);
