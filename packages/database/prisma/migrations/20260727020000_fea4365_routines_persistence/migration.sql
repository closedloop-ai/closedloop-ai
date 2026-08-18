-- CreateEnum
CREATE TYPE "RoutineProvider" AS ENUM ('CLAUDE', 'CODEX', 'OPENCODE');

-- CreateEnum
CREATE TYPE "RoutineRunsOn" AS ENUM ('LOCAL', 'CLOUD');

-- CreateEnum
CREATE TYPE "RoutineOrigin" AS ENUM ('CREATED', 'DISCOVERED');

-- CreateEnum
CREATE TYPE "RoutineStatus" AS ENUM ('ACTIVE', 'PAUSED', 'DRAFT');

-- CreateEnum
CREATE TYPE "RoutineScheduleKind" AS ENUM ('MANUAL', 'HOURLY', 'DAILY', 'WEEKDAYS', 'WEEKLY', 'CUSTOM');

-- CreateEnum
CREATE TYPE "RoutineNotifyMode" AS ENUM ('ALL_RUNS', 'FAILED_RUNS_ONLY');

-- CreateEnum
CREATE TYPE "RoutineRunsIn" AS ENUM ('NEW_CHAT', 'EXISTING_CHAT');

-- CreateEnum
CREATE TYPE "RoutineRunStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCESS', 'FAILED', 'SKIPPED', 'TIMEOUT', 'CANCELED');

-- CreateEnum
CREATE TYPE "RoutineComponentKind" AS ENUM ('SUBAGENT', 'COMMAND', 'SKILL');

-- CreateTable
CREATE TABLE "routines" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "team_id" UUID,
    "source_id" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "instructions" TEXT NOT NULL DEFAULT '',
    "owner_id" UUID,
    "owner_name" TEXT,
    "provider" "RoutineProvider" NOT NULL,
    "model_id" TEXT NOT NULL,
    "runs_on" "RoutineRunsOn" NOT NULL DEFAULT 'LOCAL',
    "origin" "RoutineOrigin" NOT NULL DEFAULT 'CREATED',
    "status" "RoutineStatus" NOT NULL DEFAULT 'DRAFT',
    "schedule_kind" "RoutineScheduleKind" NOT NULL DEFAULT 'MANUAL',
    "schedule_detail" TEXT NOT NULL DEFAULT '',
    "cron" TEXT,
    "timezone" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "notify_mode" "RoutineNotifyMode" NOT NULL DEFAULT 'ALL_RUNS',
    "folder_or_repo" TEXT,
    "project" TEXT,
    "runs_in" "RoutineRunsIn",
    "host_machine" TEXT,
    "connector_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "auto_fix_pull_requests" BOOLEAN NOT NULL DEFAULT false,
    "permission_mode" TEXT,
    "reasoning_effort" TEXT,
    "worktree" BOOLEAN NOT NULL DEFAULT false,
    "route" TEXT,
    "harness_cascade" JSONB NOT NULL DEFAULT '[]',
    "catch_up" BOOLEAN NOT NULL DEFAULT true,
    "recurring" BOOLEAN NOT NULL DEFAULT true,
    "durable" BOOLEAN NOT NULL DEFAULT true,
    "pass_kind" TEXT,
    "pass" TEXT,
    "crew" TEXT NOT NULL DEFAULT '',
    "meta" JSONB NOT NULL DEFAULT '{}',
    "next_run_at" TIMESTAMP(3),
    "last_run_at" TIMESTAMP(3),
    "last_run_id" UUID,
    "last_status" "RoutineRunStatus",
    "last_run_session_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "routines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "routine_runs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "routine_id" UUID NOT NULL,
    "source_run_id" TEXT,
    "task_name" TEXT,
    "status" "RoutineRunStatus" NOT NULL DEFAULT 'PENDING',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "provider" "RoutineProvider",
    "model_id" TEXT,
    "summary" TEXT NOT NULL DEFAULT '',
    "error" TEXT,
    "log_path" TEXT,
    "session_id" TEXT,
    "session_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "invoked_components" JSONB NOT NULL DEFAULT '[]',
    "attempts" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "routine_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "routines_organization_id_source_id_key" ON "routines"("organization_id", "source_id");

-- CreateIndex
CREATE UNIQUE INDEX "routine_runs_organization_id_source_run_id_key" ON "routine_runs"("organization_id", "source_run_id");

-- CreateIndex
CREATE INDEX "routines_organization_id_updated_at_idx" ON "routines"("organization_id", "updated_at");

-- CreateIndex
CREATE INDEX "routines_organization_id_team_id_updated_at_idx" ON "routines"("organization_id", "team_id", "updated_at");

-- CreateIndex
CREATE INDEX "routines_organization_id_status_idx" ON "routines"("organization_id", "status");

-- CreateIndex
CREATE INDEX "routine_runs_routine_id_started_at_idx" ON "routine_runs"("routine_id", "started_at");

-- CreateIndex
CREATE INDEX "routine_runs_organization_id_started_at_idx" ON "routine_runs"("organization_id", "started_at");

-- AddForeignKey
ALTER TABLE "routines" ADD CONSTRAINT "routines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routines" ADD CONSTRAINT "routines_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routines" ADD CONSTRAINT "routines_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_routine_id_fkey" FOREIGN KEY ("routine_id") REFERENCES "routines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
