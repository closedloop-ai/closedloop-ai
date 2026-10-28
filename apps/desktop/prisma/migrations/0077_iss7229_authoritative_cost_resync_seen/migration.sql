-- ISS-7229: durable marker for the one-time authoritative-cost re-delivery pass.
--
-- WHAT 0074 MISSED (whitlockk on #6393). That migration set
-- `sessions.authoritative_cost_usd` from the already-captured
-- `claude_code_cost_event` rows, which was right, but it did not touch
-- `updated_at`. Cloud delivery selects on that cursor (the FEA-1962 incremental
-- sync watermark), so every row it filled was invisible to sync: the figure sat
-- in the local database and no later delivery ever selected it. A finished
-- session's cost never changes again, so the runtime rollup will not re-stamp it
-- either — without an explicit re-queue those figures never reach the cloud.
--
-- WHY A TABLE AND NOT AN `UPDATE` HERE. The first draft of this migration was
-- the obvious one-liner: stamp `updated_at` on every row with a non-null
-- authoritative cost. marisolashgrove caught what that costs. A blanket bump writes
-- ONE identical instant across the whole affected population, collapsing it onto
-- a single top watermark, and the sync cursor then carries that entire tied-top
-- group as uncapped `id NOT IN (…)` placeholders on every incremental tick until
-- the watermark advances. `session-analytics-maintenance.ts` refuses a blanket
-- bump for exactly this reason and names it FEA-3485; a migration is no more
-- entitled to it than a heal pass is.
--
-- So the re-queue moved to `authoritative-cost-resync-heal.ts`, a bounded boot
-- pass that walks the population in chunks and gives each chunk its own
-- strictly-increasing watermark via `chunkWatermark`. This table is the durable
-- "already asked" fact that pass needs.
--
-- WHY IT NEEDS ONE AT ALL. `billing-mode-heal.ts` is marker-free because its
-- predicate is CONVERGENT — it selects on the column it writes, so a healed row
-- stops matching. This pass selects on `authoritative_cost_usd IS NOT NULL` and
-- writes `updated_at`, which does not change that predicate by one row. Keyed on
-- the predicate alone it would re-bump the same sessions on every boot forever.
--
-- One row per session, PK on `session_id`, so the insert is idempotent under
-- `ON CONFLICT DO NOTHING` and the discovery `NOT EXISTS` probe is a
-- primary-key seek. `ON DELETE CASCADE` matches every other session-keyed marker
-- table: a purged session must not leave behind a marker claiming a re-queue for
-- a row that no longer exists.
--
-- `cost_usd` records the figure observed at re-queue time as EVIDENCE for why
-- the session was selected. It is NOT a delivery receipt and must never be read
-- as one — a row here means "this device asked for a re-send", never "the cloud
-- has this figure".
--
-- No index beyond the primary key: the pass's only access paths are the
-- `NOT EXISTS (… WHERE session_id = ?)` probe and the insert, both PK seeks.
CREATE TABLE IF NOT EXISTS "authoritative_cost_resync_seen" (
    "session_id" TEXT NOT NULL PRIMARY KEY,
    "cost_usd" REAL NOT NULL,
    "requeued_at" TEXT NOT NULL,
    CONSTRAINT "authoritative_cost_resync_seen_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
