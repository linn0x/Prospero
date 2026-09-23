-- Each reuse of a cross-model child advances its task generation. Fan-in
-- delivery claims carry this value so a failed older delivery cannot reopen a
-- newer, already-delivered follow-up result.
ALTER TABLE cross_model_children ADD COLUMN task_generation INTEGER NOT NULL DEFAULT 1 CHECK(task_generation > 0);
