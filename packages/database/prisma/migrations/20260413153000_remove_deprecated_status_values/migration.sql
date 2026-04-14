-- Remove deprecated feature status enum values (NOT_STARTED, COMPLETED)
CREATE TYPE "IssueStatus_new" AS ENUM (
  'DRAFT',
  'IN_PROGRESS',
  'IN_REVIEW',
  'APPROVED',
  'EXECUTED',
  'DONE',
  'OBSOLETE'
);

ALTER TABLE "issues" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "issues"
  ALTER COLUMN "status" TYPE "IssueStatus_new"
  USING ("status"::text::"IssueStatus_new");
ALTER TABLE "issues" ALTER COLUMN "status" SET DEFAULT 'DRAFT';

DROP TYPE "IssueStatus";
ALTER TYPE "IssueStatus_new" RENAME TO "IssueStatus";

-- Remove deprecated artifact status enum value (READY_FOR_REVIEW)
CREATE TYPE "ArtifactStatus_new" AS ENUM (
  'DRAFT',
  'IN_PROGRESS',
  'IN_REVIEW',
  'APPROVED',
  'EXECUTED',
  'DONE',
  'OBSOLETE'
);

ALTER TABLE "artifacts" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "artifacts"
  ALTER COLUMN "status" TYPE "ArtifactStatus_new"
  USING ("status"::text::"ArtifactStatus_new");
ALTER TABLE "artifacts" ALTER COLUMN "status" SET DEFAULT 'DRAFT';

DROP TYPE "ArtifactStatus";
ALTER TYPE "ArtifactStatus_new" RENAME TO "ArtifactStatus";
