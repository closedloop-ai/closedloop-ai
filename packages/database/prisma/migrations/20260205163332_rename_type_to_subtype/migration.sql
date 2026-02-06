-- Rename enum types: ArtifactType -> ArtifactSubtype, ArtifactCategory -> ArtifactType
-- Strategy: Use temp names to avoid collision

-- Step 1: Rename ArtifactType to temp name
ALTER TYPE "ArtifactType" RENAME TO "_ArtifactType_old";

-- Step 2: Rename ArtifactCategory to ArtifactType
ALTER TYPE "ArtifactCategory" RENAME TO "ArtifactType";

-- Step 3: Rename temp to ArtifactSubtype
ALTER TYPE "_ArtifactType_old" RENAME TO "ArtifactSubtype";

-- Step 4: Rename columns in artifacts table
ALTER TABLE "artifacts" RENAME COLUMN "type" TO "subtype";
ALTER TABLE "artifacts" RENAME COLUMN "category" TO "type";
ALTER TABLE "artifacts" RENAME COLUMN "template_for_type" TO "template_for_subtype";

-- Step 5: Make subtype nullable (drop NOT NULL constraint)
ALTER TABLE "artifacts" ALTER COLUMN "subtype" DROP NOT NULL;

-- Step 6: Rename indexes to match new column names
ALTER INDEX "artifacts_organization_id_workstream_id_type_is_latest_idx" RENAME TO "artifacts_organization_id_workstream_id_subtype_is_latest_idx";
ALTER INDEX "artifacts_organization_id_project_id_type_is_latest_idx" RENAME TO "artifacts_organization_id_project_id_subtype_is_latest_idx";
ALTER INDEX "artifacts_organization_id_parent_id_type_is_latest_idx" RENAME TO "artifacts_organization_id_parent_id_subtype_is_latest_idx";
ALTER INDEX "artifacts_organization_id_type_template_for_type_idx" RENAME TO "artifacts_organization_id_subtype_template_for_subtype_idx";

-- Step 7: Rename unique constraint
ALTER INDEX "artifacts_organization_id_template_for_type_key" RENAME TO "artifacts_organization_id_template_for_subtype_key";
