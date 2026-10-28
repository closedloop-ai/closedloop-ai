import type { GitHubConnectAction } from "@repo/app/github/lib/github-connect-action";
import type { GitHubConnectTarget } from "@repo/app/github/lib/github-connect-target";

/**
 * Whether this shell may put a connect ask on the Branches summary strip, and
 * what it hands over.
 *
 * Two conditions, and the second is the one marisolashgrove's ISS-12638 review
 * added. `connectAction` is the raw resolved action — null once the reader is
 * connected or while the status has not landed — so without it the strip would
 * ask a reader who has nothing to connect.
 *
 * `metricsDerivedLocally` says the LOCAL fallback authored the strip's figures
 * rather than the producer (`ApprovedBranchCohortAnalytics`). Every absence in
 * those is this client's own derivation falling short — a cohort whose merged
 * branches are all multi-PR, or an event-history card with no row-provable form
 * — so a connect leaves the card exactly as it found it. The strip asks only
 * about the producer's own bundle.
 */
export function branchesSummaryConnectAsk({
  connectAction,
  connectTarget,
  metricsDerivedLocally,
}: {
  connectAction: GitHubConnectAction | null;
  connectTarget: GitHubConnectTarget;
  metricsDerivedLocally: boolean;
}): GitHubConnectTarget | undefined {
  if (!connectAction || metricsDerivedLocally) {
    return;
  }
  return connectTarget;
}
