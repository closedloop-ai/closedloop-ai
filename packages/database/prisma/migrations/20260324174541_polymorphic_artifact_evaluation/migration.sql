-- NOTE: Do NOT wrap in BEGIN/COMMIT — Prisma migrate deploy manages transactions.

-- ============================================================================
-- PHASE 1: Add new columns as nullable (required for backfill before NOT NULL)
-- ============================================================================

-- AlterTable: add organization_id, entity_id, entity_type as nullable
ALTER TABLE "artifact_evaluations" ADD COLUMN "organization_id" UUID;
ALTER TABLE "artifact_evaluations" ADD COLUMN "entity_id" UUID;
ALTER TABLE "artifact_evaluations" ADD COLUMN "entity_type" "EntityType";

-- ============================================================================
-- PHASE 2: Backfill existing rows
-- ============================================================================

-- Backfill existing rows
UPDATE "artifact_evaluations" SET "entity_id" = "artifact_id", "entity_type" = 'ARTIFACT';
UPDATE "artifact_evaluations" ae SET "organization_id" = a."organization_id" FROM "artifacts" a WHERE ae."artifact_id" = a."id";

-- ============================================================================
-- PHASE 3: Apply NOT NULL constraints after backfill
-- ============================================================================

-- AlterTable: set NOT NULL on backfilled columns
ALTER TABLE "artifact_evaluations" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "artifact_evaluations" ALTER COLUMN "entity_id" SET NOT NULL;
ALTER TABLE "artifact_evaluations" ALTER COLUMN "entity_type" SET NOT NULL;

-- ============================================================================
-- PHASE 4: Make artifact_id nullable (drop FK constraint first, re-add as nullable)
-- ============================================================================

-- DropForeignKey (artifact_id was NOT NULL with FK, making it nullable requires dropping the constraint first)
ALTER TABLE "artifact_evaluations" DROP CONSTRAINT "artifact_evaluations_artifact_id_fkey";

-- AlterTable: make artifact_id nullable
ALTER TABLE "artifact_evaluations" ALTER COLUMN "artifact_id" DROP NOT NULL;

-- AddForeignKey: re-add FK as optional (for onDelete Cascade cleanup)
ALTER TABLE "artifact_evaluations" ADD CONSTRAINT "artifact_evaluations_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- PHASE 5: Replace indexes and unique constraints
-- ============================================================================

-- DropIndex: old unique constraint on (artifact_id, report_id)
DROP INDEX "artifact_evaluations_artifact_id_report_id_key";

-- DropIndex: old index on (artifact_id, created_at)
DROP INDEX "artifact_evaluations_artifact_id_created_at_idx";

-- CreateIndex: new unique constraint on (entity_id, report_id)
CREATE UNIQUE INDEX "artifact_evaluations_entity_id_report_id_key" ON "artifact_evaluations"("entity_id", "report_id");

-- CreateIndex: new index on (entity_id, created_at)
CREATE INDEX "artifact_evaluations_entity_id_created_at_idx" ON "artifact_evaluations"("entity_id", "created_at");

-- CreateIndex: new index on (organization_id, entity_type, created_at)
CREATE INDEX "artifact_evaluations_organization_id_entity_type_created_at_idx" ON "artifact_evaluations"("organization_id", "entity_type", "created_at");
