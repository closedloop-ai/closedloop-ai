-- Add approver_id as a proper UUID column (replacing the freeform text approver field)
ALTER TABLE "artifacts" ADD COLUMN "approver_id" UUID;

-- Best-effort backfill: match freeform approver name to users in the same org
UPDATE "artifacts" a
SET "approver_id" = u."id"
FROM "users" u
WHERE a."approver" IS NOT NULL
  AND a."organization_id" = u."organization_id"
  AND lower(u."first_name") = lower(a."approver");

-- Drop the old freeform text column
ALTER TABLE "artifacts" DROP COLUMN "approver";

-- Add index for the new foreign key
CREATE INDEX "artifacts_approver_id_idx" ON "artifacts"("approver_id");
