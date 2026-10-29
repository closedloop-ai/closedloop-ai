-- ISS-10060: split `trace_comments.sync_status` into the CRUD action a row owes
-- and how far that delivery has got, so one column stops carrying two
-- orthogonal facts, and a policy-refused row can be parked (`blocked`) outside
-- the drain instead of being marked failed or left permanently due.
--
-- `sync_status` is NOT dropped. It stays as a write-only legacy mirror so an
-- older build, which addresses it by name in every one of its raw queries, keeps
-- working against a migrated database. Both new columns are nullable with no
-- default: NULL means "written by a build that does not know the pair", which is
-- what lets a read fall back to folding `sync_status` instead of trusting a
-- default that build never chose.
--
-- The `replies` JSON blob is deliberately NOT rewritten here. A reply's two new
-- fields are written the next time the row is touched, and until then the
-- legacy `syncStatus` inside the blob is accepted as a compatibility alias by
-- `resolveTraceCommentReplySyncFields` at the parse boundary. Rewriting a JSON
-- array in migration SQL
-- carries far more risk than a read-side alias, and no reply is stranded by the
-- alias.

-- AlterTable
ALTER TABLE "trace_comments" ADD COLUMN "sync_action" TEXT;
ALTER TABLE "trace_comments" ADD COLUMN "sync_delivery_status" TEXT;

-- Backfill every row from the seven pre-split values. `synced` takes `create`
-- because the old column recorded which operation applied only while a row was
-- unsettled, so a settled row's action is not recoverable from it; the action is
-- consulted only while the status is undelivered, and `synced` is not, so the
-- value never selects an operation and never hides the row. `delete` + `synced`
-- is unreachable by construction — a successful delete removes the row — so no
-- row can need it. A value outside the seven keeps both columns NULL rather than
-- receiving a guessed pair: the reader folds it or reports it unmeasured.
-- `test/trace-comment-action-status-split.test.ts` pins this mapping twice over,
-- because the two pins kill different mutations: once against a hand-typed table
-- that is independent of both copies (so renaming a wire value reddens), and once
-- against `traceCommentSyncPairForLegacyStatus` (so this SQL and the TypeScript
-- fold cannot drift apart — SQL cannot import the const, so nothing else could
-- catch that).
UPDATE "trace_comments"
SET
    "sync_action" = CASE "sync_status"
        WHEN 'local_pending' THEN 'create'
        WHEN 'sync_failed' THEN 'create'
        WHEN 'local_pending_update' THEN 'update'
        WHEN 'sync_failed_update' THEN 'update'
        WHEN 'local_pending_delete' THEN 'delete'
        WHEN 'sync_failed_delete' THEN 'delete'
        WHEN 'synced' THEN 'create'
    END,
    "sync_delivery_status" = CASE "sync_status"
        WHEN 'local_pending' THEN 'pending'
        WHEN 'sync_failed' THEN 'error'
        WHEN 'local_pending_update' THEN 'pending'
        WHEN 'sync_failed_update' THEN 'error'
        WHEN 'local_pending_delete' THEN 'pending'
        WHEN 'sync_failed_delete' THEN 'error'
        WHEN 'synced' THEN 'synced'
    END
WHERE "sync_status" IN (
    'local_pending',
    'sync_failed',
    'local_pending_update',
    'sync_failed_update',
    'local_pending_delete',
    'sync_failed_delete',
    'synced'
);

-- CreateIndex
-- IF NOT EXISTS, like every other index in this chain: the migration runner
-- re-applies migrations against an UNTRACKED or partially-migrated store to heal
-- it, and a bare CREATE INDEX aborts that heal with `index ... already exists`
-- instead (`test/migration-baseline-adoption.test.ts`).
CREATE INDEX IF NOT EXISTS "idx_trace_comments_sync_delivery_status" ON "trace_comments"("sync_delivery_status", "sync_action");
