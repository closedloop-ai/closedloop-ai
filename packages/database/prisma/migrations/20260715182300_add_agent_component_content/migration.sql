-- Definition file text + its sha256 for agent components (FEA-2923 content
-- pipeline). Both additive + nullable: synced from desktop, deduped by hash,
-- backing the detail Prompt panel and (later) the content-hash version history.
-- Generated offline via `prisma migrate diff` (no local DB in this env);
-- applied by `prisma migrate deploy` in CI/prod.

-- AlterTable
ALTER TABLE "agent_components" ADD COLUMN     "content" TEXT,
ADD COLUMN     "content_hash" TEXT;
