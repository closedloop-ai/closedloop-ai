ALTER TABLE agent_component_invocations ADD COLUMN duration_ms INTEGER CHECK (duration_ms IS NULL OR (typeof(duration_ms) = 'integer' AND duration_ms >= 0 AND duration_ms <= 9007199254740991));
ALTER TABLE agent_component_invocations ADD COLUMN duration_ambiguous BOOLEAN NOT NULL DEFAULT 0 CHECK (duration_ambiguous IN (0, 1));
