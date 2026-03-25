/*
  Warnings:

  - A unique constraint covering the columns `[entity_id,report_id]` on the table `artifact_evaluations` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `entity_id` to the `artifact_evaluations` table without a default value. This is not possible if the table is not empty.
  - Added the required column `entity_type` to the `artifact_evaluations` table without a default value. This is not possible if the table is not empty.
  - Added the required column `organization_id` to the `artifact_evaluations` table without a default value. This is not possible if the table is not empty.

*/

-- ============================================================================
-- PHASE 1: Add new columns as NULLABLE (required for backfill before NOT NULL)
-- ============================================================================

-- DropIndex
DROP INDEX "artifact_evaluations_artifact_id_created_at_idx";

-- DropIndex
DROP INDEX "artifact_evaluations_artifact_id_report_id_key";

-- AlterTable: add columns as nullable, make artifact_id optional
ALTER TABLE "artifact_evaluations" ADD COLUMN     "entity_id" UUID,
ADD COLUMN     "entity_type" "EntityType",
ADD COLUMN     "organization_id" UUID,
ALTER COLUMN "artifact_id" DROP NOT NULL;

-- ============================================================================
-- PHASE 2: Backfill existing rows
-- ============================================================================

UPDATE "artifact_evaluations" SET "entity_id" = "artifact_id", "entity_type" = 'ARTIFACT';
UPDATE "artifact_evaluations" ae SET "organization_id" = a."organization_id" FROM "artifacts" a WHERE ae."artifact_id" = a."id";

-- ============================================================================
-- PHASE 3: Apply NOT NULL constraints after backfill
-- ============================================================================

ALTER TABLE "artifact_evaluations" ALTER COLUMN "entity_id" SET NOT NULL;
ALTER TABLE "artifact_evaluations" ALTER COLUMN "entity_type" SET NOT NULL;
ALTER TABLE "artifact_evaluations" ALTER COLUMN "organization_id" SET NOT NULL;

-- ============================================================================
-- PHASE 4: Create indexes and constraints
-- ============================================================================

-- CreateIndex
CREATE INDEX "artifact_evaluations_entity_id_created_at_idx" ON "artifact_evaluations"("entity_id", "created_at");

-- CreateIndex
CREATE INDEX "artifact_evaluations_organization_id_entity_type_created_at_idx" ON "artifact_evaluations"("organization_id", "entity_type", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "artifact_evaluations_entity_id_report_id_key" ON "artifact_evaluations"("entity_id", "report_id");

-- AddForeignKey
ALTER TABLE "file_attachments" ADD CONSTRAINT "file_attachments_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "issues"("id") ON DELETE CASCADE ON UPDATE CASCADE;
