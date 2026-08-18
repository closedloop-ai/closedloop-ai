-- ISS-5266: durable record of an OpenCode subagent subtree the collector
-- WITHHELD because its root row could not be parsed.
--
-- ISS-5238 (F2) withholds those children rather than re-emitting them at top
-- level (a subagent presented as its own root is a lie about the session graph),
-- but the withhold existed only as a log line. `markSourceImported` then advances
-- the store fingerprint, so the children's spend leaves the corpus silently and
-- the resulting under-count reads as a true zero on every roll-up.
--
-- One row per WITHHELD ROOT, identified by the COMPOSITE (`source_path`,
-- `root_raw_id`). An opencode session id is unique only WITHIN a store, so two
-- stores can legitimately carry the same raw root id; keying on `root_raw_id`
-- alone would let store B's upsert move store A's row onto B's `source_path`,
-- and the per-store reconcile could then never retain both.
--
-- `source_path` records which `opencode.db` the load read, so a store's rows can
-- be reconciled wholesale: OpenCode is a batch harness and one load sees the
-- entire store, so a root missing from the current load's withhold set has
-- started parsing again and its row must be retired rather than left claiming
-- missing data forever.
--
-- `withheld_tokens` is BILLABLE tokens (input + output), the same basis as the
-- dashboard headline total the shortfall is quoted against; cache tokens are
-- carried separately in `withheld_cache_tokens`. Both are NULLABLE, where NULL
-- means UNAVAILABLE (the aggregate left the JS-safe integer range) and never
-- zero. The two child-instant columns are nullable because a child can carry no
-- timestamp; NULL there means "window unknown", never "zero-length window", and
-- `window_partial` records that a skipped child makes the surviving bounds a
-- LOWER BOUND rather than the exact extent.
CREATE TABLE IF NOT EXISTS "opencode_withheld_subagent_root" (
    "root_raw_id" TEXT NOT NULL,
    "source_path" TEXT NOT NULL,
    "withheld_count" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "withheld_tokens" INTEGER,
    "withheld_cache_tokens" INTEGER,
    "earliest_child_started_at" TEXT,
    "latest_child_ended_at" TEXT,
    "window_partial" BOOLEAN NOT NULL,
    "observed_at" TEXT NOT NULL,

    PRIMARY KEY ("source_path", "root_raw_id")
);

-- No separate `source_path` index: the composite primary key above is indexed on
-- (`source_path`, `root_raw_id`), and SQLite serves a leading-column lookup from
-- that index, so the per-store reconcile and the per-store delete are already
-- covered. A standalone index would duplicate it.
--
-- The CREATE carries IF NOT EXISTS so the migration runner's statement-level
-- idempotent heal can re-apply this migration on an untracked-but-populated
-- store (see migration-runner.ts) instead of throwing "table already exists".

-- ISS-5266: proof that one store was SCANNED end to end.
--
-- Without this, an empty withhold set is ambiguous three ways: the store
-- withheld nothing, the store was never imported, or a reconcile failed. Only
-- the first means "complete", and the diagnostics tab was claiming it for all
-- three. This row is written in the SAME transaction as the reconcile, so it
-- exists only when a full-store pass actually landed; an empty withhold set
-- ALONGSIDE a row here is a positive completeness claim, and an empty set with
-- no row here is UNKNOWN and must render as such.
CREATE TABLE IF NOT EXISTS "opencode_withheld_scan" (
    "source_path" TEXT NOT NULL PRIMARY KEY,
    "observed_at" TEXT NOT NULL
);
