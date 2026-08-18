-- FEA-3813 (PRD-553 M1): desktop-local host for the crewd (@repo/crewd)
-- scheduler. Two tables mirror the crewd Zod `ScheduledTask` / `RunRecord`
-- shapes — the durable copy of what the in-memory `SqliteTaskStore` (StorePort)
-- holds, so tasks and run-history survive a restart. These are NOT a new source
-- of truth; the crewd model is. Enum-ish columns (`kind`, `status`,
-- `last_status`) are free TEXT: the crewd Zod schemas (passKindSchema /
-- runStatusSchema) validate them, so adding a pass kind or run status is a crewd
-- change, never a desktop migration. `harness_cascade` / `meta` / `attempts` are
-- JSON strings (the crewd model serializes them that way). Timestamps are TEXT
-- ISO-8601, matching every other desktop table. Runs cascade-delete with their
-- task. Additive. The DDL is `IF NOT EXISTS` (matching every other desktop
-- CREATE migration) so the baseline-adoption heal path can re-apply it over an
-- untracked/partial store without a `table already exists` abort; the
-- prisma-migrations-agreement guard compares the resulting schema snapshot, not
-- raw SQL bytes, so `IF NOT EXISTS` stays in agreement with schema.prisma.

-- CreateTable
CREATE TABLE IF NOT EXISTS "scheduled_tasks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "cron" TEXT NOT NULL,
    "prompt" TEXT NOT NULL DEFAULT '',
    "recurring" BOOLEAN NOT NULL DEFAULT true,
    "durable" BOOLEAN NOT NULL DEFAULT true,
    "crew" TEXT NOT NULL DEFAULT '',
    "kind" TEXT NOT NULL DEFAULT 'custom',
    "pass" TEXT,
    "harness_cascade" TEXT NOT NULL DEFAULT '[]',
    "timezone" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "catch_up" BOOLEAN NOT NULL DEFAULT true,
    "meta" TEXT NOT NULL DEFAULT '{}',
    "next_run_at" TEXT,
    "last_run_at" TEXT,
    "last_run_id" TEXT,
    "last_status" TEXT,
    "created_at" TEXT NOT NULL,
    "updated_at" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "scheduled_task_runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "task_id" TEXT NOT NULL,
    "task_name" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL,
    "started_at" TEXT NOT NULL,
    "finished_at" TEXT,
    "harness_used" TEXT,
    "attempts" TEXT NOT NULL DEFAULT '[]',
    "summary" TEXT NOT NULL DEFAULT '',
    "log_path" TEXT,
    "error" TEXT,
    CONSTRAINT "scheduled_task_runs_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "scheduled_tasks" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_scheduled_tasks_enabled" ON "scheduled_tasks"("enabled");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_scheduled_task_runs_task_started" ON "scheduled_task_runs"("task_id", "started_at" DESC);
