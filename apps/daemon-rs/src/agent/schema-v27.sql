-- Pin every cross-model task generation to the structured turn that owns its
-- result. This prevents a follow-up that has not produced an answer yet from
-- reusing the previous generation's final answer during crash recovery.
ALTER TABLE cross_model_children ADD COLUMN task_turn INTEGER NOT NULL DEFAULT 1 CHECK(task_turn > 0);
UPDATE cross_model_children
SET task_turn=max(1,coalesce((SELECT turn FROM agent_runs WHERE session_id=child_session_id),1));
