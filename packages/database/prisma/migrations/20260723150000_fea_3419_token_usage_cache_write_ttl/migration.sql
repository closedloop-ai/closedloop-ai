-- AlterTable
ALTER TABLE "agent_session_token_usage" ADD COLUMN     "cache_write_1h_tokens" BIGINT,
ADD COLUMN     "cache_write_5m_tokens" BIGINT;
