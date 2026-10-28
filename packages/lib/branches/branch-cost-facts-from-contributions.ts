import type { BranchMetricWindow } from "@repo/api/src/types/branch-metrics";
import {
  type BranchMetricCostContribution,
  evidenceFallsInWindow,
  isValidDivisor,
  isValidNonnegative,
} from "./branch-cost-evidence";
import type {
  BranchMetricCostFacts,
  BranchMetricCostWindowFacts,
} from "./branch-cost-facts";
import { timestampIsTrustworthy } from "./branch-metric-windows";
import { branchMetricWindowKey } from "./branch-pull-request-metrics";

/**
 * Per-window cost facts from in-memory cost contributions, for a producer that
 * has fixtures rather than a database (the prototypes sandbox). Production
 * producers fold the same facts in SQL, so this carries no rule of its own: an
 * event is usable when it has a non-negative cost and a positive divisor, and an
 * event whose instant cannot be read is unusable in every window.
 */
export function costFactsFromContributions(
  contributions: readonly BranchMetricCostContribution[],
  windows: readonly BranchMetricWindow[]
): BranchMetricCostFacts {
  const events = [...groupBySessionEvent(contributions).values()];
  return {
    cohortHoldsEvents: events.length > 0,
    windows: new Map(
      windows.map((window) => [
        branchMetricWindowKey(window),
        factsForWindow(events, window),
      ])
    ),
  };
}

function factsForWindow(
  events: readonly BranchMetricCostContribution[][],
  window: BranchMetricWindow
): BranchMetricCostWindowFacts {
  let spendUsd = 0;
  let included = 0;
  let unusable = 0;
  for (const group of events) {
    const [first] = group;
    if (!first) {
      continue;
    }
    if (!timestampIsTrustworthy(first.occurredAt)) {
      unusable += 1;
    } else if (evidenceFallsInWindow(first.occurredAt, window)) {
      const share = shareOf(first, group);
      if (share === null) {
        unusable += 1;
      } else {
        spendUsd += share;
        included += 1;
      }
    }
  }
  return { spendUsd, included, unusable };
}

function shareOf(
  first: BranchMetricCostContribution,
  group: readonly BranchMetricCostContribution[]
): number | null {
  if (
    !(
      isValidNonnegative(first.costUsd) &&
      isValidDivisor(first.qualifyingBranchCount)
    )
  ) {
    return null;
  }
  const scoped = new Set(group.map((item) => item.branchId)).size;
  return first.costUsd * (scoped / first.qualifyingBranchCount);
}

function groupBySessionEvent(
  contributions: readonly BranchMetricCostContribution[]
): Map<string, BranchMetricCostContribution[]> {
  const groups = new Map<string, BranchMetricCostContribution[]>();
  for (const contribution of contributions) {
    const key = `${contribution.sessionId}\u0000${contribution.sourceEventId}`;
    groups.set(key, [...(groups.get(key) ?? []), contribution]);
  }
  return groups;
}
