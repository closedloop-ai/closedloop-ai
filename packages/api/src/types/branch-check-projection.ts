/**
 * The persisted current-head CI-check projection: one provider state, its
 * bounded rows, and the reason a read failed.
 *
 * WHY THIS IS A SEPARATE LEAF MODULE (do not merge back into `branch-view.ts`):
 * the same reason `./branch-checks` is one. ISS-8241 gives `branch.ts` a Branch
 * detail field of this shape, and `branch.ts` is imported by the desktop main
 * process, which type-checks `@repo/api` source under `nodenext` — while
 * `branch-view.ts` carries relative VALUE re-exports (`./branch-checks` and
 * this module) that the `apps/app`/`apps/api` bundler can only resolve
 * extensionless. Those two requirements are mutually exclusive, so
 * `branch-view.ts` must not enter the desktop program. This module's only
 * relative import is a type, extension-qualified, from a module already in
 * that program. `branch-view.ts` re-exports the four names that were ever
 * reached through it, so its existing consumers
 * are unaffected; the rest of this module — the row classifier, its buckets, and
 * the completeness predicate — is imported from here directly and deliberately
 * has no re-export to keep in step.
 */

import type { StatusCheckRollupFailureReason } from "./github-status.js";

/** Supported check-detail row kinds projected into Branch View. */
export const BranchViewCheckKind = {
  CheckRun: "check_run",
  StatusContext: "status_context",
} as const;
export type BranchViewCheckKind =
  (typeof BranchViewCheckKind)[keyof typeof BranchViewCheckKind];

/**
 * Durable provider-state metadata for the head a projection was measured at.
 *
 * These three are NOT interchangeable and no surface may collapse them:
 * `available` reports a population the provider returned, `no_checks` reports a
 * measured EMPTY population — a fact about the revision, not an absence — and
 * `provider_unavailable` reports that the read itself failed, so no rollup from
 * it can be believed. A revision no producer reached at all has no projection,
 * which is a fourth state and the only one spelled by absence.
 */
export const BranchViewChecksProviderState = {
  Available: "available",
  NoChecks: "no_checks",
  ProviderUnavailable: "provider_unavailable",
} as const;
export type BranchViewChecksProviderState =
  (typeof BranchViewChecksProviderState)[keyof typeof BranchViewChecksProviderState];

export type BranchViewCheck = {
  id: string;
  kind: BranchViewCheckKind;
  name: string;
  status: string | null;
  conclusion: string | null;
  targetUrl: string | null;
};

/**
 * What one provider outcome word MEANS, independent of how a surface words it.
 *
 * The render needs a tone and the read needs a rollup, and both answers come
 * from the same knowledge of which GitHub words are a failure and which are a
 * run that has not finished. Kept here once so the two cannot drift: a word
 * classified `Failed` for the tone but absent from the rollup's failing set
 * would draw a red row under a green headline.
 *
 * `Inconclusive` is a check that ran and reached no verdict of its own
 * (skipped, canceled, neutral, stale). It neither fails a population nor
 * carries it — it is the bucket for "this row has nothing to say".
 */
export const CheckRowOutcomeBucket = {
  Passed: "passed",
  Failed: "failed",
  Pending: "pending",
  Inconclusive: "inconclusive",
} as const;
export type CheckRowOutcomeBucket =
  (typeof CheckRowOutcomeBucket)[keyof typeof CheckRowOutcomeBucket];

/**
 * GitHub's check-run conclusions and status-context states, uppercased as
 * `normalizeProviderStatus` stores them.
 *
 * Deliberately NOT exhaustive over the provider's vocabulary, because that
 * vocabulary is the provider's to extend. A word absent here is `null` from
 * `checkRowOutcomeBucket`, never quietly bucketed: guessing which bucket an
 * unrecognized provider outcome belongs in is how a failing check comes to read
 * as a passing one.
 */
const CHECK_ROW_OUTCOME_BUCKET: Record<string, CheckRowOutcomeBucket> = {
  SUCCESS: CheckRowOutcomeBucket.Passed,
  FAILURE: CheckRowOutcomeBucket.Failed,
  ERROR: CheckRowOutcomeBucket.Failed,
  TIMED_OUT: CheckRowOutcomeBucket.Failed,
  ACTION_REQUIRED: CheckRowOutcomeBucket.Failed,
  STARTUP_FAILURE: CheckRowOutcomeBucket.Failed,
  CANCELLED: CheckRowOutcomeBucket.Inconclusive,
  SKIPPED: CheckRowOutcomeBucket.Inconclusive,
  STALE: CheckRowOutcomeBucket.Inconclusive,
  NEUTRAL: CheckRowOutcomeBucket.Inconclusive,
  QUEUED: CheckRowOutcomeBucket.Pending,
  IN_PROGRESS: CheckRowOutcomeBucket.Pending,
  PENDING: CheckRowOutcomeBucket.Pending,
  EXPECTED: CheckRowOutcomeBucket.Pending,
  WAITING: CheckRowOutcomeBucket.Pending,
  REQUESTED: CheckRowOutcomeBucket.Pending,
};

/**
 * Classify one check row, or `null` when this product cannot read what the
 * provider said — nothing reported at all, or a word not in the table above.
 *
 * A check run carries a `conclusion` once it finishes and only a `status` while
 * it runs; a status context carries its state in `status` and no conclusion at
 * all. The conclusion therefore wins where both are present.
 */
export function checkRowOutcomeBucket(
  status: string | null,
  conclusion: string | null
): CheckRowOutcomeBucket | null {
  const reported = conclusion ?? status;
  if (!reported) {
    return null;
  }
  return CHECK_ROW_OUTCOME_BUCKET[reported.trim().toUpperCase()] ?? null;
}

export type BranchViewCheckProjection = {
  headSha: string;
  providerState: BranchViewChecksProviderState;
  unavailableReason: StatusCheckRollupFailureReason | null;
  /**
   * The measured population, and ZERO on `provider_unavailable` — not because
   * that revision has no checks, but because a failed read never rewrote the
   * stored count, so the number sitting there is the last SUCCESSFUL read's. Read
   * `providerState` first: on that state neither this nor `truncated` nor `items`
   * is a measurement of anything.
   */
  totalCount: number;
  truncated: boolean;
  items: BranchViewCheck[];
};

/**
 * Whether every row of a measured population is in hand.
 *
 * ISS-8629: the API's rollup fold and the Branch detail render both withhold a
 * passing answer on this one predicate, so the wire verdict and the screen's
 * tone cannot adopt different completeness policies. They diverged by accident
 * once — the wire said `UNKNOWN` over a population the screen drew green — and
 * Kaito ruled on 2026-08-31 that green is withheld until the population is
 * complete. A failure or an unfinished run is conclusive from a single row and
 * is NOT subject to this; only a claim about EVERY check is.
 */
export function isWholeMeasuredPopulation(population: {
  truncated: boolean;
  totalCount: number;
  items: readonly unknown[];
}): boolean {
  return (
    !population.truncated && population.items.length === population.totalCount
  );
}
