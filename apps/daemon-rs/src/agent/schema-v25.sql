-- A fan-in summary is delivered to the parent exactly once after every child
-- in its batch is terminal.
ALTER TABLE cross_model_children ADD COLUMN summary_delivered INTEGER NOT NULL DEFAULT 0 CHECK(summary_delivered IN (0,1));
