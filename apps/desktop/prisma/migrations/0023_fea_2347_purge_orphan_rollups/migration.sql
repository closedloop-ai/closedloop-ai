-- FEA-2347: purge orphaned analytics rollups (desktop, data-only).
--
-- These three tables have no FK/cascade to `sessions`. Before this fix,
-- `deleteSessionRow` left their rows behind, so any session deleted without a
-- following reimport (permanent/phantom purge) orphaned its rollups — inflating
-- aggregates that scan them without a `sessions` join (e.g. the Delivery Cost
-- KPI). The delete paths now clear these rollups; this one-time sweep removes
-- orphans already present in installed databases.

DELETE FROM "session_analytics"
 WHERE "session_id" NOT IN (SELECT "id" FROM "sessions");

DELETE FROM "session_tool_analytics"
 WHERE "session_id" NOT IN (SELECT "id" FROM "sessions");

DELETE FROM "agent_component_session_usage"
 WHERE "session_id" NOT IN (SELECT "id" FROM "sessions");
