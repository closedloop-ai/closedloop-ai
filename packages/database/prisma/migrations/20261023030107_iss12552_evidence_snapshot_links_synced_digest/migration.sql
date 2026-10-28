-- ISS-12552: the snapshot digest a session's evidence links were last synced
-- for. Links now sync after the evidence write commits, and only when the
-- attribution flag answers; while this differs from "digest" the next sync of
-- the session rebuilds its evidence and tries the links again. NULL for every
-- existing snapshot, so each session resyncs its links once.
-- AlterTable
ALTER TABLE "agent_session_operation_evidence_snapshots" ADD COLUMN "links_synced_digest" TEXT;
