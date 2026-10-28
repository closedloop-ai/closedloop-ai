/**
 * @file branch-cost-evidence.ts
 * @description The Branch cost-evidence layer: what a cost fact IS, how a set of
 * them reconciles, and whether the result may be called complete.
 *
 * Split out of `branch-list-metrics.ts` (ISS-7365) once that kernel approached
 * the 1,000-line ceiling. The seam is a real responsibility boundary, not a line
 * count: everything here answers "what does this cost evidence say", while the
 * kernel answers "what does each tile publish". Every cost-derived reading
 * takes its completeness verdict from {@link costEvidenceIsComplete}, so no two
 * of them can invent different verdicts over the same rows.
 */
import type { BranchMetricWindow } from "@repo/api/src/types/branch-metrics";
import {
  isTimestampInBranchMetricWindow,
  timestampIsTrustworthy,
} from "./branch-metric-windows";

/** The cohort size a coverage flag must match to be called complete. */
export type BranchCostCoverageInput = {
  cohortSize: number;
  costCompleteBranchIds: readonly string[];
};

export type BranchMetricCostContribution = {
  sourceEventId: string;
  branchId: string;
  sessionId: string;
  occurredAt: string | null;
  costUsd: number | null;
  qualifyingBranchCount: number | null;
};
export type AllocatedCost = {
  total: number;
  included: number;
  conflicted: boolean;
  malformed: boolean;
};
export function reconcileAllocatedCost(
  contributions: readonly BranchMetricCostContribution[],
  window: BranchMetricWindow
): AllocatedCost {
  const identified = groupCostContributionsBySessionEvent(contributions);
  const groups = identified.groups;
  let malformed = identified.malformed;
  let total = 0;
  let included = 0;
  let conflicted = false;
  for (const group of groups.values()) {
    const first = group[0];
    if (!first) {
      continue;
    }
    const core = costCore(first);
    if (group.some((item) => costCore(item) !== core)) {
      conflicted = true;
      continue;
    }
    if (!timestampIsTrustworthy(first.occurredAt)) {
      malformed = true;
      continue;
    }
    if (!evidenceFallsInWindow(first.occurredAt, window)) {
      // Readable evidence the window excluded is never treated as malformed: an
      // unreadable row outside the range cannot make the in-range answer less
      // complete than it already is.
      continue;
    }
    if (!allocatedCostGroupIsReadable(group)) {
      malformed = true;
      continue;
    }
    const [readable] = group;
    const scopedBranchCount = new Set(group.map((item) => item.branchId)).size;
    if (scopedBranchCount > readable.qualifyingBranchCount) {
      conflicted = true;
      continue;
    }
    total +=
      readable.costUsd * (scopedBranchCount / readable.qualifyingBranchCount);
    included += 1;
  }
  return { total, included, conflicted, malformed };
}
/**
 * Group cost rows by their canonical identity, (session, source event).
 *
 * A row missing any of the three identities cannot be placed in a ledger at
 * all, so it is dropped and reported as malformed rather than grouped under an
 * empty key — which would silently merge unrelated rows.
 */
function groupCostContributionsBySessionEvent(
  contributions: readonly BranchMetricCostContribution[]
): {
  groups: Map<string, BranchMetricCostContribution[]>;
  malformed: boolean;
} {
  const groups = new Map<string, BranchMetricCostContribution[]>();
  let malformed = false;
  for (const contribution of contributions) {
    if (
      contribution.sessionId.trim().length === 0 ||
      contribution.sourceEventId.trim().length === 0 ||
      contribution.branchId.trim().length === 0
    ) {
      malformed = true;
      continue;
    }
    const key = `${contribution.sessionId}\u0000${contribution.sourceEventId}`;
    const group = groups.get(key) ?? [];
    group.push(contribution);
    groups.set(key, group);
  }
  return { groups, malformed };
}
/**
 * A cost group every member of which carries a usable cost and divisor.
 *
 * ISS-9970: lifecycle phase is deliberately absent. The dollar is TOTAL
 * ESTIMATED COST — the figure the Sessions listing reads — and phase is not a
 * dimension of it, so a Session whose cost evidence cannot be classified
 * Build/Review/Rework is still money this cohort spent and still belongs in the
 * denominator. Requiring a phase here silently dropped that cost and deflated
 * every ratio built on it.
 */
type ReadableCostGroup = readonly [
  ReadableCostContribution,
  ...ReadableCostContribution[],
];
type ReadableCostContribution = BranchMetricCostContribution & {
  costUsd: number;
  qualifyingBranchCount: number;
};
function allocatedCostGroupIsReadable(
  group: readonly BranchMetricCostContribution[]
): group is ReadableCostGroup {
  return (
    group.length > 0 &&
    group.every(
      (item) =>
        isValidNonnegative(item.costUsd) &&
        isValidDivisor(item.qualifyingBranchCount)
    )
  );
}
function costCore(contribution: BranchMetricCostContribution): string {
  return JSON.stringify({
    sessionId: contribution.sessionId,
    sourceEventId: contribution.sourceEventId,
    occurredAt: contribution.occurredAt,
    costUsd: contribution.costUsd,
    qualifyingBranchCount: contribution.qualifyingBranchCount,
  });
}
export function evidenceFallsInWindow(
  occurredAt: string | null,
  window: BranchMetricWindow
): boolean {
  if (occurredAt === null) {
    return false;
  }
  return isTimestampInBranchMetricWindow(occurredAt, window);
}
export function isValidNonnegative(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0;
}
export function isValidDivisor(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value > 0;
}
export function costCoverageFlagHolds(input: BranchCostCoverageInput): boolean {
  return input.costCompleteBranchIds.length === input.cohortSize;
}
/**
 * ISS-7365 — the ONE cost-coverage authority the strip's two cost tiles share.
 *
 * LOC per $ and AI spend both answer "is this cohort's cost evidence complete?",
 * and they used to answer it with two different reconciliations of the SAME
 * rows: {@link reconcileAllocatedCost}, keyed on (session, source event), and a
 * generic identity reconcile keyed on (source event, branch) comparing whole
 * values. A branch whose cost event legitimately spans two phase segments — or
 * two sessions — is one cost fact to the first and a self-contradiction to the
 * second, so a single render could publish "N/A" (coverage complete, total
 * zero) beside "Unavailable" (coverage NOT complete) from one input.
 *
 * (session, source event) is the canonical identity: the producer's own
 * reconciliation, `hasCompleteBranchMetricEventCost` in
 * `branch-phase-cost-contributions.ts`, keys cost events that way and ignores
 * phase entirely. Every cost reading takes completeness from here, so the
 * verdict is a pure function of the coverage flag and one reconciliation —
 * two readings over the same contributions cannot disagree.
 *
 * That last clause is the exact limit of what this fixes, and it is narrower
 * than ISS-7365's own diagnosis. The ticket named the two COVERAGE FLAGS as the
 * root cause (`locPerDollarCostCoverageComplete` versus
 * `costCompleteBranchIds.length === cohortSize`). Those are NOT collapsed here,
 * deliberately: ISS-6543 gave LOC per $ an INDEPENDENT denominator population
 * that includes qualifying Session cost from branches outside the visible
 * cohort, and both the cloud and desktop producers always pass both sets. Where
 * those populations differ the two verdicts may still differ. That residual is
 * a product question — what should the strip mean when its cost readings
 * measure different populations? — not an implementation one, so it is
 * escalated rather than decided here.
 */
export function costEvidenceIsComplete(
  coverageFlagHolds: boolean,
  evidence: AllocatedCost
): boolean {
  return coverageFlagHolds && !(evidence.conflicted || evidence.malformed);
}
