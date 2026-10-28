-- ISS-11212 (PLN-2120 Step 3 backfill, PLN-2121 Step 6): moves every legacy
-- trace-comment dead letter out of `comment_threads.metadata.syncAbandoned`
-- into `comment_sync_states`, so the API's legacy-key read fallback can go in
-- the same change. HAND-WRITTEN data migration: Prisma generates no data steps.
-- It replaces the operator-run `backfill-comment-sync-states` script (operator
-- ruling 2026-10-06: database writes ship as migrations), with the same rules:
--   - NATIVE threads only.
--   - A literal `true` becomes the thread's DESKTOP / INBOUND row in state
--     ABANDONED. An existing row for that (thread, provider, direction) wins:
--     only the new write path creates one, so it is newer than the key.
--   - The key is stripped whatever it holds.
-- `id` and `updated_at` have no database default (Prisma fills them client
-- side), so both are supplied here. `gen_random_uuid()` rather than a v7:
-- Postgres 16 has no `uuidv7()`, following 20260930180000_iss11670. Neither
-- statement touches `comment_threads.updated_at`: a data move, not an edit.
-- Production held 0 such threads on 2026-10-06, so there it writes nothing.
-- ISS-11212 sync abandoned backfill begin
INSERT INTO "comment_sync_states" (
  "id", "organization_id", "thread_id", "provider", "direction", "state", "updated_at"
)
SELECT gen_random_uuid(), t."organization_id", t."id",
       'DESKTOP', 'INBOUND', 'ABANDONED', CURRENT_TIMESTAMP
  FROM "comment_threads" AS t
 WHERE t."source" = 'NATIVE'
   AND t."metadata" -> 'syncAbandoned' = 'true'::jsonb
ON CONFLICT ("thread_id", "provider", "direction") DO NOTHING;

UPDATE "comment_threads"
   SET "metadata" = "metadata" - 'syncAbandoned'
 WHERE "source" = 'NATIVE'
   AND jsonb_exists("metadata", 'syncAbandoned');
-- ISS-11212 sync abandoned backfill end
