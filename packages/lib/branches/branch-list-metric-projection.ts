import { BranchStatus } from "@repo/api/src/types/branch";
import {
  type BranchListMetricBundle,
  BranchMetricPeriod,
  BranchMetricTerminalStatus,
  type BranchMetricTerminalStatus as MetricTerminalStatus,
} from "@repo/api/src/types/branch-metrics";
import { listQueryWindowBoundMs } from "@repo/api/src/types/list-query-ordering-semantics";
import type { BranchMetricCostFacts } from "./branch-cost-facts";
import type { BranchPenseroPointsInput } from "./branch-detail-pensero-points";
import {
  type BranchListMetricInput,
  type BranchMetricActivityEvidence,
  type BranchMetricCostContribution,
  type BranchMetricLocContribution,
  type BranchMetricPullRequestCoverageGap,
  type BranchMetricPullRequestEvidence,
  type BranchMetricStatusSnapshot,
  calculateBranchListMetrics,
} from "./branch-list-metrics";
import {
  type AdjacentBranchMetricWindows,
  buildAdjacentBranchMetricWindows,
} from "./branch-metric-windows";
import type { BranchMetricLocCoverageGap } from "./branch-publication-loc";
import type { BranchMetricPullRequestFacts } from "./branch-pull-request-metrics";

const DAY_MS = 24 * 60 * 60 * 1000;
const START_ONLY_PERIOD_TOLERANCE_MS = 5 * 60 * 1000;
/** Every civil UTC-offset transition is a whole number of quarter-hours. */
const OFFSET_SHIFT_STEP_MS = 15 * 60 * 1000;
/** The widest civil offset transition, covering the historical double shifts. */
const MAX_OFFSET_SHIFT_MS = 2 * 60 * 60 * 1000;
const branchMetricPeriodDays: Record<
  Exclude<BranchMetricPeriod, "all">,
  number
> = {
  [BranchMetricPeriod.SevenDays]: 7,
  [BranchMetricPeriod.ThirtyDays]: 30,
  [BranchMetricPeriod.SixtyDays]: 60,
  [BranchMetricPeriod.NinetyDays]: 90,
};

export type CanonicalBranchMetricRow = {
  id: string;
  status: BranchStatus | MetricTerminalStatus;
  lastActivityAt: string | null;
  /**
   * ISS-12309: whether the branch is deleted — the ONE fact that takes a row out
   * of the Active count while leaving it in the list and in every other metric
   * (ISS-11589). Optional: a producer that omits it says nothing about deletion
   * and the status alone decides, as it did before.
   *
   * The status cannot stand in for it. A delete-only event sets the artifact
   * Closed but leaves `isDraft` on the pull request, and `toBranchStatus` ranks
   * draft above closed, so a deleted branch carrying an observed draft pull
   * request resolves to `Draft`, which is an ACTIVE status.
   */
  deleted?: boolean;
};

export type CanonicalBranchListMetricProjectionInput = {
  branches: readonly CanonicalBranchMetricRow[];
  pullRequests?: readonly BranchMetricPullRequestEvidence[];
  pullRequestCoverageComplete?: boolean;
  /** See {@link BranchListMetricInput.pullRequestCoverageGaps}. */
  pullRequestCoverageGaps?: readonly BranchMetricPullRequestCoverageGap[];
  /** See {@link BranchListMetricInput.pullRequestFacts}. */
  pullRequestFacts?: BranchMetricPullRequestFacts;
  /** See {@link BranchListMetricInput.cohortCoverageComplete}. */
  cohortCoverageComplete?: boolean;
  startDate?: string | Date;
  endDate?: string | Date;
  now: Date;
  lastActiveEvents?: readonly BranchMetricActivityEvidence[];
  lastActiveCoverageComplete?: boolean;
  locContributions?: readonly BranchMetricLocContribution[];
  locCoverageGaps?: readonly BranchMetricLocCoverageGap[];
  locCoverageComplete?: boolean;
  locCompleteBranchIds?: readonly string[];
  costContributions?: readonly BranchMetricCostContribution[];
  costCompleteBranchIds?: readonly string[];
  locPerDollarCostContributions?: readonly BranchMetricCostContribution[];
  locPerDollarQualifyingSessionIds?: readonly string[];
  locPerDollarCostCoverageComplete?: boolean;
  /** See {@link BranchListMetricInput.canonicalEstimatedCostUsd}. */
  canonicalEstimatedCostUsd?: number;
  /** See {@link BranchListMetricInput.costFacts}. */
  costFacts?: BranchMetricCostFacts;
  /** See {@link BranchListMetricInput.aiSpendFacts}. */
  aiSpendFacts?: BranchMetricCostFacts;
  /** ISS-11117. See {@link BranchListMetricInput.penseroPoints}. */
  penseroPoints?: BranchPenseroPointsInput | null;
  statusSnapshots?: readonly BranchMetricStatusSnapshot[];
};

export type CanonicalBranchMetricWindowInput = Pick<
  CanonicalBranchListMetricProjectionInput,
  "startDate" | "endDate" | "now"
>;

/** Project the shared dictionary contract from producer-normalized evidence. */
export function projectCanonicalBranchListMetrics(
  input: CanonicalBranchListMetricProjectionInput
): BranchListMetricBundle {
  const requestedEnd = validDate(input.endDate);
  const windows = resolveCanonicalBranchMetricWindows(input);
  const currentStatusIsHistorical =
    requestedEnd !== null &&
    input.now.getTime() - requestedEnd.getTime() >
      START_ONLY_PERIOD_TOLERANCE_MS;
  return calculateBranchListMetrics(
    {
      cohortSize: input.branches.length,
      ...(input.cohortCoverageComplete === undefined
        ? {}
        : { cohortCoverageComplete: input.cohortCoverageComplete }),
      lastActiveEvents:
        input.lastActiveEvents ??
        input.branches.map((branch) => ({
          sourceEventId: branch.id,
          occurredAt: branch.lastActivityAt,
        })),
      lastActiveCoverageComplete:
        input.lastActiveCoverageComplete ??
        input.branches.every((branch) => branch.lastActivityAt !== null),
      statusSnapshots:
        input.statusSnapshots ??
        input.branches.map((branch) => ({
          branchId: branch.id,
          // A current row cannot prove its status at a materially historical
          // request boundary. Keep the stock metric unavailable instead of
          // applying today's lifecycle state retroactively.
          currentActive: currentActiveFor(branch, currentStatusIsHistorical),
          // Persisted Branch rows expose the current state, not a historical
          // state snapshot at the adjacent boundary. Comparisons fail closed.
          priorActive: null,
          lastActivityAt: branch.lastActivityAt,
        })),
      evaluationNow: input.now.toISOString(),
      locContributions: input.locContributions ?? [],
      ...(input.locCoverageGaps === undefined
        ? {}
        : { locCoverageGaps: input.locCoverageGaps }),
      ...(input.locCoverageComplete === undefined
        ? {}
        : { locCoverageComplete: input.locCoverageComplete }),
      locCompleteBranchIds: input.locCompleteBranchIds ?? [],
      ...pullRequestFields(input),
      costContributions: input.costContributions ?? [],
      costCompleteBranchIds: input.costCompleteBranchIds ?? [],
      ...(input.locPerDollarCostContributions === undefined
        ? {}
        : {
            locPerDollarCostContributions: input.locPerDollarCostContributions,
          }),
      ...(input.locPerDollarQualifyingSessionIds === undefined
        ? {}
        : {
            locPerDollarQualifyingSessionIds:
              input.locPerDollarQualifyingSessionIds,
          }),
      ...(input.locPerDollarCostCoverageComplete === undefined
        ? {}
        : {
            locPerDollarCostCoverageComplete:
              input.locPerDollarCostCoverageComplete,
          }),
      ...(input.costFacts === undefined ? {} : { costFacts: input.costFacts }),
      ...(input.aiSpendFacts === undefined
        ? {}
        : { aiSpendFacts: input.aiSpendFacts }),
      // OMITTED when absent, never forwarded as an explicit `undefined`: the
      // kernel keys "no Pensero numerator" on the field being absent.
      ...(input.penseroPoints ? { penseroPoints: input.penseroPoints } : {}),
      ...(input.canonicalEstimatedCostUsd === undefined
        ? {}
        : { canonicalEstimatedCostUsd: input.canonicalEstimatedCostUsd }),
    },
    windows
  );
}

/** Resolve the canonical adjacent metric windows for a pinned request boundary. */
export function resolveCanonicalBranchMetricWindows(
  input: CanonicalBranchMetricWindowInput
): AdjacentBranchMetricWindows {
  const requestedEnd = validDate(input.endDate);
  const start = validDate(input.startDate);
  const period = branchMetricPeriodForRange(
    input.startDate,
    requestedEnd ?? input.now,
    requestedEnd === null
  );
  const end =
    normalizeInclusiveEnd(start, requestedEnd, period) ??
    boundedEndFromStart(start, period) ??
    input.now;
  // `input.now` rides along so the prior window can be truncated to the current
  // window's elapsed span: since ISS-5809 the requested end is the in-progress
  // calendar day — UTC, or the reader's own since ISS-9619 — which puts `end` in
  // the future and would otherwise grade a partial current period against a
  // complete prior one. The truncation itself is span arithmetic over the bounds
  // it is given, so it holds under either day boundary.
  //
  // ISS-9619 (whitlockk review): the REQUESTED start is handed through rather than
  // left to be reconstructed as `end - N*24h`. Classifying a window as
  // `SevenDays` does not make the metric builder use the bounds the list used;
  // for any window admitted at a width other than exactly N*24h — a civil
  // offset transition inside it, or the start-only tolerance arms — the
  // reconstruction lands off the requested start, and the cards then describe a
  // span the rows do not.
  const windows = buildAdjacentBranchMetricWindows(
    period,
    end,
    input.now,
    start ?? undefined
  );
  return period === BranchMetricPeriod.All && start !== null
    ? {
        ...windows,
        requested: { startAt: start.toISOString(), endAt: end.toISOString() },
      }
    : windows;
}

/** Resolve the canonical fixed period; arbitrary ranges remain all-time. */
export function branchMetricPeriodForRange(
  startDate?: string | Date,
  endDate?: string | Date,
  allowStartOnlyTolerance = false
): BranchMetricPeriod {
  const start = validDate(startDate);
  if (start === null) {
    return BranchMetricPeriod.All;
  }
  const end = validDate(endDate);
  if (end === null) {
    return BranchMetricPeriod.All;
  }
  if (matchesPeriod(start, end, 7, allowStartOnlyTolerance)) {
    return BranchMetricPeriod.SevenDays;
  }
  if (matchesPeriod(start, end, 30, allowStartOnlyTolerance)) {
    return BranchMetricPeriod.ThirtyDays;
  }
  if (matchesPeriod(start, end, 60, allowStartOnlyTolerance)) {
    return BranchMetricPeriod.SixtyDays;
  }
  if (matchesPeriod(start, end, 90, allowStartOnlyTolerance)) {
    return BranchMetricPeriod.NinetyDays;
  }
  return BranchMetricPeriod.All;
}

function matchesPeriod(
  start: Date,
  end: Date,
  days: number,
  allowTolerance: boolean
): boolean {
  const durationMs = end.getTime() - start.getTime();
  const exactDurationMs = days * DAY_MS;
  const difference = Math.abs(durationMs - exactDurationMs);
  if (difference === 0 || durationMs === exactDurationMs - 1) {
    return true;
  }
  // ISS-9619: a preset window is N CALENDAR days, and since the Local day
  // boundary shipped that is no longer always N*24h — a window containing a
  // civil offset transition is short or long by the shift. Without this arm such
  // a window falls through to `All`, which returns no prior window at all, so a
  // reader in a DST zone silently loses the period-over-period comparison for
  // the week it transitions and nothing on screen says why.
  //
  // Narrow on purpose: only a whole number of quarter-hours, which is what every
  // civil offset transition is, and never zero (the exact arms above own that).
  // A window that merely LOOKS close — the 4-minutes-short case
  // `branch-list-metric-projection.test.ts` pins — is still `All`, because this
  // admits a calendar-day window, not an approximate one.
  if (isCivilOffsetShift(durationMs - (exactDurationMs - 1))) {
    return true;
  }
  if (!allowTolerance) {
    return false;
  }
  if (difference <= START_ONLY_PERIOD_TOLERANCE_MS) {
    return true;
  }
  return (
    isUtcMidnight(start) &&
    durationMs >= (days - 1) * DAY_MS &&
    durationMs < exactDurationMs
  );
}

function normalizeInclusiveEnd(
  start: Date | null,
  end: Date | null,
  period: BranchMetricPeriod
): Date | null {
  if (start === null || end === null || period === BranchMetricPeriod.All) {
    return end;
  }
  const durationMs = end.getTime() - start.getTime();
  const periodDays = daysForPeriod(period);
  if (durationMs === periodDays * DAY_MS - 1) {
    return new Date(end.getTime() + 1);
  }
  // ISS-9619 (codex review): a calendar window a civil offset transition made
  // short or long is still an INCLUSIVE one — its end is the last millisecond
  // of a day — so it needs the same exclusive-bound normalization the exact arm
  // above performs. Without it the half-open membership test
  // (`isTimestampInBranchMetricWindow`) drops that final millisecond, and the
  // metric window ends one tick before the window the list was read over.
  return isLastMillisecondOfMinute(end) ? new Date(end.getTime() + 1) : end;
}

function boundedEndFromStart(
  start: Date | null,
  period: BranchMetricPeriod
): Date | null {
  if (start === null || period === BranchMetricPeriod.All) {
    return null;
  }
  return new Date(start.getTime() + daysForPeriod(period) * DAY_MS);
}

function daysForPeriod(period: Exclude<BranchMetricPeriod, "all">): number {
  return branchMetricPeriodDays[period];
}

function isUtcMidnight(date: Date): boolean {
  return (
    date.getUTCHours() === 0 &&
    date.getUTCMinutes() === 0 &&
    date.getUTCSeconds() === 0 &&
    date.getUTCMilliseconds() === 0
  );
}

/**
 * Whether one row counts as active NOW.
 *
 * `deleted` is checked before the status (ISS-12309, whitlockk review on #8791): a
 * delete-only event sets the artifact Closed but leaves `isDraft` on the pull
 * request, and `toBranchStatus` ranks draft above closed, so the status of a
 * deleted branch with an observed draft pull request is `Draft`.
 */
function currentActiveFor(
  branch: CanonicalBranchMetricRow,
  currentStatusIsHistorical: boolean
): boolean | null {
  // A current row cannot prove its status at a materially historical request
  // boundary. Keep the stock metric unavailable instead of applying today's
  // lifecycle state retroactively.
  if (currentStatusIsHistorical) {
    return null;
  }
  return branch.deleted === true ? false : isActiveStatus(branch.status);
}

function isActiveStatus(
  status: BranchStatus | MetricTerminalStatus
): boolean | null {
  if (
    status === BranchStatus.Merged ||
    status === BranchStatus.Closed ||
    status === BranchMetricTerminalStatus.Canceled
  ) {
    return false;
  }
  if (
    status === BranchStatus.Open ||
    status === BranchStatus.Draft ||
    status === BranchStatus.Review ||
    status === BranchStatus.Blocked
  ) {
    return true;
  }
  return null;
}

/**
 * Read one REQUEST WINDOW BOUND, which is every value this module passes here.
 *
 * Anchored per ISS-9585 (whitlockk review, PR #7954): the Branch list's row path
 * anchors its bounds, and this is the metric-card path over the same request, so
 * a bare `new Date(value)` left a zone-less bound naming the host's clock and
 * gave the cards a different window than the rows they sit above — on the API
 * server and, through `resolveCanonicalBranchMetricWindows`, on every desktop.
 */
function validDate(value: string | Date | undefined): Date | null {
  if (typeof value === "string") {
    const ms = listQueryWindowBoundMs(value);
    return Number.isNaN(ms) ? null : new Date(ms);
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  return null;
}

/**
 * Is `differenceMs` the signed amount a calendar-day window is off its nominal
 * width by, because a civil UTC-offset transition falls inside it?
 *
 * Zero is excluded: an exact window is matched by its own arm, and treating 0 as
 * a "shift" would make this predicate the only matcher, hiding that.
 */
function isCivilOffsetShift(differenceMs: number): boolean {
  const shiftMs = Math.abs(differenceMs);
  return (
    shiftMs > 0 &&
    shiftMs <= MAX_OFFSET_SHIFT_MS &&
    shiftMs % OFFSET_SHIFT_STEP_MS === 0
  );
}

/**
 * Is `date` the last representable instant of its minute — i.e. the INCLUSIVE
 * upper bound of a calendar day rather than an exclusive one?
 *
 * Civil UTC offsets are whole minutes, so a local end-of-day (23:59:59.999)
 * lands on second 59, millisecond 999 in UTC whatever the reader's zone.
 */
function isLastMillisecondOfMinute(date: Date): boolean {
  return date.getUTCSeconds() === 59 && date.getUTCMilliseconds() === 999;
}

function pullRequestFields(
  input: CanonicalBranchListMetricProjectionInput
): Pick<
  BranchListMetricInput,
  | "pullRequests"
  | "pullRequestCoverageComplete"
  | "pullRequestCoverageGaps"
  | "pullRequestFacts"
> {
  return {
    ...(input.pullRequests === undefined
      ? {}
      : { pullRequests: input.pullRequests }),
    ...(input.pullRequestCoverageComplete === undefined
      ? {}
      : { pullRequestCoverageComplete: input.pullRequestCoverageComplete }),
    ...(input.pullRequestCoverageGaps === undefined
      ? {}
      : { pullRequestCoverageGaps: input.pullRequestCoverageGaps }),
    ...(input.pullRequestFacts === undefined
      ? {}
      : { pullRequestFacts: input.pullRequestFacts }),
  };
}
