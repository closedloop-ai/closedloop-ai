-- Phase-2 navigation slice (parent FEA-3800, PLN-1456) — additive route-building
-- columns on the unified-search projection `search_document`.
--
-- WHY: Phase-1 deep links were UUID-only (`/documents/<uuid>`, `/projects/<uuid>`)
-- which the web app does not route — the app routes documents by TYPE + SLUG
-- (`/prds|/features/<slug>`) and projects team-scoped
-- (`/teams/<teamId>/projects/<projectId>`). The projection carried neither the
-- slug/type nor the owning team, so Document and Project hits could not be
-- rendered as links. These three columns carry exactly the data the canonical
-- route helpers need.
--
-- ADDITIVE / BACKFILL-SAFE: all three columns are NULLABLE with no default, so
-- adding them takes only a metadata-level lock and every existing row stays
-- valid (the values are backfilled by
-- `packages/database/scripts/backfill-search-documents.ts` and the live
-- write-time hooks). They are NOT part of the generated `tsv` vector and NOT
-- part of any index, so the GIN/btree indexes are untouched.
--
-- Generated verbatim from schema.prisma's SearchDocument model (three
-- `ADD COLUMN` statements) — no Prisma-inexpressible construct here; this file is
-- committed alongside the schema change so `prisma migrate dev` reports no drift.

-- AlterTable
ALTER TABLE "search_document" ADD COLUMN "slug" TEXT;
ALTER TABLE "search_document" ADD COLUMN "entity_subtype" TEXT;
ALTER TABLE "search_document" ADD COLUMN "team_id" UUID;
