import type { GitHubBundledPullRequestsObserver } from "@repo/api/src/types/github-read-model";
import { log } from "@repo/observability/log";

/**
 * PLN-1535 M0: measurement-only logging of the GitHub GraphQL `rateLimit.cost`
 * that the bundled PR read parses and then discards (today only `state` is read,
 * to gate paging — see `mapRateLimitBudget`), plus a per-route request count.
 *
 * One structured `info` line per live GraphQL request lets Datadog count reads
 * and sum spend by `route` — the week of data that sizes the D9 reserve-floor
 * and per-token spend-cap defaults (`github-sync-client-pool.ts`) before the M2
 * reconciler hardens them. Intentionally at `info`, not `debug`: these lines
 * fire only when a route makes a real GraphQL call against GitHub (the pass-
 * through read routes always do), and the per-route drain they measure is the
 * whole point — this is a log-based metric, not routine success chatter.
 */
export const GITHUB_READ_COST_EVENT = "[github-read-cost]";

/**
 * Stable Datadog facet identifying which server path drove the GitHub read.
 * Scoped to the cost-bearing bundled-PR reads: only that query selects a
 * `rateLimit` block, and its spend is what sizes the D9 budget defaults. The
 * branches query carries no `rateLimit` and is slated for removal in M3 (the
 * `refs` drop), so it is intentionally not measured here.
 */
export const GitHubReadCostRoute = {
  RepositoryPullRequests: "repositories/[id]/pull-requests",
  Backfill: "backfill",
} as const;
export type GitHubReadCostRoute =
  (typeof GitHubReadCostRoute)[keyof typeof GitHubReadCostRoute];

export type GitHubReadCostContext = {
  route: GitHubReadCostRoute;
  organizationId: string;
  repositoryId?: string | null;
  repositoryFullName: string;
};

/**
 * Build a per-page observer for the bundled PR read. Each fetched page emits one
 * line carrying that request's `cost`/`remaining`/`resetAt` — `null` when the
 * provider returned no `rateLimit` block, which is deliberately distinct from an
 * observed zero — plus the page's item count.
 */
export function createGitHubReadCostObserver(
  context: GitHubReadCostContext
): GitHubBundledPullRequestsObserver {
  return (observation) => {
    log.info(GITHUB_READ_COST_EVENT, {
      route: context.route,
      organizationId: context.organizationId,
      repositoryId: context.repositoryId ?? null,
      repositoryFullName: context.repositoryFullName,
      page: observation.page,
      itemCount: observation.itemCount,
      cost: observation.rateLimit.cost,
      remaining: observation.rateLimit.remaining,
      resetAt: observation.rateLimit.resetAt,
      budgetState: observation.rateLimit.state,
    });
  };
}
