-- ISS-11212 (PLN-2120 Step 6): `comment_threads.artifact_id` becomes required.
-- HAND-WRITTEN around the generated `SET NOT NULL`: Prisma generates neither
-- the data steps nor the CHECK. It replaces the operator-run orphan report
-- script (operator ruling 2026-10-06: database writes ship as migrations; the
-- two production orphans are safe to delete).
--
-- 1. Attach each thread with no artifact whose room id resolves exactly as
--    apps/api/app/comments/artifact-for-room.ts does: three ':'-separated
--    parts, the middle one a room namespace (`artifact`, or the immutable
--    pre-rename `document`; packages/collaboration/shared/room-utils.ts), the
--    third the slug, looked up in the THREAD's organization.
-- 2. Delete every thread still without one. The foreign keys from comments,
--    comment_sync_states and github_comment_thread_projections cascade, and
--    the ones from comment_reactions, comment_attachments and
--    github_comment_projections cascade from comments, so nothing blocks it.
-- 3. Make the column NOT NULL with a short ACCESS EXCLUSIVE window.
--    `prisma migrate deploy` commits each statement of this file on its own
--    (measured on Prisma 7.10: consecutive statements ran in different
--    transactions), so the NOT VALID CHECK takes ACCESS EXCLUSIVE only for a
--    catalog change, VALIDATE scans under SHARE UPDATE EXCLUSIVE while writes
--    continue, and SET NOT NULL then proves the column from the validated
--    CHECK instead of scanning again. The CHECK is dropped once the column
--    carries the rule, so the schema matches schema.prisma.
-- Every statement is safe to re-run, so a retry after a partial apply
-- converges.
--
-- Rolling deploy: the api bundle serving while this runs (#8321 onward) writes
-- no thread without an artifact. Every thread create sets it from a resolved
-- artifact, and the Liveblocks upsert writes nothing for a room that resolves
-- to none, so the CHECK never refuses a write that bundle makes.
SET lock_timeout = '5s';

-- ISS-11212 orphan attach begin
UPDATE "comment_threads" AS t
   SET "artifact_id" = a."id"
  FROM "artifacts" AS a
 WHERE t."artifact_id" IS NULL
   AND array_length(string_to_array(t."room_id", ':'), 1) = 3
   AND split_part(t."room_id", ':', 2) IN ('artifact', 'document')
   AND a."organization_id" = t."organization_id"
   AND a."slug" = split_part(t."room_id", ':', 3);
-- ISS-11212 orphan attach end

-- ISS-11212 orphan delete begin
DELETE FROM "comment_threads" WHERE "artifact_id" IS NULL;
-- ISS-11212 orphan delete end

ALTER TABLE "comment_threads"
  DROP CONSTRAINT IF EXISTS "comment_threads_artifact_id_not_null",
  ADD CONSTRAINT "comment_threads_artifact_id_not_null"
    CHECK ("artifact_id" IS NOT NULL) NOT VALID;

ALTER TABLE "comment_threads" VALIDATE CONSTRAINT "comment_threads_artifact_id_not_null";

-- AlterTable
ALTER TABLE "comment_threads" ALTER COLUMN "artifact_id" SET NOT NULL;

ALTER TABLE "comment_threads" DROP CONSTRAINT IF EXISTS "comment_threads_artifact_id_not_null";

RESET lock_timeout;
