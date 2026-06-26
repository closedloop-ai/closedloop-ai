-- CreateTable
CREATE TABLE "loop_execution_credential_consumptions" (
    "command_id" UUID NOT NULL,
    "loop_id" UUID NOT NULL,
    "compute_target_id" UUID NOT NULL,
    "gateway_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "consumed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loop_execution_credential_consumptions_pkey" PRIMARY KEY ("command_id")
);

-- CreateIndex
CREATE INDEX "loop_execution_credential_consumptions_loop_id_idx" ON "loop_execution_credential_consumptions"("loop_id");

-- CreateIndex
CREATE INDEX "loop_execution_credential_consumptions_compute_target_id_gateway_id_idx" ON "loop_execution_credential_consumptions"("compute_target_id", "gateway_id");

-- AddForeignKey
ALTER TABLE "loop_execution_credential_consumptions" ADD CONSTRAINT "loop_execution_credential_consumptions_command_id_fkey" FOREIGN KEY ("command_id") REFERENCES "desktop_commands"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loop_execution_credential_consumptions" ADD CONSTRAINT "loop_execution_credential_consumptions_loop_id_fkey" FOREIGN KEY ("loop_id") REFERENCES "loops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loop_execution_credential_consumptions" ADD CONSTRAINT "loop_execution_credential_consumptions_compute_target_id_fkey" FOREIGN KEY ("compute_target_id") REFERENCES "compute_targets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
