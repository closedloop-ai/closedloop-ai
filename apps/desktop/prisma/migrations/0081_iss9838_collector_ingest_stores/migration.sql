-- ISS-9838: move the three JSON-file ingest stores into the local SQLite store.
--
-- The catchup cache, the parse quarantine and the Codex rollout-linkage cache
-- were best-effort JSON files under the ingest state dir. Two of the three wrote
-- in place, so a crash mid-write truncated the file and the next launch read it
-- as corrupt and started empty. This table replaces all three sinks.
--
-- ONE ROW PER STORE. ISS-9837 R3 ruled whole-store discard: `format_version`
-- discriminates a FORMAT, and a format is a property of the store, not of a row.
-- A per-row version column is the shape with the data-loss risk, because it makes
-- selectively retaining rows written under a shape the code no longer understands
-- easy; at this grain that is not expressible. It also matches the write pattern —
-- `flush()` rewrites the whole map on a throttle, so a row-per-entry table would
-- be a delete-all plus insert-all sweep of thousands of rows every tick.
--
-- NOTHING IS BACKFILLED FROM THE OLD FILES, deliberately. All three stores are
-- derived caches over sources of truth that stay on disk, so an empty start costs
-- one recomputation pass and never information (the catchup cache re-stats and
-- re-imports its history idempotently; the quarantine re-earns its entries). The
-- old files are left in place untouched, so a rolled-back build finds exactly the
-- state it wrote.
--
-- No index beyond the primary key: every access path is a `store_key` seek or the
-- boot-time full read of this table, which holds one row per collector store.
CREATE TABLE IF NOT EXISTS "collector_ingest_stores" (
    "store_key" TEXT NOT NULL PRIMARY KEY,
    "format_version" INTEGER NOT NULL,
    "payload" TEXT NOT NULL,
    "updated_at" TEXT NOT NULL
);
