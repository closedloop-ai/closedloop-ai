-- ISS-6463: session_detail.last_activity_at becomes NOT NULL.
--
-- No committed row can hold NULL today. The column has exactly one writer
-- (`upsertSessionSlice`), which creates the row and then floors the column at
-- the NOT NULL session_started_at in the same transaction
-- (`persistSessionChildren`'s GREATEST), so the intermediate NULL is never
-- visible to a reader; and the PLN-1034 backfill in
-- 20260620144141_add_last_activity_at ran without a WHERE clause, so it covered
-- the whole table with a value that is non-null by construction.
--
-- The backfill below is therefore expected to update zero rows. It runs anyway
-- because SET NOT NULL is the wrong place to discover a counterexample: a single
-- surviving NULL would abort the migration mid-deploy. GREATEST ignores NULL
-- operands, so this reduces to session_started_at for exactly the rows that
-- need it and cannot lower a value that is already set.
UPDATE "session_detail"
SET "last_activity_at" = GREATEST("session_started_at", "last_activity_at")
WHERE "last_activity_at" IS NULL;

ALTER TABLE "session_detail" ALTER COLUMN "last_activity_at" SET NOT NULL;
