-- ISS-4975: append-only deployment-event history (unblocks DORA / ISS-4465).
--
-- WHY. `deployment-status-handler.ts` early-returned on any state other than
-- `success`, so no failed deployment was ever persisted — change-failure rate and
-- MTTR had no data source at all. And `recordDeployment` updates the DEPLOYMENT
-- artifact in place keyed on (organization, external_url), so a re-deploy to a
-- reused preview URL replaced the row instead of adding one, which makes even
-- deployment frequency an undercount. This table records EVERY status transition
-- as an immutable row.
--
-- PURELY ADDITIVE. No existing table, column, index, or constraint is altered.
-- The DEPLOYMENT artifact + `deployment_detail` current-state row is unchanged
-- and remains the system of record for "what is deployed right now"; the history
-- lives alongside it so current consumers keep working untouched.
--
-- DEDUPE IDENTITY. The unique index below is over three NON-NULLABLE columns:
-- (organization_id, source, external_event_id). `external_event_id` is the
-- provider's status-transition id (unique per transition) and `source` keeps two
-- event streams from colliding on a raw numeric id. The ingest path inserts with
-- ON CONFLICT DO NOTHING, so a redelivered or cross-stream duplicate webhook is a
-- no-op rather than a second row. Nullable fields such as `environment_url` or
-- `sha` are deliberately NOT part of the identity — a failed deployment usually
-- carries no environment URL, so keying on one would silently double-count.
--
-- NO FOREIGN KEYS except the tenant boundary. `project_id`, `repository_id`, and
-- `branch_artifact_id` are plain UUID columns on purpose: an append-only history
-- must not be rewritten (`SET NULL`) or destroyed (`CASCADE`) when the mutable
-- current-state records it describes are deleted, tombstoned, or reparented.
-- `organization_id` keeps its cascading FK so tenant deletion still removes
-- tenant data.
--
-- PLAIN (non-CONCURRENT) INDEX BUILD — reviewed exception, see the
-- `index-lock-ok` marker below and its matching `INDEX_LOCK_ALLOWLIST` entry in
-- `scripts/lint/destructive-migrations/index-lock-allowlist.ts`.
--
-- The `check-destructive-migrations` gate flags a plain `CREATE INDEX` because
-- it holds a write-blocking lock on the table for the whole build, and on a
-- table recording every deployment transition that would stall the writer during
-- a deploy — precisely when it is busiest. That reasoning is right in general and
-- does not reach this statement, for two independent reasons:
--
-- 1. NOTHING TO LOCK OUT. `deployment_events` is CREATED by this same migration,
--    a few statements above. At the moment the index is built the table holds
--    zero rows and no session anywhere can reference it yet, so the build is
--    instantaneous and there is no concurrent writer to block. The hazard the
--    gate protects against — a long build on a hot existing table — cannot
--    occur here at any database size.
-- 2. CONCURRENTLY CANNOT DEFER IT. This is not a perf index that can land later.
--    It is the conflict target for the ingest write's
--    `INSERT ... ON CONFLICT DO NOTHING` (`deployment-event-service.ts`), so it
--    must exist before the first insert or the dedupe identity is unenforced and
--    redelivered webhooks double-count. `CREATE INDEX CONCURRENTLY` cannot run
--    in a transaction block, so it cannot sit in this file alongside the
--    `CREATE TABLE`; moving it to a follow-up migration would open a window in
--    which the table accepts duplicate provider events.
--
-- Only the dedupe unique index is built here. No read index is created at all
-- (see the CreateIndex block below), so this exception covers exactly one
-- statement on one brand-new table.
-- index-lock-ok(deployment_events): table is created empty in this same migration so the build locks zero rows with no concurrent writer, and CONCURRENTLY cannot defer it because this unique index is the ingest ON CONFLICT DO NOTHING target and must exist before the first insert

-- CreateTable
CREATE TABLE "deployment_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID,
    "repository_id" UUID,
    "branch_artifact_id" UUID,
    "source" VARCHAR(32) NOT NULL,
    "external_deployment_id" VARCHAR(200) NOT NULL,
    "external_event_id" VARCHAR(200) NOT NULL,
    "state" VARCHAR(32) NOT NULL,
    "provider_state" VARCHAR(64) NOT NULL,
    "environment" TEXT,
    "ref" TEXT,
    "sha" TEXT,
    "environment_url" TEXT,
    "github_status_url" TEXT,
    "github_deployment_url" TEXT,
    "production" BOOLEAN,
    "transient" BOOLEAN,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "deployment_created_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deployment_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- The ONLY index here, and the only one with a current access path: the ingest
-- write below inserts with ON CONFLICT DO NOTHING against it. All three columns
-- are NOT NULL, so that conflict target is reliable; a partial/nullable key
-- would let duplicates through.
--
-- No read indexes are created. `packages/database/AGENTS.md` allows an index
-- only for a concrete current access path, and this PR ships no reader — the
-- DORA queries (ISS-4465) land separately and will add the composite indexes
-- that match their actual predicates. Guessing them now would mean carrying
-- three unused indexes on the write path of every webhook delivery.
-- `IF NOT EXISTS` is required of a reviewed plain-index exception so a migration
-- retry (e.g. after a failure later in this file) is idempotent rather than
-- erroring on the already-built index.
CREATE UNIQUE INDEX IF NOT EXISTS "deployment_events_org_source_event_key" ON "deployment_events"("organization_id", "source", "external_event_id");

-- AddForeignKey
ALTER TABLE "deployment_events" ADD CONSTRAINT "deployment_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
