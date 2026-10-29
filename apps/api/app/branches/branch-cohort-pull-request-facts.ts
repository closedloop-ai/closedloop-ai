import { Prisma } from "@repo/database";
import { resolveCanonicalBranchMetricWindows } from "@repo/lib/branches/branch-list-metric-projection";
import {
  type BranchMetricPullRequestFacts,
  branchMetricFactWindows,
  branchMetricWindowKey,
} from "@repo/lib/branches/branch-pull-request-metrics";
import { readPullRequestMetricFacts } from "./branch-pull-request-window-metrics";

/**
 * Median PR size and Merge rate for an exact branch cohort, over every window
 * the metric fold will ask about. The windows are resolved by the fold's own
 * function from the fold's own inputs, so a window it asks for always has facts.
 */
export function readCohortPullRequestFacts(
  organizationId: string,
  branchIds: readonly string[],
  query: { startDate?: Date; endDate?: Date },
  now: Date
): Promise<BranchMetricPullRequestFacts> {
  const windows = branchMetricFactWindows(
    resolveCanonicalBranchMetricWindows({ ...query, now })
  );
  return readPullRequestMetricFacts(
    organizationId,
    Prisma.sql`SELECT unnest(${[...branchIds]}::uuid[])`,
    windows.map((window) => ({ key: branchMetricWindowKey(window), ...window }))
  );
}
