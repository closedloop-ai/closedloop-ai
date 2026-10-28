-- CreateEnum
CREATE TYPE "ReferenceTargetSource" AS ENUM ('ARTIFACT', 'SESSION', 'ISSUE', 'BRANCH');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "CustomFieldType" ADD VALUE 'REFERENCE';
ALTER TYPE "CustomFieldType" ADD VALUE 'REFERENCE_MULTI';

-- AlterTable
ALTER TABLE "custom_fields" ADD COLUMN     "reference_target_sources" "ReferenceTargetSource"[] DEFAULT ARRAY[]::"ReferenceTargetSource"[];

-- CreateTable
CREATE TABLE "custom_field_value_references" (
    "id" UUID NOT NULL,
    "custom_field_value_id" UUID NOT NULL,
    "target_artifact_id" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custom_field_value_references_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- index-lock-ok(custom_field_value_references): table is created empty in this same migration so both the cascade-support lookup index and the identity unique build against zero rows with no concurrent writer, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in a transaction
CREATE INDEX IF NOT EXISTS "custom_field_value_references_target_artifact_id_idx" ON "custom_field_value_references"("target_artifact_id");

-- CreateIndex
-- index-lock-ok(custom_field_value_references): table is created empty in this same migration so both the cascade-support lookup index and the identity unique build against zero rows with no concurrent writer, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in a transaction
CREATE UNIQUE INDEX IF NOT EXISTS "custom_field_value_references_custom_field_value_id_target__key" ON "custom_field_value_references"("custom_field_value_id", "target_artifact_id");

-- AddForeignKey
ALTER TABLE "custom_field_value_references" ADD CONSTRAINT "custom_field_value_references_custom_field_value_id_fkey" FOREIGN KEY ("custom_field_value_id") REFERENCES "custom_field_values"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_value_references" ADD CONSTRAINT "custom_field_value_references_target_artifact_id_fkey" FOREIGN KEY ("target_artifact_id") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
