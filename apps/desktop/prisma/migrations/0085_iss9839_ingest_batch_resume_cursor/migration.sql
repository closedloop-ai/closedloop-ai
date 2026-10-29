-- ISS-9839: the ISS-5161 BATCH-harness resume cursor, moved off a JSON file in
-- the ingest state dir and into the database that holds the sessions it names.
--
-- ONE row, always `id = 'batch-resume'`. The cursor is a WHOLE-STORE value with a
-- store-wide FORMAT version (ISS-9837 R3), so a payload written under a version
-- the running build does not know is discarded wholesale rather than retained
-- row by row — per-row versioning is what makes selective retention of rows a
-- newer build misreads easy, which is the shape that loses data.
--
-- No backfill from the old `ingest-batch-resume-cursor.json`, deliberately: an
-- upgraded build starts with no cursor and replays the in-flight source's prefix
-- once, which is the same cost this store already accepts on any discard and
-- strictly cheaper than parsing a file format at a boundary that no longer owns
-- it. The stale file is simply left where it is (see ISS-9839 for why removing it
-- is not this migration's job).
CREATE TABLE IF NOT EXISTS "ingest_batch_resume_cursor" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "version" INTEGER NOT NULL,
    "cursors" TEXT NOT NULL
);
