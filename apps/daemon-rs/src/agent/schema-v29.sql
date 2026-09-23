ALTER TABLE cross_model_children ADD COLUMN summary_delivered_at INTEGER CHECK(summary_delivered_at IS NULL OR summary_delivered_at >= 0);
ALTER TABLE cross_model_children ADD COLUMN summary_acknowledged INTEGER NOT NULL DEFAULT 0 CHECK(summary_acknowledged IN (0,1));
ALTER TABLE cross_model_children ADD COLUMN summary_acknowledged_at INTEGER CHECK(summary_acknowledged_at IS NULL OR summary_acknowledged_at >= 0);
