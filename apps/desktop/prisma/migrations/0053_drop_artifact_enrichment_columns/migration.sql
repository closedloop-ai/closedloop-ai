-- PLN-1535 (M5 follow-up): drop the `artifacts` enrichment column family with
-- the local-`gh` enrichment lane it existed to serve.
--
-- The lane (FEA-1899) leased artifact rows, called GitHub through the local `gh`
-- binary, wrote LOC back, and stamped its progress across five columns:
-- `enrichment_state` ('provisional' → 'final'), `enrichment_source`,
-- `enrichment_attempts`, `lease_at` and `enriched_at`. PLN-1535 moved desktop
-- GitHub data onto the cloud projection: M5 deletion 1 removed the sweep, and
-- M5 deletion 2 retired the gateway PR data routes it called. Nothing has
-- written any of these five columns since.
--
-- What replaced it is `cloud-github-overlay-store.ts`, which projects cloud PR
-- diff stats straight onto `artifacts.lines_*` (ISS-5413) with no state machine
-- to track: the cloud row IS the state, so a local progress marker for it would
-- be a second, staler copy.
--
-- Every read is removed in this same change set, and each one was already
-- decided:
--   * sync-source.ts gated its commit-LOC arm on
--     `enrichment_state IN ('provisional','final')`. No writer means no new
--     commit artifact can satisfy it, and the columns were always written
--     together, so a row with `lines_added` set always had a state — the
--     surviving `lines_added IS NOT NULL` guard admits exactly the same rows.
--   * write-core-pull-requests.ts and rebuild-session-tx.ts treated
--     `enrichment_state = 'final'` as "GitHub confirmed this branch_name", to
--     spare a legitimately-`main` PR branch from the default-branch poison
--     guard. Unreachable for anything imported since PLN-1535.
--   * pr-link-maintenance.ts's FEA-1959 remediation required BOTH
--     `enrichment_state = 'final'` AND `enriched_at IS NULL` — mutually
--     exclusive, since the lane stamped `enriched_at` whenever it committed a
--     state. It has matched zero rows on every boot since it shipped.
--
-- `idx_artifacts_sweep` indexed `enrichment_state` for the sweep's claim query
-- and is dropped first: SQLite refuses to drop a column an index references.
--
-- destructive-migration-ok(artifacts.enrichment_state): No reader exists on any
-- build that can still serve this store. The FEA-3331 failure mode the gate
-- guards against is a CLOUD one — a base-branch deployment still serving reads
-- while its paired app build lags the schema. It does not apply here: this is
-- the desktop-local SQLite store, where exactly one app build owns the file at a
-- time, and the forward-only migration runner REFUSES TO BOOT a downgraded app
-- against a store migrated by a newer build. So an older build carrying the
-- column in its generated client can never open a store where this migration has
-- run; there is no window in which a stale reader sees the dropped column. The
-- data is a local progress marker for a deleted sweep — it is in no wire, cloud,
-- or cross-repo contract, and the LOC it guarded lives in `lines_*`, untouched.
-- destructive-migration-ok(artifacts.enrichment_source): Same lane, same
-- reasoning. Written only beside enrichment_state; never read by anything but
-- the deleted sweep's own diagnostics.
-- destructive-migration-ok(artifacts.enrichment_attempts): Same lane, same
-- reasoning. The sweep's per-row retry counter; no consumer outside it.
-- destructive-migration-ok(artifacts.lease_at): Same lane, same reasoning. The
-- sweep's row lease; meaningless without a sweep to hold it.
-- destructive-migration-ok(artifacts.enriched_at): Same lane, same reasoning.
-- Its only surviving reference was the FEA-1959 guard removed above.
DROP INDEX IF EXISTS "idx_artifacts_sweep";

ALTER TABLE "artifacts" DROP COLUMN "enrichment_state";
ALTER TABLE "artifacts" DROP COLUMN "enrichment_source";
ALTER TABLE "artifacts" DROP COLUMN "enrichment_attempts";
ALTER TABLE "artifacts" DROP COLUMN "lease_at";
ALTER TABLE "artifacts" DROP COLUMN "enriched_at";
