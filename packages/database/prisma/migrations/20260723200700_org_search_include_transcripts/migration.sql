-- FEA-3930 (parent FEA-3800, PLN-1456) — org-level privacy gate for indexing AI
-- session transcript CONTENT into the unified-search projection.
--
-- WHY: session transcript text (archived JSONL in S3) can carry source code,
-- secrets, and prompts. Some orgs do not want that content full-text searchable,
-- so indexing it is OFF by default. When an org admin opts in, the write-time
-- indexer projects `agent_session` rows into `search_document` and the FTS query
-- returns them; both paths check this flag, so flipping it OFF stops new indexing
-- and hides any rows left from when it was on.
--
-- ADDITIVE / BACKFILL-SAFE: NOT NULL with a `false` DEFAULT, so adding it takes
-- only a metadata-level lock and every existing org row defaults to the
-- privacy-safe value. Generated verbatim from schema.prisma's Organization model
-- (one `ADD COLUMN`) — no Prisma-inexpressible construct here; committed
-- alongside the schema change so `prisma migrate dev` reports no drift.

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN "search_include_transcripts" BOOLEAN NOT NULL DEFAULT false;
