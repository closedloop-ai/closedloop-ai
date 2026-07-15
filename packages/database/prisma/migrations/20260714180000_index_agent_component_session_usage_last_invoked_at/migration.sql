-- FEA-3160: the Agents-workspace time window filters agent-component usage on
-- `last_invoked_at >= startDate`. The new WHERE predicates (nested
-- `sessionUsages` read, org-scoped child-usage rollup, and orphan-usage read)
-- had no supporting index, forcing a sequential scan on every windowed request.
-- These two additive indexes serve those query shapes:
--   * (last_invoked_at)                — the range-only nested `sessionUsages` read
--   * (component_kind, last_invoked_at) — the `component_kind IN (...)` + range
--                                         child-usage rollup and orphan reads
-- Purely additive (index-only, no data mutation); generated offline via
-- `prisma migrate diff` (no local DB in this env), applied by
-- `prisma migrate deploy` in CI/prod.

-- CreateIndex
CREATE INDEX "agent_component_session_usage_last_invoked_at_idx" ON "agent_component_session_usage"("last_invoked_at");

-- CreateIndex
CREATE INDEX "agent_component_session_usage_component_kind_last_invoked_a_idx" ON "agent_component_session_usage"("component_kind", "last_invoked_at");
