-- CreateTable
CREATE TABLE "desktop_commands" (
    "id" UUID NOT NULL,
    "compute_target_id" UUID NOT NULL,
    "idempotency_key" TEXT,
    "request_fingerprint" TEXT NOT NULL,
    "operation_id" TEXT NOT NULL,
    "request_payload" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "last_sequence_acked" INTEGER NOT NULL DEFAULT 0,
    "queued_timeout_ms" INTEGER,
    "running_timeout_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "desktop_commands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "desktop_command_events" (
    "command_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "event_type" TEXT NOT NULL,
    "event_payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "desktop_command_events_pkey" PRIMARY KEY ("command_id","sequence")
);

-- CreateIndex
CREATE INDEX "desktop_commands_compute_target_id_status_created_at_idx" ON "desktop_commands"("compute_target_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "desktop_commands_operation_id_idx" ON "desktop_commands"("operation_id");

-- CreateIndex
CREATE INDEX "desktop_commands_compute_target_id_idempotency_key_idx" ON "desktop_commands"("compute_target_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "desktop_commands_compute_target_id_idempotency_key_key" ON "desktop_commands"("compute_target_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;

-- CreateIndex
CREATE INDEX "desktop_command_events_command_id_created_at_idx" ON "desktop_command_events"("command_id", "created_at");
