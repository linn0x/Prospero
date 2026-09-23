-- Durable one-shot wakeups let a parent ask Prospero to revisit its children
-- after a delay without keeping an agent turn alive. Claimed wakeups use a
-- lease so daemon crashes are retried instead of losing the check.
CREATE TABLE cross_model_checks (
    id TEXT PRIMARY KEY,
    parent_session_id TEXT NOT NULL REFERENCES session_heads(id) ON DELETE CASCADE,
    due_at INTEGER NOT NULL CHECK(due_at >= 0),
    state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','delivered')),
    claimed_at INTEGER CHECK(claimed_at IS NULL OR claimed_at >= 0),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    delivered_at INTEGER CHECK(delivered_at IS NULL OR delivered_at >= 0)
) STRICT;
CREATE INDEX cross_model_checks_due ON cross_model_checks(state,due_at);
