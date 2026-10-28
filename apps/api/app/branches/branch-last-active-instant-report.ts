import type { BranchRow } from "@repo/api/src/types/branch";
import { countImpossibleBranchLastActiveInstants } from "@repo/lib/branches/branch-list-page";
import { log } from "@repo/observability/log";
import {
  EmissionRollupCause,
  FixedWindowEmissionThrottle,
} from "@/lib/observability/fixed-window-emission-throttle";
import { BRANCH_LAST_ACTIVE_COHORT_INVALID_EVENT } from "./branch-last-active-cohort";

export const BranchLastActiveInvalidReason = {
  ImpossibleInstant: "impossible_last_active_instant",
} as const;
export type BranchLastActiveInvalidReason =
  (typeof BranchLastActiveInvalidReason)[keyof typeof BranchLastActiveInvalidReason];

/**
 * Which row set was scanned, because the two list paths hold different ones and
 * a count means nothing without it. Closed, so it is safe in a throttle key.
 */
export const BranchLastActiveScanScope = {
  /** The whole filtered pre-pagination cohort. */
  Cohort: "cohort",
  /** Only the rows on the page being returned. */
  Page: "page",
} as const;
export type BranchLastActiveScanScope =
  (typeof BranchLastActiveScanScope)[keyof typeof BranchLastActiveScanScope];

type InstantDetectionScope = {
  organizationId: string;
  scanScope: BranchLastActiveScanScope;
  reason: BranchLastActiveInvalidReason;
};

/**
 * Count impossible Last-active instants in `rows` and report a non-zero result.
 *
 * Returns the count so a caller can assert on it; it is deliberately NOT put on
 * the response envelope, because that would be a new wire field for a producer
 * diagnostic no client asked for.
 */
export function reportImpossibleBranchLastActiveInstants(input: {
  rows: readonly BranchRow[];
  nowIso: string;
  organizationId: string;
  scanScope: BranchLastActiveScanScope;
}): number {
  // Reporting must never change what the caller gets back: this runs inside a
  // list response that has already been computed, so a sink failure would
  // otherwise become a way to fail a request that had nothing wrong with it.
  try {
    throttle.drainExpired(Date.now());
    const impossibleRowCount = countImpossibleBranchLastActiveInstants(
      input.rows,
      input.nowIso
    );
    if (impossibleRowCount > 0) {
      reportImpossibleInstants(input, impossibleRowCount);
    }
    return impossibleRowCount;
  } catch (error) {
    log.warn(
      "[branch-last-active-instant] Failed to report impossible instants",
      {
        event: BRANCH_LAST_ACTIVE_COHORT_INVALID_EVENT,
        organizationId: input.organizationId,
        error: error instanceof Error ? error.message : String(error),
      }
    );
    return 0;
  }
}

/** Exported for tests, which need a clean keyspace and their own window. */
export function resetBranchLastActiveInstantThrottle(): void {
  throttle.clear();
}

function reportImpossibleInstants(
  input: {
    rows: readonly BranchRow[];
    organizationId: string;
    scanScope: BranchLastActiveScanScope;
  },
  impossibleRowCount: number
): void {
  const detectionScope: InstantDetectionScope = {
    organizationId: input.organizationId,
    scanScope: input.scanScope,
    reason: BranchLastActiveInvalidReason.ImpossibleInstant,
  };
  const decision = throttle.record(
    `${input.organizationId}${KEY_DELIMITER}${input.scanScope}`,
    detectionScope,
    Date.now()
  );
  if (decision.flushedSuppressedCount > 0) {
    emitAggregate(
      detectionScope,
      decision.flushedSuppressedCount,
      EmissionRollupCause.Window
    );
  }
  if (!decision.emit) {
    return;
  }
  // Counts only. The offending VALUE is a stored activity timestamp, and the row
  // it came from is identified by the count plus the org — enough to find it with
  // a query, without putting customer activity data in a log line.
  log.warn(BRANCH_LAST_ACTIVE_COHORT_INVALID_EVENT, {
    ...detectionScope,
    impossibleRowCount,
    scannedRowCount: input.rows.length,
    occurrences: 1,
  });
}

/**
 * The rollup for occurrences a closed window suppressed, as ONE line carrying
 * their total. Same `aggregated`/`flushedBy` shape as the cohort event's rollup,
 * so one Datadog query reads both.
 */
function emitAggregate(
  detectionScope: InstantDetectionScope,
  occurrences: number,
  flushedBy: EmissionRollupCause
): void {
  log.warn(BRANCH_LAST_ACTIVE_COHORT_INVALID_EVENT, {
    ...detectionScope,
    occurrences,
    aggregated: true,
    flushedBy,
  });
}

/** `scanScope` is a closed vocabulary, so `|` cannot collide with a key part. */
const KEY_DELIMITER = "|";

/**
 * Per-(org, scan-scope) emission bound, per `apps/api/AGENTS.md`'s Emission and
 * Abuse Control rule.
 *
 * Branches List is polled every 120s and a corrupt stored instant persists until
 * someone fixes the data, so an unthrottled warn would emit on every poll for as
 * long as the row exists. Both key parts are bounded and low-cardinality, so the
 * keyspace cannot be grown by caller input. The same lower-bound caveat the
 * cohort event documents applies to `sum(occurrences)` here.
 */
const throttle = new FixedWindowEmissionThrottle<InstantDetectionScope>({
  onFlush: (detectionScope, suppressedCount, cause) =>
    emitAggregate(detectionScope, suppressedCount, cause),
});
