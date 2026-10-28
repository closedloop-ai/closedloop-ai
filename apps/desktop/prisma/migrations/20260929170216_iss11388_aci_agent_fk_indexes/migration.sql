-- ISS-11388: index the child side of the two foreign keys that point at `agents`.
--
-- `agent_component_invocations.agent_id` and `.parent_agent_id` reference
-- `agents(id)` ON DELETE SET NULL (migration 0034), and no index leads on either
-- column. SQLite resolves a parent-row delete by looking the children up, so
-- without these indexes every deleted `agents` row full-scans
-- agent_component_invocations four times (the constraint check and the SET NULL
-- action, once per FK). The importer deletes every subagent row of a session on
-- each re-import (`importPhaseEvents`), so that group's cost grew with
-- subagents x invocation-table size: 100 subagent deletes took 172.6 s against a
-- 326 MB invocation table, and 0.007 s with these indexes.
--
-- Partial on NOT NULL: a child lookup is `agent_id = ?`, which implies it, and
-- the NULL rows (never linked, or already set null) cannot match a parent.
CREATE INDEX IF NOT EXISTS "idx_aci_agent_id" ON "agent_component_invocations"("agent_id") WHERE agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_aci_parent_agent_id" ON "agent_component_invocations"("parent_agent_id") WHERE parent_agent_id IS NOT NULL;
