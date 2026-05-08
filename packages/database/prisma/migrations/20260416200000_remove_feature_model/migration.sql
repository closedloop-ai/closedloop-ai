-- Remove Feature model (renamed to Document type=FEATURE in prior migration).
-- All data was migrated in 20260416180000_migrate_features_to_documents.

-- Drop FK + column from file_attachments (idempotent)
ALTER TABLE "file_attachments" DROP CONSTRAINT IF EXISTS "file_attachments_issue_id_fkey";
DROP INDEX IF EXISTS "file_attachments_issue_id_idx";
ALTER TABLE "file_attachments" DROP COLUMN IF EXISTS "issue_id";

-- Drop the issues table (Feature model)
DROP TABLE IF EXISTS "issues";

-- Drop the IssueStatus enum (FeatureStatus)
DROP TYPE IF EXISTS "IssueStatus";

-- Normalize EntityType: recreate enum without FEATURE/ISSUE, carry over all dependent columns.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EntityType_old') THEN
    ALTER TYPE "EntityType" RENAME TO "EntityType_old";
    CREATE TYPE "EntityType" AS ENUM ('ARTIFACT', 'EXTERNAL_LINK');
  END IF;
END $$;

ALTER TABLE "entity_links"
  ALTER COLUMN "source_type" TYPE "EntityType" USING "source_type"::text::"EntityType",
  ALTER COLUMN "target_type" TYPE "EntityType" USING "target_type"::text::"EntityType";
ALTER TABLE "artifact_evaluations"
  ALTER COLUMN "entity_type" TYPE "EntityType" USING "entity_type"::text::"EntityType";
ALTER TABLE "comment_threads"
  ALTER COLUMN "entity_type" TYPE "EntityType" USING "entity_type"::text::"EntityType";
DROP TYPE IF EXISTS "EntityType_old";

-- CustomFieldEntityType: same pattern, but drop defaults first because PostgreSQL can't cast defaults automatically.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CustomFieldEntityType_old') THEN
    ALTER TYPE "CustomFieldEntityType" RENAME TO "CustomFieldEntityType_old";
    CREATE TYPE "CustomFieldEntityType" AS ENUM ('PROJECT', 'WORKSTREAM', 'ARTIFACT');
  END IF;
END $$;

ALTER TABLE "custom_fields" ALTER COLUMN "entity_types" DROP DEFAULT;
ALTER TABLE "custom_fields"
  ALTER COLUMN "entity_types" TYPE "CustomFieldEntityType"[] USING "entity_types"::text[]::"CustomFieldEntityType"[];
ALTER TABLE "custom_fields" ALTER COLUMN "entity_types" SET DEFAULT ARRAY[]::"CustomFieldEntityType"[];
ALTER TABLE "custom_field_settings"
  ALTER COLUMN "entity_type" TYPE "CustomFieldEntityType" USING "entity_type"::text::"CustomFieldEntityType";
ALTER TABLE "custom_field_values"
  ALTER COLUMN "entity_type" TYPE "CustomFieldEntityType" USING "entity_type"::text::"CustomFieldEntityType";
DROP TYPE IF EXISTS "CustomFieldEntityType_old";
