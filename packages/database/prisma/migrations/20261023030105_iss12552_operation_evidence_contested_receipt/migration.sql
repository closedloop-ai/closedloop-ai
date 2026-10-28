-- ISS-12552: the receipt a claim tied for with another session's claim
-- (PRD-800 version 32 fork rule). A tie leaves both claims without the
-- receipt; this column keeps the tie visible to the next sync of either side
-- so neither takes the receipt by syncing first. NULL for every other claim.
-- AlterTable
ALTER TABLE "agent_session_operation_evidence" ADD COLUMN "contested_receipt_id" UUID;
