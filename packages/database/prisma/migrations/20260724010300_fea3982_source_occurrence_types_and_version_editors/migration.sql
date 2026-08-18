-- FEA-3982 (Slice 1 + Mike-approved edit-lineage capture).
--
-- Fully ADDITIVE / zero-downtime:
--   1. ALTER TYPE ... ADD VALUE — extends `source_occurrence_type` with the
--      four new provenance kinds (concern D). Existing rows keep their values;
--      no existing column uses a new value in this migration, so there is no
--      in-transaction "unsafe use of new enum value" hazard.
--   2. CREATE TYPE (empty) + CREATE TABLE (empty) + CREATE INDEX +
--      ADD CONSTRAINT (FKs validate instantly against an empty table) — the
--      `definition_version_editors` edit-lineage join. No DROP, no ALTER on an
--      existing column, no data mutation.
--
-- Rollback = drop the table + the two enums' new members are left in place
-- (Postgres cannot drop an enum value; harmless — unused values never break a
-- reader that maps unknown values to `local`).
--
-- Generated offline via `prisma migrate diff --from-schema <origin/main> --to-schema
-- <this schema> --script` (NOT applied to the shared local Postgres, per
-- packages/database/CLAUDE.md). A human applies it with `prisma migrate deploy`.

-- CreateEnum
CREATE TYPE "definition_version_editor_role" AS ENUM ('discoverer', 'editor');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.
ALTER TYPE "source_occurrence_type" ADD VALUE 'static_file';
ALTER TYPE "source_occurrence_type" ADD VALUE 'distributed';
ALTER TYPE "source_occurrence_type" ADD VALUE 'builtin_claude';
ALTER TYPE "source_occurrence_type" ADD VALUE 'builtin_codex';

-- CreateTable
CREATE TABLE "definition_version_editors" (
    "id" UUID NOT NULL,
    "definition_version_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "definition_version_editor_role" NOT NULL DEFAULT 'editor',
    "first_edited_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_edited_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "definition_version_editors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "definition_version_editors_user_id_idx" ON "definition_version_editors"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "definition_version_editors_definition_version_id_user_id_key" ON "definition_version_editors"("definition_version_id", "user_id");

-- AddForeignKey
ALTER TABLE "definition_version_editors" ADD CONSTRAINT "definition_version_editors_definition_version_id_fkey" FOREIGN KEY ("definition_version_id") REFERENCES "definition_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "definition_version_editors" ADD CONSTRAINT "definition_version_editors_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
