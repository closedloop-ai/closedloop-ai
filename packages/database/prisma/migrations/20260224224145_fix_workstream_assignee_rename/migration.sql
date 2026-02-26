-- Fix: assigneeId on Workstream should reuse the existing assigned_to_id column,
-- not create a separate assignee_id column. Drop the extra column and its index.

DROP INDEX IF EXISTS "workstreams_assignee_id_idx";
ALTER TABLE "workstreams" DROP COLUMN IF EXISTS "assignee_id";
