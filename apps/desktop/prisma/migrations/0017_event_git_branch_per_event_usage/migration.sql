-- FEA-2990: per-event git_branch attribution for agent-component usage.
--
-- Additive; existing installs apply only this migration. No durable data is
-- lost: the one rebuilt table (agent_component_session_usage) has its existing
-- rows carried over into the '' (no-branch) bucket below, so upgraded installs
-- keep their component usage/analytics rollup intact.

-- 1) events.git_branch — the working branch the tool ran on, carried from
--    NormalizedToolUse.gitBranch at import. Nullable; null for Codex and for
--    legacy events that predate this column (they keep session-level
--    attribution). ADD COLUMN is a metadata-only op in SQLite.
ALTER TABLE "events" ADD COLUMN "git_branch" TEXT;

-- 2) agent_component_session_usage — add git_branch to the composite PK so a
--    single session that switches branches mid-run produces one usage row per
--    (component, branch). SQLite cannot ALTER a PRIMARY KEY, so rebuild the
--    table with the new key.
--
--    IMPORTANT — preserve existing rows. This rollup is normally rematerialized
--    per-session at import (rebuildComponentSessionUsage), but on upgrade the
--    boot-maintenance chain does NOT re-run it and DATA_REVISION is unchanged,
--    so already-imported sessions are never re-imported. A bare drop+recreate
--    would therefore leave existing installs with an EMPTY rollup — historical
--    component dashboards and sync payloads would silently lose all usage until
--    each transcript happens to be reimported. So we rename the old table,
--    create the new one, and copy every existing row into the '' (no-branch)
--    bucket — '' is the "no branch" sentinel (SQLite PK columns are NOT NULL),
--    which is exactly what a re-import would assign to pre-FEA-2990 events.
ALTER TABLE "agent_component_session_usage" RENAME TO "agent_component_session_usage_old";

CREATE TABLE "agent_component_session_usage" (
    "session_id" TEXT NOT NULL,
    "component_kind" TEXT NOT NULL,
    "component_key" TEXT NOT NULL,
    "git_branch" TEXT NOT NULL DEFAULT '',
    "agent_component_id" TEXT,
    "harness" TEXT,
    "invocations" INTEGER NOT NULL DEFAULT 0,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "first_invoked_at" TEXT,
    "last_invoked_at" TEXT,
    "started_day" TEXT,

    PRIMARY KEY ("session_id", "component_kind", "component_key", "git_branch")
);

-- Backfill: carry every pre-existing row into the '' branch bucket so upgraded
-- installs retain their historical component usage. This matches the sentinel a
-- re-import would assign, so a later reimport of the same session is a no-op
-- overwrite (DELETE-then-INSERT keyed on the same '' bucket), never a duplicate.
INSERT INTO "agent_component_session_usage" (
    "session_id", "component_kind", "component_key", "git_branch",
    "agent_component_id", "harness", "invocations", "error_count",
    "first_invoked_at", "last_invoked_at", "started_day"
)
SELECT
    "session_id", "component_kind", "component_key", '',
    "agent_component_id", "harness", "invocations", "error_count",
    "first_invoked_at", "last_invoked_at", "started_day"
FROM "agent_component_session_usage_old";

DROP TABLE "agent_component_session_usage_old";

-- CreateIndex (re-created to match the recreated table)
CREATE INDEX IF NOT EXISTS "idx_acsu_kind_key" ON "agent_component_session_usage"("component_kind", "component_key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_acsu_component" ON "agent_component_session_usage"("agent_component_id") WHERE agent_component_id IS NOT NULL;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_acsu_day" ON "agent_component_session_usage"("started_day");
