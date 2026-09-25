-- Fan-in delivery is a two-phase operation for structured parents. A terminal
-- child is first reserved by a durable claim; busy parents keep that claim on
-- the queued message, and only mark the summary delivered once the queue row
-- actually starts a parent turn.
ALTER TABLE cross_model_children ADD COLUMN summary_claim_id TEXT CHECK(summary_claim_id IS NULL OR length(CAST(summary_claim_id AS BLOB)) BETWEEN 1 AND 128);
ALTER TABLE cross_model_children ADD COLUMN summary_claimed_at INTEGER CHECK(summary_claimed_at IS NULL OR summary_claimed_at >= 0);

ALTER TABLE agent_message_queue ADD COLUMN cross_model_claim_id TEXT CHECK(cross_model_claim_id IS NULL OR length(CAST(cross_model_claim_id AS BLOB)) BETWEEN 1 AND 128);
CREATE UNIQUE INDEX agent_message_queue_cross_model_claim ON agent_message_queue(cross_model_claim_id) WHERE cross_model_claim_id IS NOT NULL;
CREATE INDEX cross_model_children_claim ON cross_model_children(summary_claim_id) WHERE summary_claim_id IS NOT NULL;
