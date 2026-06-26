-- AlterTable
-- agent_sessions was renamed to session_detail by
-- 20260610193830_convert_agent_session_to_session_artifact (FEA-1699), which
-- sorts before this migration; target the post-rename table.
ALTER TABLE "session_detail" ADD COLUMN     "device_time_zone" TEXT;
