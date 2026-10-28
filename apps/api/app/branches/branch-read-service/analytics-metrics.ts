import type { BranchAnalyticsMetrics } from "../branch-analytics-kpis";
import type { BranchAnalyticsArtifactRow } from "../branch-analytics-select";
import {
  observedPrStateForSelectedCloudPullRequest,
  projectCloudOwnedBranchAssociatedPullRequests,
  statusForSelectedCloudPullRequest,
} from "../branch-associated-pull-request-projection";
import { analyticsPullRequestSize, currentFileTotals } from "../branch-loc";

/** Project the legacy Branch analytics input from one hydrated cloud row. */
export function toBranchAnalyticsMetrics(
  row: BranchAnalyticsArtifactRow
): BranchAnalyticsMetrics {
  const associatedPullRequests =
    projectCloudOwnedBranchAssociatedPullRequests(row);
  const selected = associatedPullRequests.selected ?? null;
  const pr = selected?.source ?? null;
  const status = statusForSelectedCloudPullRequest(row.status, selected);
  const fileTotals = currentFileTotals(
    row.branch.fileChangeTotals,
    row.branch.fileCacheHeadSha,
    row.branch.headSha,
    row.branch.fileCacheCapped
  );
  return {
    id: row.id,
    status,
    multiPrWarning: associatedPullRequests.collection.items.length > 1,
    // ISS-8422: an unobserved PR contributes no lifecycle to the KPI buckets,
    // so `derivePrLifecycle` returns null for it and it is counted in none.
    prState: observedPrStateForSelectedCloudPullRequest(selected),
    mergedAt: pr?.mergedAt ?? null,
    additions: fileTotals.additions,
    deletions: fileTotals.deletions,
    prSize: analyticsPullRequestSize(status, fileTotals),
  };
}
