-- AlterTable
ALTER TABLE "loops" ADD COLUMN     "active_token_jti" TEXT,
ADD COLUMN     "last_runner_heartbeat_at" TIMESTAMP(3),
ADD COLUMN     "runner_capabilities" JSONB,
ADD COLUMN     "token_expires_at" TIMESTAMP(3);
