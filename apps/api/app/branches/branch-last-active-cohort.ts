import {
  type BranchLastActiveCohort,
  type BranchListCohortScope,
  branchLastActiveCohortSchema,
  completeBranchLastActiveCohort,
} from "@repo/api/src/types/branch-list-cohort";
import { log } from "@repo/observability/log";
import {
  EmissionRollupCause,
  FixedWindowEmissionThrottle,
} from "@/lib/observability/fixed-window-emission-throttle";

export function buildBranchLastActiveCohort(
  input: {
    scope: BranchListCohortScope;
    cohortKey: string;
    evaluationNow: Date;
    total: number;
    retainedUnavailable: number;
  },
  context: { organizationId: string }
): BranchLastActiveCohort {
  const cohort = completeBranchLastActiveCohort(input);
  const parsed = branchLastActiveCohortSchema.safeParse(cohort);
  // Reporting must never change what the caller gets back: this runs inside a
  // list response that has already been computed, and the drain below is now on
  // the VALID path too, so a sink failure would otherwise have become a way to
  // fail a request that had nothing wrong with it.
  try {
    // The terminal drain (see {@link throttle}). Deliberately unconditional —
    // a burst of one signature followed by quiet is flushed by the next list
    // request from ANY org, rather than waiting for that same org to hold that
    // same broken filter set again.
    throttle.drainExpired(Date.now());
    if (!parsed.success) {
      reportInvalidCohort(
        cohort,
        parsed.error.issues.map((issue) => ({
          code: issue.code,
          path: issue.path.join("."),
        })),
        context.organizationId
      );
    }
  } catch (error) {
    log.warn("[branch-last-active-cohort] Failed to report an invalid cohort", {
      event: BRANCH_LAST_ACTIVE_COHORT_INVALID_EVENT,
      organizationId: context.organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return cohort;
}

/** Exported for tests, which need a clean keyspace and their own window. */
export function resetBranchLastActiveCohortThrottle(): void {
  throttle.clear();
}

/** The event name a Datadog query keys on. See the module docstring. */
export const BRANCH_LAST_ACTIVE_COHORT_INVALID_EVENT =
  "branch_last_active_cohort_invalid";

type CohortIssue = { code: string; path: string };

/**
 * What the key and the rollup are allowed to carry. Everything here is derived
 * from the SCHEMA, never from caller input — see {@link issueSignature}.
 */
type CohortDetectionScope = {
  organizationId: string;
  scope: BranchListCohortScope;
  issues: readonly CohortIssue[];
};

function reportInvalidCohort(
  cohort: BranchLastActiveCohort,
  issues: readonly CohortIssue[],
  organizationId: string
): void {
  const detectionScope: CohortDetectionScope = {
    organizationId,
    scope: cohort.scope,
    issues,
  };
  const decision = throttle.record(
    `${organizationId}${KEY_DELIMITER}${issueSignature(issues)}`,
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
  // Issue PATHS and CODES only. `cohortKey` serializes the caller's filter
  // values (branch names, repository names, owner logins), so the key itself
  // never leaves the process — its length is the diagnosable part.
  log.warn(BRANCH_LAST_ACTIVE_COHORT_INVALID_EVENT, {
    ...detectionScope,
    total: cohort.total,
    cohortKeyLength: cohort.cohortKey.length,
    occurrences: 1,
  });
}

/**
 * The rollup for occurrences a closed window suppressed, as ONE line carrying
 * their total. It omits `total` and `cohortKeyLength` — the suppressed
 * occurrences did not necessarily share either — and carries `aggregated` so a
 * query can tell a rollup from a first occurrence. Same shape and same
 * `flushedBy` vocabulary as `lib/observability/admin-denial-telemetry.ts`, so
 * one Datadog query reads both.
 */
function emitAggregate(
  detectionScope: CohortDetectionScope,
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

/**
 * A BOUNDED name for "the same producer bug", so one org holding one broken
 * filter set reports once per window rather than on every poll, while a
 * genuinely NEW violation still reports immediately instead of hiding behind
 * the first one's window.
 *
 * BOUNDED IS THE LOAD-BEARING WORD (#5529 review, whitlockk). This string is a
 * throttle KEY part, and a key derived from unbounded input does not throttle —
 * it moves the amplification from the log stream into the keyspace, where every
 * distinct key buys its own fresh emission budget and churns the LRU cap before
 * any entry is reused (the hole #5209 found in an earlier key). Two bounds,
 * because the pair is what makes the result finite in LENGTH and in CARDINALITY:
 * each `code:path` token is truncated, and only the first
 * {@link MAX_SIGNATURE_TOKENS} distinct tokens are kept, with a single flag —
 * not a count, which would itself vary — marking that more were dropped. Max
 * length is therefore fixed at compile time.
 *
 * Sorted and de-duplicated first, so Zod's own issue ORDER cannot mint a second
 * key for a violation already being throttled.
 *
 * Today's inputs are already small: `path` is a schema field name and `code` is
 * one of Zod's fixed issue codes, and `completeBranchLastActiveCohort` is a
 * typed constructor, so no caller-supplied string reaches either. The bounds
 * exist so that stops being something a reader has to re-derive when the schema
 * grows a nested array — whose paths WOULD carry indices.
 */
function issueSignature(issues: readonly CohortIssue[]): string {
  const tokens = [
    ...new Set(
      issues.map((issue) =>
        `${issue.code}:${issue.path}`.slice(0, MAX_SIGNATURE_TOKEN_LENGTH)
      )
    ),
  ].sort();
  const kept = tokens.slice(0, MAX_SIGNATURE_TOKENS);
  return (
    kept.join(TOKEN_DELIMITER) +
    (tokens.length > kept.length ? SIGNATURE_OVERFLOW_MARKER : "")
  );
}

/** Reason values are `code:path` tokens, so `|` cannot collide with a key part. */
const KEY_DELIMITER = "|";
const TOKEN_DELIMITER = ",";
/** One violation names a handful of fields; past that the tail is not diagnostic. */
const MAX_SIGNATURE_TOKENS = 4;
const MAX_SIGNATURE_TOKEN_LENGTH = 48;
/** A flag, not a count: a count would reintroduce a varying key part. */
const SIGNATURE_OVERFLOW_MARKER = "+";

/**
 * Per-(org, issue-signature) emission bound, per `apps/api/AGENTS.md`'s Emission
 * and Abuse Control rule.
 *
 * Branches List is polled (`BRANCHES_LIST_REFETCH_INTERVAL_MS`, 120s) and the
 * `cohortKey` overflow above is reachable through ordinary UI use, so an
 * unthrottled warn would let one member holding one large filter set emit
 * forever — an amplification vector driven by a non-adversarial caller. The
 * shared engine keeps both bounds the rule needs: at most one line per key per
 * window plus one rollup, and a hard max-entry LRU cap on the keyspace.
 *
 * WHAT `sum(occurrences)` IS WORTH. A suppressed count is materialised by an
 * EVENT, never by a clock. All three of this engine's events are wired here:
 * the next occurrence on the SAME key rolling its window over, an LRU eviction
 * through `onFlush`, and `drainExpired` — which `buildBranchLastActiveCohort`
 * runs on EVERY list request, valid cohort or not, so a burst that then goes
 * quiet is flushed by the next list request through any org rather than sitting
 * in memory. What that still does NOT buy: an instance that takes a burst and
 * then serves no further list request before freezing loses its terminal
 * window, and each serverless instance counts independently. `sum(occurrences)`
 * is therefore an eventual LOWER BOUND on the real violation volume, not a live
 * exact total — read a rise as a floor being crossed, never as the true rate.
 * Making it exact needs durable state or external aggregation, which is out of
 * this module's scope.
 */
const throttle = new FixedWindowEmissionThrottle<CohortDetectionScope>({
  onFlush: (detectionScope, suppressedCount, cause) =>
    emitAggregate(detectionScope, suppressedCount, cause),
});
