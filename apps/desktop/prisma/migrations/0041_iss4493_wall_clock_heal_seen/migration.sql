-- ISS-4493 (follow-up to ISS-4447 #3976): durable per-(source_key, data_revision)
-- completion marker for the FEA-3427 wall-clock heal enqueue. Mirrors the
-- `*_backfill_seen` high-water-mark tables. Keyed by (source_key, data_revision)
-- with no FK to `sessions` (the marker is identity+revision-scoped, not
-- session-scoped) — mirrors the FK-less `pr_backfill_seen`. A row is written ONLY
-- after a confirmed online+authenticated heal enqueue; its absence keeps the heal
-- eligible to retry on the next online boot (the no-stranding invariant).
CREATE TABLE IF NOT EXISTS "wall_clock_heal_seen" (
    "source_key" TEXT NOT NULL,
    "data_revision" INTEGER NOT NULL,
    "healed_at" TEXT NOT NULL,
    PRIMARY KEY ("source_key", "data_revision")
);
