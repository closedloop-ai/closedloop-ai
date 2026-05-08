-- Add universal replay identity fields to loop events.
ALTER TABLE "loop_events"
ADD COLUMN "event_source" TEXT NOT NULL DEFAULT 'system',
ADD COLUMN "event_id" TEXT NOT NULL DEFAULT md5(random()::text || clock_timestamp()::text);

-- Backfill runner-sourced rows with deterministic replay IDs.
UPDATE "loop_events"
SET
  "event_source" = 'runner',
  "event_id" = "runner_token_jti" || ':' || "runner_nonce"::text
WHERE "runner_token_jti" IS NOT NULL
  AND "runner_nonce" IS NOT NULL;

-- Replace nullable replay unique index with universal event replay unique index.
DROP INDEX IF EXISTS "loop_events_loop_id_runner_token_jti_runner_nonce_key";

CREATE UNIQUE INDEX "loop_events_loop_id_event_source_event_id_key"
ON "loop_events"("loop_id", "event_source", "event_id");

-- Backfill orphans before adding self-referential FK.
UPDATE "loops" l
SET "parent_loop_id" = NULL
WHERE "parent_loop_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "loops" p
    WHERE p."id" = l."parent_loop_id"
  );

-- Enforce parent loop referential integrity at the DB layer.
ALTER TABLE "loops"
ADD CONSTRAINT "loops_parent_loop_id_fkey"
FOREIGN KEY ("parent_loop_id") REFERENCES "loops"("id")
ON DELETE RESTRICT
ON UPDATE RESTRICT;
