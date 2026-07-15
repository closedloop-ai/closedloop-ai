-- FEA-2990: per-event git_branch attribution for agent-component usage.
--
-- Additive + non-destructive: the new column defaults to '' so every existing
-- row keeps its identity under the widened natural key, and older desktop
-- builds that omit the field continue upserting into the single session-level
-- bucket exactly as before. When per-event branch data IS present, a session
-- that switched branches mid-run persists one row per (component, branch).

-- 1) New column with the '' ("no per-event branch") sentinel default so the
--    backfill of existing rows is implicit and the widened unique key below can
--    include a NOT NULL column.
ALTER TABLE "agent_component_session_usage"
  ADD COLUMN "git_branch" TEXT NOT NULL DEFAULT '';

-- 2) Swap the natural-key unique index to include git_branch. The old 3-column
--    index is Prisma's auto-generated one from migration 20260711005000, which
--    Postgres already truncated to 63 bytes on CREATE, landing on the exact
--    on-disk name below (..._component_ki_key, ending "_ki_key"). The DROP must
--    use that truncated 63-byte name verbatim: passing the full untruncated
--    string here would itself truncate to a DIFFERENT 63-byte name and silently
--    no-op under IF EXISTS, leaving the old unique index behind (schema-drift).
--    The new index is explicitly named (schema @@unique map) so it stays stable
--    and can't collide on truncation.
DROP INDEX IF EXISTS "agent_component_session_usage_agent_session_id_component_ki_key";

CREATE UNIQUE INDEX "idx_acsu_session_kind_key_branch"
  ON "agent_component_session_usage"("agent_session_id", "component_kind", "component_key", "git_branch");
