-- AlterTable
ALTER TABLE "issues" ALTER COLUMN "status" SET DEFAULT 'DRAFT';

-- Migrate artifact data: chain-remap statuses (reverse order to avoid conflicts)
-- EXECUTED → DONE, APPROVED → EXECUTED, IN_REVIEW → APPROVED, READY_FOR_REVIEW → IN_REVIEW
UPDATE "artifacts" SET "status" = 'DONE' WHERE "status" = 'EXECUTED';
UPDATE "artifacts" SET "status" = 'EXECUTED' WHERE "status" = 'APPROVED';
UPDATE "artifacts" SET "status" = 'APPROVED' WHERE "status" = 'IN_REVIEW';
UPDATE "artifacts" SET "status" = 'IN_REVIEW' WHERE "status" = 'READY_FOR_REVIEW';

-- Migrate feature data: rename deprecated statuses
UPDATE "issues" SET "status" = 'DRAFT' WHERE "status" = 'NOT_STARTED';
UPDATE "issues" SET "status" = 'DONE' WHERE "status" = 'COMPLETED';
