-- CreateEnum
CREATE TYPE "LoopStatus" AS ENUM ('PENDING', 'CLAIMED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT');

-- CreateEnum
CREATE TYPE "LoopCommand" AS ENUM ('PLAN', 'EXECUTE', 'CHAT', 'EXPLORE', 'REQUEST_CHANGES');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "anthropic_api_key" TEXT;

-- CreateTable
CREATE TABLE "loops" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "LoopStatus" NOT NULL DEFAULT 'PENDING',
    "command" "LoopCommand" NOT NULL,
    "artifact_id" UUID,
    "workstream_id" UUID,
    "parent_loop_id" UUID,
    "prompt" TEXT,
    "repo" JSONB,
    "context_refs" JSONB,
    "container_id" TEXT,
    "s3_state_key" TEXT,
    "tokens_input" INTEGER NOT NULL DEFAULT 0,
    "tokens_output" INTEGER NOT NULL DEFAULT 0,
    "estimated_cost" DECIMAL(10,6),
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "error" JSONB,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "loops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loop_events" (
    "id" UUID NOT NULL,
    "loop_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loop_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "loops_organization_id_status_idx" ON "loops"("organization_id", "status");

-- CreateIndex
CREATE INDEX "loops_organization_id_user_id_created_at_idx" ON "loops"("organization_id", "user_id", "created_at");

-- CreateIndex
CREATE INDEX "loops_artifact_id_idx" ON "loops"("artifact_id");

-- CreateIndex
CREATE INDEX "loops_workstream_id_idx" ON "loops"("workstream_id");

-- CreateIndex
CREATE INDEX "loops_parent_loop_id_idx" ON "loops"("parent_loop_id");

-- CreateIndex
CREATE INDEX "loop_events_loop_id_created_at_idx" ON "loop_events"("loop_id", "created_at");

-- CreateIndex
CREATE INDEX "loop_events_loop_id_type_idx" ON "loop_events"("loop_id", "type");
