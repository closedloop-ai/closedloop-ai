-- ISS-9938 (PLN-2065 §5.1): keep `search_document.status` in step with its
-- source for document and loop rows.
--
-- WHY. `search_document.status` is the ANSWER to a status-filtered search, not
-- a cache: a `status:` token routes the request to the projection-backed
-- unified search, which never joins back to `artifacts` or `loops`. The column
-- was maintained by the post-commit, fail-open write hooks in
-- `apps/api/app/search/search-index-service.ts`, and several status writers
-- never called them: both bulk status paths (`writeStatusChanges`), the
-- blocked-dependent auto-unblock, the loop-ingestion reset to DRAFT, and every
-- loop transition after create. The only reconciler is the manual
-- `backfill:search-documents`. A bulk status change therefore left search
-- answering with the pre-change status indefinitely.
--
-- WHY A TRIGGER RATHER THAN APPLICATION CODE. Same reasoning as
-- 20260901120000_iss8674_queued_command_count: a copy maintained by each
-- writer drifts the moment one writer forgets it, and ISS-9938's own writer
-- table went stale within a week when a second bulk path landed. A row trigger
-- fires inside the status write's own transaction for EVERY writer (Prisma,
-- raw SQL, psql, the seed, routes not written yet) and rolls back with it.
--
-- THE COST, STATED. Every other projection write stays post-commit and
-- fail-open. This one column does not: its mirror update joins the status
-- write's transaction, so a status write now also takes the mirror row's lock.
-- In particular a status write on a document or loop whose mirror row the
-- manual `backfill:search-documents` has already swept waits for that
-- backfill's single long transaction to commit (see that script's header).
--
-- WHY HAND-WRITTEN. Prisma's schema DSL cannot express functions or triggers
-- (packages/database/AGENTS.md). Nothing here changes a column, so
-- `schema.prisma` carries only a comment and `prisma migrate dev` sees no
-- drift.
--
-- SHAPE, and why each part is there:
--
-- - Keyed on the projection's unique key `(organization_id, entity_type,
--   entity_id)`, so each fire is one index probe. The `entity_type` literals
--   must equal `SearchEntityType.Document` / `SearchEntityType.Loop` in
--   packages/api/src/types/search-entity-kind.ts.
-- - UPDATE only, never INSERT. A row that does not exist yet is created by the
--   app's post-commit indexer, which reads the status from the source row in
--   the same statement, so a status write that committed before that insert is
--   still picked up. One whose transaction is still open at that moment is
--   missed, and that row keeps the older status until its next status write.
--   Once the row exists the indexer leaves `status` alone: these functions keep
--   it current, and only the manual backfill (which likewise re-reads the
--   source at write time) and the one-time repairs below also rewrite it.
-- - `status` is the ONLY column assigned. `updated_at` mirrors the source's own
--   updatedAt and is deliberately left alone here (PLN-2065 §8 scopes it out),
--   which costs two reads: it orders search results, and it is the predicate
--   behind `since`/`until` and the `updated:` token. After a status change the
--   row is found under its new status but keeps the timestamp of its last
--   index, so `status:DONE updated:>…` misses rows a bulk change just moved.
--   Every status writer that never re-indexed already left it that way.
-- - `IS DISTINCT FROM` in both the WHEN and the UPDATE, so a same-value write
--   neither fires the function nor rewrites the mirror row.
-- - The artifacts WHEN is gated on `type = 'DOCUMENT'`. Sessions, branches and
--   deployments are artifacts too; session status is written at desktop-sync
--   cadence and their projection rows carry `status = NULL` by contract. The
--   gate keeps those writes from firing the function at all.
--
-- Lock order. Every mirror row lock taken here follows the source row lock for
-- the same entity, and no `search_document` writer takes a source row lock, so
-- no cycle runs through `artifacts` or `loops`. One can form among mirror rows
-- alone. A multi-row status write (the bulk status paths, the auto-unblock)
-- locks mirror rows in whatever order its UPDATE visits them, and the manual
-- `backfill:search-documents` holds every row it has swept, in ascending id
-- order, until it commits. If the status write locks a row the backfill has
-- not reached before one it has swept, each waits on the other: Postgres
-- aborts one with a deadlock error (40P01), and when that is the backfill its
-- whole sweep rolls back. Any other writer holding several mirror rows at once
-- is exposed the same way. Both statements below are catalog-only and hold
-- their locks on `artifacts` and `loops` for milliseconds.
--
-- This file only stops NEW drift. Rows that drifted before it are repaired by
-- separate status-only data migrations (PLN-2065 §4), which must sort after
-- this one: their re-check against the captured value is only safe beside a
-- trigger that is already live.

CREATE FUNCTION "sync_search_document_artifact_status"()
RETURNS trigger AS $$
BEGIN
  UPDATE "search_document"
     SET "status" = NEW."status"
   WHERE "organization_id" = NEW."organization_id"
     AND "entity_type" = 'document'
     AND "entity_id" = NEW."id"
     AND "status" IS DISTINCT FROM NEW."status";
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "artifacts_search_document_status_sync"
AFTER UPDATE OF "status" ON "artifacts"
FOR EACH ROW
WHEN (NEW."type" = 'DOCUMENT' AND OLD."status" IS DISTINCT FROM NEW."status")
EXECUTE FUNCTION "sync_search_document_artifact_status"();

-- `loops.status` is the `LoopStatus` enum and the mirror column is TEXT, hence
-- the cast.
CREATE FUNCTION "sync_search_document_loop_status"()
RETURNS trigger AS $$
BEGIN
  UPDATE "search_document"
     SET "status" = NEW."status"::text
   WHERE "organization_id" = NEW."organization_id"
     AND "entity_type" = 'loop'
     AND "entity_id" = NEW."id"
     AND "status" IS DISTINCT FROM NEW."status"::text;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "loops_search_document_status_sync"
AFTER UPDATE OF "status" ON "loops"
FOR EACH ROW
WHEN (OLD."status" IS DISTINCT FROM NEW."status")
EXECUTE FUNCTION "sync_search_document_loop_status"();
