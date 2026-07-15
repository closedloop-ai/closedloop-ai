-- AlterTable
ALTER TABLE "session_detail" ALTER COLUMN "estimated_cost" SET DATA TYPE DECIMAL(14,6);

-- AlterTable
ALTER TABLE "agent_session_token_usage" ALTER COLUMN "estimated_cost" SET DATA TYPE DECIMAL(14,6);
