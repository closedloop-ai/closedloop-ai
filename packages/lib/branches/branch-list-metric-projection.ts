import { BranchStatus } from "@repo/api/src/types/branch";
import {
  type BranchListMetricBundle,
  BranchMetricPeriod,
  BranchMetricTerminalStatus,
  type BranchMetricTerminalStatus as MetricTerminalStatus,
} from "@repo/api/src/types/branch-metrics";
import {
  type BranchMetricActivityEvidence,
  type BranchMetricCostContribution,
  type BranchMetricLocContribution,
  type BranchMetricPullRequestEvidence,
  type BranchMetricStatusSnapshot,
  calculateBranchListMetrics,
} from "./branch-list-metrics";
import {
  type AdjacentBranchMetricWindows,
  buildAdjacentBranchMetricWindows,
} from "./branch-metric-windows";

const DAY_MS = 24 * 60 * 60 * 1000;
const START_ONLY_PERIOD_TOLERANCE_MS = 5 * 60 * 1000;
const branchMetricPeriodDays: Record<
  Exclude<BranchMetricPeriod, "all">,
  number
> = {
  [BranchMetricPeriod.SevenDays]: 7,
  [BranchMetricPeriod.ThirtyDays]: 30,
  [BranchMetricPeriod.NinetyDays]: 90,
};

export type CanonicalBranchMetricRow = {
  id: string;
  status: BranchStatus | MetricTerminalStatus;
  lastActivityAt: string | null;
};

export type CanonicalBranchListMetricProjectionInput = {
  branches: readonly CanonicalBranchMetricRow[];
  pullRequests: readonly BranchMetricPullRequestEvidence[];
  pullRequestCoverageComplete: boolean;
  /** See {@link BranchListMetricInput.cohortCoverageComplete}. */
  cohortCoverageComplete?: boolean;
  startDate?: string | Date;
  endDate?: string | Date;
  now: Date;
  lastActiveEvents?: readonly BranchMetricActivityEvidence[];
  lastActiveCoverageComplete?: boolean;
  locContributions?: readonly BranchMetricLocContribution[];
  locCompleteBranchIds?: readonly string[];
  costContributions?: readonly BranchMetricCostContribution[];
  costCompleteBranchIds?: readonly string[];
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
          currentActive: currentStatusIsHistorical
            ? null
            : isActiveStatus(branch.status),
          // Persisted Branch rows expose the current state, not a historical
          // state snapshot at the adjacent boundary. Comparisons fail closed.
          priorActive: null,
        })),
      locContributions: input.locContributions ?? [],
      locCompleteBranchIds: input.locCompleteBranchIds ?? [],
      pullRequests: input.pullRequests,
      pullRequestCoverageComplete: input.pullRequestCoverageComplete,
      costContributions: input.costContributions ?? [],
      costCompleteBranchIds: input.costCompleteBranchIds ?? [],
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
  // window's elapsed span: since ISS-5809 the requested end is the in-progress UTC
  // day, which puts `end` in the future and would otherwise grade a partial
  // current period against a complete prior one.
  return buildAdjacentBranchMetricWindows(period, end, input.now);
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
  return durationMs === periodDays * DAY_MS - 1
    ? new Date(end.getTime() + 1)
    : end;
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

function validDate(value: string | Date | undefined): Date | null {
  if (!(typeof value === "string" || value instanceof Date)) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
