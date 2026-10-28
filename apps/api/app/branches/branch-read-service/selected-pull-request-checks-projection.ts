import "server-only";

import {
  CheckRowOutcomeBucket,
  checkRowOutcomeBucket,
  isWholeMeasuredPopulation,
} from "@repo/api/src/types/branch-check-projection";
import { ChecksStatus } from "@repo/api/src/types/branch-checks";
import type { BranchViewCheckProjection } from "@repo/api/src/types/branch-view";
import { BranchViewChecksProviderState } from "@repo/api/src/types/branch-view";
import { projectBranchStatusChecks } from "@/lib/branch-status-checks";
import { BRANCH_SELECTED_PULL_REQUEST_CHECK_ROW_LIMIT } from "../branch-read-selects";

/**
 * The stored current-head checks projection, as the Branch detail read selects
 * it.
 *
 * `checks_status` is deliberately ABSENT. The head-sha gate does not protect
 * that column (see `foldMeasuredChecks`), so this projection must not be
 * able to reach it — leaving the field out makes serving it a typecheck error
 * rather than a judgment call the next editor has to get right.
 */
export type BranchStoredChecksProjectionInput = {
  checksDetailHeadSha: string | null;
  checksDetailTotalCount: number;
  checksDetailTruncated: boolean;
  checksDetailProviderState: string | null;
  checksDetailUnavailableReason: string | null;
  checksDetailUpdatedAt: Date | null;
  statusChecks: readonly {
    providerKey: string;
    headSha: string;
    kind: string;
    name: string;
    status: string | null;
    conclusion: string | null;
    targetUrl: string | null;
    position: number;
  }[];
};

/** What the Branch detail may say about the SELECTED pull request's checks. */
export type BranchDetailSelectedPullRequestChecks = {
  checksStatus: ChecksStatus | null;
  checksPassed: number | null;
  checksTotal: number | null;
  checks?: BranchViewCheckProjection;
};

const NOTHING_MEASURED: BranchDetailSelectedPullRequestChecks = {
  checksStatus: null,
  checksPassed: null,
  checksTotal: null,
};

/**
 * ISS-8241 Half A: the SELECTED pull request's OWN measured checks, or nothing.
 *
 * A check run belongs to a COMMIT, so the stored rows are this pull request's
 * exactly while they were measured at this pull request's own head — and are
 * some other revision's the moment they were not. `projectBranchStatusChecks`
 * already enforces that equality between the head it is given and
 * `checksDetailHeadSha`, so passing the PULL REQUEST's head is the whole rule
 * for the ROWS; every other outcome is the absent form, never the branch's
 * current answer borrowed for a pull request that no producer measured.
 *
 * The head gate is necessary and not sufficient, because it protects only the
 * columns keyed to that head. Everything this function returns is therefore
 * derived from the gated rows themselves — see `foldMeasuredChecks` for
 * the column that looks head-honest and is not.
 *
 * The three absences stay apart on the wire and must stay apart in the render:
 * nothing measured at this head returns no `checks` at all; a measured attempt
 * the provider failed returns `checks.providerState = provider_unavailable` with
 * NO rollup, because `checks_status` is not written on that path and still holds
 * whatever the previous head concluded; a measured empty population returns
 * `no_checks`, which is a fact about this pull request rather than an absence.
 *
 * `checksPassed` is counted from those same rows once every one of them is in
 * hand, and stays null while any is missing — see `foldMeasuredChecks`.
 */
export function projectSelectedPullRequestChecks(
  branch: BranchStoredChecksProjectionInput,
  selectedPullRequestHeadRefOid: string | null
): BranchDetailSelectedPullRequestChecks {
  const head = selectedPullRequestHeadRefOid?.trim().toLowerCase();
  if (!head) {
    return NOTHING_MEASURED;
  }
  // The read is bounded but NOT head-scoped, so a row left behind by an earlier
  // head can arrive in the window. Filter first: counted before the filter, such
  // a row inflates `rows.length` into a truncation that never happened, and
  // ordered before it, it can push a genuine current-head row out of the cap.
  const stored = branch.checksDetailHeadSha?.toLowerCase() ?? null;
  const rows = branch.statusChecks
    .map((row) => ({ ...row, headSha: row.headSha.toLowerCase() }))
    .filter((row) => row.headSha === stored);
  // A stale-head row shares both the window and the `position` ordering with
  // this head's, so the cap can be spent on rows the filter then drops — leaving
  // `rows` SHORT of the measured population without ever reaching the limit
  // itself. Against the cap alone that reads as a complete list, which is the
  // one answer this projection must never give. So a SATURATED window whose
  // surviving rows do not reach the stored total is a truncation too. The window
  // must actually be saturated: unsaturated, every stored row is already in hand,
  // and a short set is the producer's own truncation, which
  // `checksDetailTruncated` already carries. This reports the shortfall; ISS-8311
  // head-scopes the read so there is none to report.
  const windowSaturated =
    branch.statusChecks.length > BRANCH_SELECTED_PULL_REQUEST_CHECK_ROW_LIMIT;
  const overflowed =
    rows.length > BRANCH_SELECTED_PULL_REQUEST_CHECK_ROW_LIMIT ||
    (windowSaturated && rows.length < branch.checksDetailTotalCount);
  const checks = projectBranchStatusChecks({
    headSha: head,
    checksDetailHeadSha: stored,
    checksDetailTotalCount: branch.checksDetailTotalCount,
    checksDetailTruncated: branch.checksDetailTruncated || overflowed,
    checksDetailProviderState: branch.checksDetailProviderState,
    checksDetailUnavailableReason: branch.checksDetailUnavailableReason,
    checksDetailUpdatedAt: branch.checksDetailUpdatedAt,
    statusChecks: rows.slice(0, BRANCH_SELECTED_PULL_REQUEST_CHECK_ROW_LIMIT),
  });
  if (!checks) {
    return NOTHING_MEASURED;
  }
  if (
    checks.providerState === BranchViewChecksProviderState.ProviderUnavailable
  ) {
    return { ...NOTHING_MEASURED, checks };
  }
  return {
    ...foldMeasuredChecks(checks),
    checksTotal: checks.totalCount,
    checks,
  };
}

/**
 * Both headlines COUNTED FROM the rows this head was measured at, never read
 * from `checks_status`, and off ONE classification of those rows so the word
 * and the number cannot disagree about a row.
 *
 * The head-sha gate above protects `checks_detail_head_sha` and the rows keyed
 * to it. It does NOT protect `checks_status`, which has writers that move it at
 * an UNCHANGED head and leave both untouched: a `synchronize` redelivery stamps
 * it `PENDING` (`pull-request-action-application.ts` — `synchronize` is
 * explicitly exempt from the duplicate-delivery suppression in
 * `shouldApplyPullRequestLifecycleUpdate`, and the invalidation beside it fires
 * only on a head CHANGE), and the backfill lane sets it from the PR-list rollup
 * (`github-projection-writer.ts`, whose invalidation is gated the same way).
 * Serving that column here would pass the gate while describing something else —
 * the exact defect this projection exists to stop, one field short of the goal.
 */
function foldMeasuredChecks(
  checks: BranchViewCheckProjection
): Pick<
  BranchDetailSelectedPullRequestChecks,
  "checksStatus" | "checksPassed"
> {
  const roles = checks.items.map((item) => {
    const bucket = checkRowOutcomeBucket(item.status, item.conclusion);
    return bucket === null ? null : CHECK_ROW_ROLE[bucket];
  });
  const whole = isWholeMeasuredPopulation(checks);
  return {
    checksStatus: rollupFromRoles(roles, whole),
    // ISS-12203: a count over a partial population is not this population's
    // count. Whether a partial one renders at all is a product question the
    // ticket left open, so the absent form is what a shortfall serves.
    //
    // A population holding no row a pass could be built from gets no count
    // either. `BranchChecksStatusValue` prefers the count over the word, so
    // `0/0 passing` over a measured-empty population, or `N/N passing` over N
    // purely abstaining rows, would replace the `Unknown` those populations'
    // own verdict reports (marisolashgrove, tamsinb on #8740).
    checksPassed:
      whole && roles.includes(CheckRowRole.Carries)
        ? countedAsPassed(roles)
        : null,
  };
}

/**
 * A verdict is only as complete as the population behind it. A FAILURE or an
 * unfinished run is conclusive from a single row, so both survive truncation;
 * `Passing` is a claim about EVERY check and is withheld the moment a row is
 * missing or carries a word this product cannot read. The alternative is a green
 * headline over a population containing a red row nobody fetched.
 *
 * That completeness test is `isWholeMeasuredPopulation`, which the Branch detail
 * render withholds its passing TONE on too (ISS-8629). It is shared rather than
 * restated because the two layers once diverged on it: this fold returned
 * `UNKNOWN` over the same population the screen drew green.
 */
function rollupFromRoles(
  roles: readonly (CheckRowRole | null)[],
  wholePopulation: boolean
): ChecksStatus {
  if (roles.includes(CheckRowRole.Fails)) {
    return ChecksStatus.Failing;
  }
  if (roles.includes(CheckRowRole.Pends)) {
    return ChecksStatus.Pending;
  }
  // A word this product cannot read is not evidence of a pass.
  if (roles.includes(null)) {
    return ChecksStatus.Unknown;
  }
  return wholePopulation && roles.includes(CheckRowRole.Carries)
    ? ChecksStatus.Passing
    : ChecksStatus.Unknown;
}

/**
 * ISS-12203, operator ruling 2026-10-12: a row that ran and reached no verdict
 * of its own counts toward the number, because the verdict above already holds
 * that it does not spoil a pass — so a `Passing` population renders N/N instead
 * of a figure its own verdict contradicts.
 *
 * An unreadable row counts toward neither, on the same rule as the verdict: a
 * word this product cannot read is not evidence of a pass.
 */
function countedAsPassed(roles: readonly (CheckRowRole | null)[]): number {
  return roles.filter(
    (role) => role !== null && CHECK_ROW_COUNTS_AS_PASSED[role]
  ).length;
}

/** What one classified row does to the verdict over the whole population. */
const CheckRowRole = {
  Fails: "fails",
  Pends: "pends",
  /** A row a pass can be built from. */
  Carries: "carries",
  /** Ran, reached no verdict of its own, and neither makes nor breaks a pass. */
  Abstains: "abstains",
} as const;
type CheckRowRole = (typeof CheckRowRole)[keyof typeof CheckRowRole];

/**
 * Exhaustive over the bucket union on purpose. A side inventory of
 * `includes(…)` calls compiles unchanged when a fifth bucket is added, and that
 * member then falls past every check above into the `Passing` branch — a new
 * failure class reading as a green headline, which is the exact hazard the
 * unknown-word rule exists to stop. Naming every member here makes it a `tsc`
 * error instead.
 */
const CHECK_ROW_ROLE: Record<CheckRowOutcomeBucket, CheckRowRole> = {
  [CheckRowOutcomeBucket.Failed]: CheckRowRole.Fails,
  [CheckRowOutcomeBucket.Pending]: CheckRowRole.Pends,
  [CheckRowOutcomeBucket.Passed]: CheckRowRole.Carries,
  [CheckRowOutcomeBucket.Inconclusive]: CheckRowRole.Abstains,
};

/**
 * Exhaustive over the role union for the reason `CHECK_ROW_ROLE` above gives
 * for the buckets. A fifth role would otherwise be excluded from the count in
 * silence while the verdict still weighs it.
 */
const CHECK_ROW_COUNTS_AS_PASSED: Record<CheckRowRole, boolean> = {
  [CheckRowRole.Fails]: false,
  [CheckRowRole.Pends]: false,
  [CheckRowRole.Carries]: true,
  [CheckRowRole.Abstains]: true,
};
