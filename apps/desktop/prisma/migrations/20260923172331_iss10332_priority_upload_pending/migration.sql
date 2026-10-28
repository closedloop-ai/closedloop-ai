-- ISS-10332: whether a locally set priority still has to reach the cloud.
--
-- The local priority write sets it to 1 whenever it changes the value; the sync
-- lane sends `priority` (on the session payload, or on a branch ref) only while
-- it is 1, and resets it to 0 once the cloud has confirmed a payload carrying
-- the value the row still holds. Without it every re-sync re-sends the value and
-- the cloud's seed-if-unset re-applies a priority someone cleared on the web.
--
-- A flag, not a token: the stored `priority` is itself the version the ack
-- compares against, so an edit made after a payload was built survives the ack.
-- Import paths never write it.
--
-- Backfilled to 1 for a value already set, since nothing recorded whether the
-- cloud ever received it.
ALTER TABLE "sessions" ADD COLUMN "priority_upload_pending" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "artifacts" ADD COLUMN "priority_upload_pending" INTEGER NOT NULL DEFAULT 0;
UPDATE "sessions" SET "priority_upload_pending" = 1 WHERE "priority" IS NOT NULL;
UPDATE "artifacts" SET "priority_upload_pending" = 1 WHERE "priority" IS NOT NULL;
