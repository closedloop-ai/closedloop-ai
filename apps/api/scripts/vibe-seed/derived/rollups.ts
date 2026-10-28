import { withDb } from "@repo/database";
import {
  runSearchDocumentBackfill,
  toSearchBackfillClient,
} from "@repo/database/scripts/backfill-search-documents";
import { refreshBranchAnalyticsRollupBatch } from "@/app/branches/branch-analytics-rollup";
import type { VibeSeedContext } from "../stage";

/**
 * ISS-12017: the derived projections, filled by the producers that keep them
 * current in production, after every other stage has written its source rows.
 */

/** Bounds the batch loop; one batch already covers hundreds of sessions. */
const MAX_ROLLUP_BATCHES = 50;

/** Same room the backfill's own CLI gives a full sweep. */
const SEARCH_BACKFILL_TX_OPTIONS = {
  timeout: 15 * 60 * 1000,
  maxWait: 30 * 1000,
} as const;

/**
 * Refresh the Branch analytics session rollup batch by batch, the cron's
 * per-org step, until the producer reports the backfill complete. Writes
 * `BranchAnalyticsSessionRollup` and the org's `BranchAnalyticsRollupState`.
 */
export async function refreshBranchAnalyticsRollups(
  context: VibeSeedContext
): Promise<void> {
  let upserted = 0;
  // The producer's `now` is a receive-time cutoff compared against token-event
  // `created_at`, which the golden ingest stamped with the wall clock after the
  // run fixed `context.now`; the run's `now` would exclude every event.
  const asOf = new Date();
  for (let batch = 1; batch <= MAX_ROLLUP_BATCHES; batch += 1) {
    const summary = await refreshBranchAnalyticsRollupBatch({
      organizationId: context.organizationId,
      now: asOf,
    });
    upserted += summary.upsertedRows;
    if (summary.complete) {
      context.log(
        `branch analytics rollup complete after ${batch} batch(es): ${upserted} row(s) upserted`
      );
      return;
    }
  }
  throw new Error(
    `branch analytics rollup still incomplete after ${MAX_ROLLUP_BATCHES} batches`
  );
}

/** Sweep every search corpus into `SearchDocument` with the backfill's own transaction shape. */
export async function backfillSearchDocuments(
  context: VibeSeedContext
): Promise<void> {
  const counts = await withDb.tx(
    (tx) => runSearchDocumentBackfill(toSearchBackfillClient(tx)),
    SEARCH_BACKFILL_TX_OPTIONS
  );
  context.log(`search backfill wrote ${counts.total} projection row(s)`);
}
