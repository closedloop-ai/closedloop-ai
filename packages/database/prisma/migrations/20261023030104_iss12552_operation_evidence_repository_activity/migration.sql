-- ISS-12552 (option d, PRD-800 version 28): the session's implementation-join
-- claims, the Desktop's write-to-commit join summarized per branch (branch and
-- request keys, no file paths), kept on the evidence snapshot. NULL for a
-- snapshot from a Desktop that predates the join.
-- AlterTable
ALTER TABLE "agent_session_operation_evidence_snapshots" ADD COLUMN "repository_activity" JSONB;
