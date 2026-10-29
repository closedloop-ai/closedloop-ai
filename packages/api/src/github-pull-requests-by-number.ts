import {
  type BundledPullRequestNode,
  GITHUB_PULL_REQUEST_NODE_FIELDS,
  mapPullRequestNode,
  mapRateLimitBudget,
} from "./github-read-model.ts";
import {
  type GitHubBundledPullRequestsResult,
  GitHubBundledPullRequestsStopReason,
  type GitHubReadModelPullRequest,
  GitHubReadModelSource,
  type GitHubRepositoryDefaultObservationContext,
} from "./types/github-read-model.ts";

/**
 * ISS-7892: fetch specific pull requests BY NUMBER instead of scanning the
 * updated-at window until they happen to appear.
 *
 * The reconcile sweep's self-heal batch (terminal rows missing LOC) used to
 * ride the paged window read as a stop condition, which meant a target deeper
 * than the page budget was never returned at all — and, because the loop only
 * exits early once EVERY target is found, one unreachable target kept the sweep
 * paging its full budget on every tick forever. A direct read costs one round
 * trip regardless of how far back the target sits, and reaches targets the
 * window never could.
 *
 * `statusCheckRollup` is deliberately absent: these targets are terminal, and
 * the reconcile write path does not persist check state.
 */
const GITHUB_PULL_REQUEST_ALIAS_PREFIX = "pr_";

/** Bound on aliases per request, so one query cannot be grown without measure. */
export const GITHUB_PULL_REQUESTS_BY_NUMBER_MAX_ALIASES = 50;

export type PullRequestsByNumberGraphqlResponse = {
  rateLimit?: {
    cost?: number | null;
    remaining?: number | null;
    resetAt?: string | null;
  } | null;
  repository?: Record<string, BundledPullRequestNode | null> | null;
};

/**
 * Numbers reaching this builder come from stored rows, so they are validated
 * rather than trusted: a non-integer would be interpolated straight into the
 * query document.
 */
export function normalizePullRequestNumbers(
  numbers: readonly number[]
): number[] {
  const seen = new Set<number>();
  for (const value of numbers) {
    if (Number.isSafeInteger(value) && value > 0) {
      seen.add(value);
    }
    if (seen.size >= GITHUB_PULL_REQUESTS_BY_NUMBER_MAX_ALIASES) {
      break;
    }
  }
  return [...seen];
}

export function buildPullRequestsByNumberQuery(
  numbers: readonly number[]
): string {
  const selections = normalizePullRequestNumbers(numbers)
    .map(
      (number) =>
        `      ${GITHUB_PULL_REQUEST_ALIAS_PREFIX}${number}: pullRequest(number: ${number}) {${GITHUB_PULL_REQUEST_NODE_FIELDS}
      }`
    )
    .join("\n");
  return `
  query PullRequestsByNumber($owner: String!, $repo: String!) {
    rateLimit {
      cost
      remaining
      resetAt
    }
    repository(owner: $owner, name: $repo) {
${selections}
    }
  }
`;
}

export function mapPullRequestsByNumberResponse(
  response: PullRequestsByNumberGraphqlResponse | null | undefined,
  source: GitHubReadModelSource = GitHubReadModelSource.Provider,
  repositoryDefaultContext?: GitHubRepositoryDefaultObservationContext
): GitHubBundledPullRequestsResult {
  const pullRequests: GitHubReadModelPullRequest[] = [];
  for (const [alias, node] of Object.entries(response?.repository ?? {})) {
    if (!alias.startsWith(GITHUB_PULL_REQUEST_ALIAS_PREFIX)) {
      continue;
    }
    const mapped = mapPullRequestNode(node, source, repositoryDefaultContext);
    if (mapped) {
      pullRequests.push(mapped);
    }
  }
  return {
    pullRequests,
    rateLimit: mapRateLimitBudget(response?.rateLimit ?? null),
    pageInfo: { hasNextPage: false, endCursor: null },
    hasMore: false,
    truncated: false,
    nextCursor: null,
    fetchedPages: 1,
    stopReason: GitHubBundledPullRequestsStopReason.Complete,
  };
}
