import "server-only";

import { log } from "@repo/observability/log";
import { setAppSpanAttributes } from "@repo/observability/tracing/spans";
import {
  EmissionRollupCause,
  FixedWindowEmissionThrottle,
} from "@/lib/observability/fixed-window-emission-throttle";
import { createThrottledMonitoredEvent } from "@/lib/observability/throttled-monitored-event";
import {
  type BranchProductReadWorkload,
  withBranchProductReadSnapshot,
} from "./branch-product-read-snapshot";

/**
 * @file branch-list-enrichment.ts
 * @description ISS-10297 (incident ISS-10295) — the ONE failure domain owning
 * the optional analytics reads on the REQUIRED Branches list path.
 *
 * `apps/api/app/branches/AGENTS.md` ("Enrichment must not be fatal") is the
 * contract: a usage/identity/divisor read that times out must return the branch
 * rows with the analytics omitted, never reject the list.
 *
 * Two DIFFERENT failures have to be survived, and a `try`/`catch` around the
 * read survives only the first:
 *
 * 1. The read fails WITHOUT poisoning the snapshot — a programming defect, or
 *    any non-database throw. The transaction is still live, so catching it here
 *    is sufficient and the rest of the list read commits normally.
 * 2. The read fails BECAUSE its statement was cancelled or the snapshot
 *    expired. PostgreSQL then marks the whole transaction ABORTED: every later
 *    statement fails with 25P02 and Prisma rejects the interactive transaction
 *    at COMMIT with P2028. Catching it inside the callback cannot revive that
 *    transaction, so `/branches` keeps 500ing — the exact incident this is
 *    meant to fix (#7312 review: whitlockk, and the codex P1).
 *
 * {@link readBranchListFailingOpen} is the recovery for case 2, and it sits
 * OUTSIDE `withBranchProductReadSnapshot` because that is the only place the
 * rolled-back transaction can be replaced with a fresh one.
 *
 * `failed` is what connects the two halves: the catch records that an OPTIONAL
 * read was the thing that broke, so the outer recovery can distinguish an
 * enrichment failure (retry without it) from a CORE row-read failure (rethrow —
 * without rows there is no list).
 */

/** Which best-effort enrichment read had no answer. */
export const BranchListEnrichmentRead = {
  Identity: "identity",
  SessionBranchDivisor: "session_branch_divisor",
  GlobalDivisorCandidates: "global_divisor_candidates",
  PushLoc: "push_loc",
  /**
   * ISS-12346: the cohort's SQL-folded PR and cost facts. Unlike its siblings
   * this read runs on its own connection OUTSIDE the snapshot, so it has no
   * domain to record into and no transaction to abort — the failed-open record
   * is the whole recovery.
   */
  MetricFacts: "metric_facts",
  /**
   * ISS-12663: the rows' org custom-field values, read after the snapshot like
   * `MetricFacts`, so its failed-open record is the whole recovery.
   */
  CustomFieldValues: "custom_field_values",
} as const;
export type BranchListEnrichmentRead =
  (typeof BranchListEnrichmentRead)[keyof typeof BranchListEnrichmentRead];

/** Whether the failure was an external read or a defect in this code. */
export const BranchListEnrichmentFailureKind = {
  ProgrammingError: "programming_error",
  ReadError: "read_error",
} as const;
export type BranchListEnrichmentFailureKind =
  (typeof BranchListEnrichmentFailureKind)[keyof typeof BranchListEnrichmentFailureKind];

/**
 * Per-request state for the optional reads. NOT module state: a domain belongs
 * to one list read, so a concurrent request can never observe another's
 * failure.
 */
export type BranchListEnrichmentDomain = {
  /** Reads to skip outright, seeded on the retry pass from what already failed. */
  readonly skip: ReadonlySet<BranchListEnrichmentRead>;
  /** An optional read threw. Read by the recovery AFTER the transaction rejects. */
  failed: boolean;
  /**
   * Reads with no answer. A caller MUST consult this before publishing an empty
   * result: an empty map from a failed read is "unknown", and rendering it as a
   * measured zero is the distinction collapse this whole module exists to stop.
   */
  readonly unavailable: Set<BranchListEnrichmentRead>;
};

/**
 * The retry pass skips only the reads that ACTUALLY failed, not every optional
 * read. A divisor timeout should not also cost the page its owner and
 * collaborator identities — those drive the list's owner/collaborator facets,
 * and dropping them silently removes rows from a filtered list
 * (`packages/app/branches/lib/branch-row.ts:400`).
 */
export function createBranchListEnrichmentDomain(
  skip: Iterable<BranchListEnrichmentRead> = []
): BranchListEnrichmentDomain {
  const skipSet = new Set(skip);
  return { skip: skipSet, failed: false, unavailable: new Set(skipSet) };
}

type BranchProductReadSnapshotClient = Parameters<
  Parameters<typeof withBranchProductReadSnapshot>[1]
>[0];

/**
 * Run the list read on a bounded snapshot, and survive an optional read that
 * aborted it by re-running ONCE on a fresh snapshot with the failed reads
 * skipped.
 *
 * The retry is bounded to one attempt and only fires when an OPTIONAL read was
 * implicated: a core row-read failure rethrows untouched, because a list with
 * no rows is not a degraded answer, it is no answer. That also keeps this from
 * becoming a retry amplifier during the very incident it serves — the sweep
 * pressure behind ISS-10295 had RDS at 97-99% CPU, and a read that fails for a
 * reason other than enrichment still costs exactly one attempt.
 */
export async function readBranchListFailingOpen<Result>(
  organizationId: string,
  read: (
    db: BranchProductReadSnapshotClient,
    domain: BranchListEnrichmentDomain
  ) => Promise<Result>,
  workload: BranchProductReadWorkload
): Promise<Result> {
  const firstPass = createBranchListEnrichmentDomain();
  try {
    return await withBranchProductReadSnapshot(
      organizationId,
      (db) => read(db, firstPass),
      workload
    );
  } catch (error) {
    if (!firstPass.failed) {
      throw error;
    }
    reportBranchListEnrichmentRecovery(organizationId, firstPass, error);
    // ISS-10300: the retry gets the SAME workload budget. A cheaper deadline on
    // the second pass would make the recovery likelier to expire than the read
    // it is recovering, which is the opposite of failing open.
    return await withBranchProductReadSnapshot(
      organizationId,
      (db) => read(db, createBranchListEnrichmentDomain(firstPass.unavailable)),
      workload
    );
  }
}

/** Run one optional read inside the failure domain, or skip it outright. */
export async function runBranchListEnrichmentRead<Value>(params: {
  read: BranchListEnrichmentRead;
  domain: BranchListEnrichmentDomain;
  context: BranchListEnrichmentContext;
  load: () => Promise<Value>;
  unavailable: () => Value;
}): Promise<Value> {
  if (params.domain.skip.has(params.read)) {
    return params.unavailable();
  }
  try {
    return await params.load();
  } catch (error) {
    markBranchListEnrichmentUnavailable({
      read: params.read,
      domain: params.domain,
      context: params.context,
      error,
    });
    return params.unavailable();
  }
}

/**
 * Record that an optional read had no answer, WITHOUT producing a degraded
 * value for it.
 *
 * {@link runBranchListEnrichmentRead} is for a read whose caller can substitute
 * an empty result on the spot. An enrichment that is a JOIN inside the REQUIRED
 * page statement has no such substitute: the same rejection takes the page ids,
 * the totals and the facets with it, and there is no honest page to return. So
 * it marks the domain here and rethrows, and {@link readBranchListFailingOpen}
 * re-runs the whole read on a fresh snapshot with this enrichment skipped —
 * which is the ONLY recovery available anyway once a cancelled statement has
 * aborted the transaction.
 */
export function markBranchListEnrichmentUnavailable(params: {
  read: BranchListEnrichmentRead;
  domain: BranchListEnrichmentDomain;
  context: BranchListEnrichmentContext;
  error: unknown;
}): void {
  params.domain.failed = true;
  params.domain.unavailable.add(params.read);
  reportBranchListEnrichmentFailedOpen(
    params.read,
    params.error,
    params.context
  );
}

export type BranchListEnrichmentContext = {
  organizationId: string;
  rowCount?: number;
  sessionCount?: number;
};

const BRANCH_LIST_ENRICHMENT_FAILED_OPEN_EVENT =
  "[branches-list] enrichment read failed open";
const BRANCH_LIST_ENRICHMENT_SUPPRESSED_EVENT =
  "[branches-list] enrichment read failed open (suppressed)";
const BRANCH_LIST_ENRICHMENT_RECOVERED_EVENT =
  "[branches-list] enrichment failure aborted the snapshot; retried without it";

type BranchListEnrichmentThrottleScope = {
  organizationId: string;
  read: BranchListEnrichmentRead;
  failureKind: BranchListEnrichmentFailureKind;
};

/**
 * `/branches` is a pollable authenticated endpoint with no rate limiter in
 * front of it, so an outage that makes every list call fail open would emit one
 * `log.error` per request — an unbounded error stream from a single degraded
 * org (#7312 review, whitlockk; `apps/api/AGENTS.md` "Emission and Abuse Control").
 *
 * The org is the amplification unit and `(read, failureKind)` is the whole
 * reason facet, so that triple IS the key, spent as a per-window budget.
 * Occurrences past it are counted and flushed as an aggregate rollup rather
 * than dropped, so `sum(suppressed) + count(detail)` still recovers the true
 * occurrence count. Suppression changes nothing the caller receives: the
 * response has already been degraded before this is reached.
 *
 * Exported so a suite can `clear()` it between cases — the budget is
 * module-level state that would otherwise carry from one case into the next and
 * make the file order-dependent. Production code must never call `clear()`: it
 * discards pending suppressed counts instead of flushing them.
 */
export const branchListEnrichmentFailureThrottle =
  new FixedWindowEmissionThrottle<BranchListEnrichmentThrottleScope>({
    onFlush: (scope, suppressedCount, cause) =>
      logBranchListEnrichmentSuppressed(scope, suppressedCount, cause),
  });

/**
 * Failing open is never silent. The log carries the failure KIND so a database
 * timeout and a programming defect are distinguishable without reading the
 * stack: a `TypeError` here means this code is wrong, not that the database was
 * slow, and the two must not read alike.
 *
 * The span attributes are deliberately NOT throttled. `setAppSpanAttributes`
 * annotates the request's EXISTING span rather than emitting a new event, so it
 * is bounded by request volume either way, and it is what makes the degraded
 * requests findable in a trace search once the log has been rolled up.
 *
 * Exported for the reads that fail open OUTSIDE a `BranchListEnrichmentDomain`
 * — the Branch detail's push-LOC read has no domain to record into, but its
 * failure is the same event on the same monitor, and a second
 * reporter would be a second thing to wire a monitor to.
 */
export function reportBranchListEnrichmentFailedOpen(
  read: BranchListEnrichmentRead,
  error: unknown,
  context: BranchListEnrichmentContext
): void {
  const failureKind = branchListEnrichmentFailureKind(error);
  const now = Date.now();
  // Every failed-open read reaches here, so this is the terminal path the
  // throttle needs: an org whose burst is followed by quiet still gets its
  // rollup instead of leaving it pending until the same org degrades again.
  branchListEnrichmentFailureThrottle.drainExpired(now);
  const scope = { organizationId: context.organizationId, read, failureKind };
  const decision = branchListEnrichmentFailureThrottle.record(
    `${context.organizationId}\u0000${read}\u0000${failureKind}`,
    scope,
    now
  );
  if (decision.flushedSuppressedCount > 0) {
    logBranchListEnrichmentSuppressed(
      scope,
      decision.flushedSuppressedCount,
      EmissionRollupCause.Window
    );
  }
  setAppSpanAttributes({
    "branches.list.enrichment.failed_open": true,
    "branches.list.enrichment.failed_open.read": read,
    "branches.list.enrichment.failed_open.failure_kind": failureKind,
  });
  if (!decision.emit) {
    return;
  }
  log.error(BRANCH_LIST_ENRICHMENT_FAILED_OPEN_EVENT, {
    ...context,
    read,
    failureKind,
    errorName: error instanceof Error ? error.name : typeof error,
    error,
  });
}

function logBranchListEnrichmentSuppressed(
  scope: BranchListEnrichmentThrottleScope,
  suppressedCount: number,
  cause: EmissionRollupCause
): void {
  log.error(BRANCH_LIST_ENRICHMENT_SUPPRESSED_EVENT, {
    ...scope,
    suppressedCount,
    cause,
  });
}

/**
 * Bounded like the failed-open event: the polled analytics routes reach the
 * recovery too, so an outage would otherwise emit one line per request (#8138
 * review, whitlockk). One line per (org, unavailable reads) per window; the rest
 * roll up under the same event name with their `occurrences`.
 *
 * Exported so a suite can `clear()` it between cases; production code must not.
 */
const branchListEnrichmentRecoveryEvent = createThrottledMonitoredEvent();
export const branchListEnrichmentRecoveryThrottle =
  branchListEnrichmentRecoveryEvent.throttle;

/**
 * The snapshot was aborted by an optional read and is being retried without it.
 * Distinct from the failed-open record above, which says an analytics field is
 * missing; THIS says the list would have 500'd and did not.
 */
function reportBranchListEnrichmentRecovery(
  organizationId: string,
  domain: BranchListEnrichmentDomain,
  error: unknown
): void {
  const unavailableReads = [...domain.unavailable].sort();
  branchListEnrichmentRecoveryEvent.drainExpired(Date.now());
  branchListEnrichmentRecoveryEvent.report(
    `${organizationId}\u0000${unavailableReads.join(",")}`,
    {
      event: BRANCH_LIST_ENRICHMENT_RECOVERED_EVENT,
      payload: { organizationId, unavailableReads },
    },
    { errorName: error instanceof Error ? error.name : typeof error, error }
  );
  setAppSpanAttributes({
    "branches.list.enrichment.snapshot_retried": true,
  });
}

function branchListEnrichmentFailureKind(
  error: unknown
): BranchListEnrichmentFailureKind {
  const isProgrammingDefect =
    error instanceof TypeError ||
    error instanceof RangeError ||
    error instanceof ReferenceError ||
    error instanceof SyntaxError;
  if (isProgrammingDefect) {
    return BranchListEnrichmentFailureKind.ProgrammingError;
  }
  return BranchListEnrichmentFailureKind.ReadError;
}
