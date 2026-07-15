-- Cover the global expired-fragment sweep and the compute_targets(id)
-- cascading FK path. The earlier target-scoped cleanup/capacity indexes remain
-- for per-target upload cleanup and quota checks; the org index covers the
-- aggregate organization quota predicate.
CREATE INDEX "pending_agent_session_event_fragments_org_expires_at_idx"
  ON "pending_agent_session_event_fragments" ("organization_id", "expires_at");

CREATE INDEX "pending_agent_session_event_fragments_expires_at_idx"
  ON "pending_agent_session_event_fragments" ("expires_at");

CREATE INDEX "pending_agent_session_event_fragments_compute_target_id_idx"
  ON "pending_agent_session_event_fragments" ("compute_target_id");
