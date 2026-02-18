-- AlterTable
ALTER TABLE "loop_events"
ADD COLUMN "runner_token_jti" TEXT,
ADD COLUMN "runner_nonce" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "loop_events_loop_id_runner_token_jti_runner_nonce_key"
ON "loop_events"("loop_id", "runner_token_jti", "runner_nonce");
