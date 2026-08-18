-- Definition file text + its sha256 for agent components (FEA-2923 content
-- pipeline). Both additive + nullable; `content_hash` is the dedup + version
-- key. Forward-only on user machines (no down-migration), like every desktop
-- migration. Generated offline via `prisma migrate diff`.

-- AlterTable
ALTER TABLE "agent_components" ADD COLUMN "content" TEXT;
ALTER TABLE "agent_components" ADD COLUMN "content_hash" TEXT;
