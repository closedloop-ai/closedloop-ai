-- AlterTable
-- FEA-1787: nullable data_revision column for revision-gated replace-on-resync.
-- NULL = pre-revision desktop (current behavior preserved).
ALTER TABLE "session_detail" ADD COLUMN "data_revision" INTEGER;
