import "server-only";
import type { Octokit } from "@octokit/rest";
import {
  type BundledPullRequestsGraphqlResponse,
  buildBundledPullRequestsVariables,
  bundledPullRequestsFoundAllTargets,
  bundledPullRequestsReachedWatermark,
  GITHUB_BUNDLED_PULL_REQUESTS_QUERY,
  GITHUB_BUNDLED_PULL_REQUESTS_QUERY_WITHOUT_ROLLUP,
  mapBundledPullRequestsResponse,
  mergeBundledPullRequestsResults,
  normalizeBundledPullRequestsPageOptions,
} from "@repo/api/src/github-read-model";
import type {
  GitHubBundledPullRequestsObserver,
  GitHubBundledPullRequestsPageOptions,
  GitHubBundledPullRequestsResult,
  GitHubRepositoryDefaultObservationContext,
} from "@repo/api/src/types/github-read-model";
import {
  GitHubBundledPullRequestsStopReason,
  GitHubProviderBudgetState,
} from "@repo/api/src/types/github-read-model";
import {
  classifyRepositoryAccessFailure,
  toGitHubProviderFailure,
} from "./provider-error-classification";
import {
  type GitHubProviderResult,
  GitHubProviderResultStatus,
} from "./provider-result";

/**
 * The paged bundled pull-request read.
 *
 * Extracted from `index.ts` (ISS-7892) so the package API surface stops
 * carrying the paging loop's own helpers.
 */
/**
 * Fetch a visible repository window of pull requests with review/check summary
 * data in one GraphQL request. Every call selects rateLimit budget metadata via
 * the shared query so callers can back off from GitHub-reported limits.
 */
export async function queryBundledPullRequestsWithProviderResult(
  octokit: Octokit,
  owner: string,
  repo: string,
  numbers: readonly number[],
  options: GitHubBundledPullRequestsPageOptions = {},
  // PLN-1535 M0: invoked once per fetched page with the mapped `rateLimit`
  // budget (incl. the `cost` this read otherwise discards) so callers can
  // measure GraphQL spend per route. Pages already fetched before an early
  // paging exit are still reported.
  observer?: GitHubBundledPullRequestsObserver,
  repositoryDefaultContext?: GitHubRepositoryDefaultObservationContext
): Promise<GitHubProviderResult<GitHubBundledPullRequestsResult>> {
  try {
    const normalized = normalizeBundledPullRequestsPageOptions({
      ...options,
      targetNumbers: options.targetNumbers ?? numbers,
    });
    const pages: GitHubBundledPullRequestsResult[] = [];
    let after = normalized.after;

    for (let page = 0; page < normalized.maxPages; page++) {
      const remainingItems =
        normalized.maxItems - countBundledPullRequests(pages);
      if (remainingItems <= 0) {
        break;
      }
      let data: BundledPullRequestsGraphqlResponse;
      try {
        data = await octokit.graphql<BundledPullRequestsGraphqlResponse>(
          normalized.includeStatusCheckRollup
            ? GITHUB_BUNDLED_PULL_REQUESTS_QUERY
            : GITHUB_BUNDLED_PULL_REQUESTS_QUERY_WITHOUT_ROLLUP,
          buildBundledPullRequestsVariables(owner, repo, numbers, {
            ...normalized,
            after,
            pageSize: Math.min(normalized.pageSize, remainingItems),
          })
        );
      } catch (error) {
        return resolveBundledPullRequestsPageFailure(error, pages, normalized);
      }
      const mapped = mapBundledPullRequestsResponse(
        data,
        undefined,
        repositoryDefaultContext
      );
      pages.push(mapped);
      observer?.({
        page,
        itemCount: mapped.pullRequests.length,
        rateLimit: mapped.rateLimit,
      });

      if (
        normalized.targetNumbers.length > 0 &&
        bundledPullRequestsFoundAllTargets(
          pages.flatMap((current) => current.pullRequests),
          normalized.targetNumbers
        )
      ) {
        return {
          status: GitHubProviderResultStatus.Success,
          value: mergeBundledPullRequestsResults(
            pages,
            normalized,
            GitHubBundledPullRequestsStopReason.TargetFound
          ),
        };
      }
      if (
        bundledPullRequestsReachedWatermark(
          mapped.pullRequests,
          normalized.stopAtUpdatedAt
        )
      ) {
        return {
          status: GitHubProviderResultStatus.Success,
          value: mergeBundledPullRequestsResults(
            pages,
            normalized,
            GitHubBundledPullRequestsStopReason.WatermarkReached
          ),
        };
      }
      if (mapped.rateLimit.state === GitHubProviderBudgetState.Low) {
        return {
          status: GitHubProviderResultStatus.Success,
          value: mergeBundledPullRequestsResults(
            pages,
            normalized,
            GitHubBundledPullRequestsStopReason.BudgetLow
          ),
        };
      }
      if (!(mapped.pageInfo?.hasNextPage && mapped.pageInfo.endCursor)) {
        return {
          status: GitHubProviderResultStatus.Success,
          value: mergeBundledPullRequestsResults(pages, normalized),
        };
      }
      after = mapped.pageInfo.endCursor;
    }

    return {
      status: GitHubProviderResultStatus.Success,
      value: mergeBundledPullRequestsResults(pages, normalized),
    };
  } catch (error) {
    return toGitHubProviderFailure(error);
  }
}
function countBundledPullRequests(
  pages: readonly GitHubBundledPullRequestsResult[]
): number {
  return pages.reduce((total, page) => total + page.pullRequests.length, 0);
}

/**
 * Decide what a failed page fetch means for the whole bundled read.
 *
 * Extracted from the paging loop so the reader stays under the cognitive
 * complexity ceiling. Order matters: a repo-access verdict (ISS-5093) is
 * checked first because it is the only outcome the caller records against the
 * credential — and only this repo-scoped read can tell "cannot reach the repo"
 * apart from a transient outage, since a GraphQL denial carries no HTTP status.
 * A rate limit mid-drain still returns the pages already fetched.
 */
function resolveBundledPullRequestsPageFailure(
  error: unknown,
  pages: GitHubBundledPullRequestsResult[],
  normalized: Parameters<typeof mergeBundledPullRequestsResults>[1]
): GitHubProviderResult<GitHubBundledPullRequestsResult> {
  const repositoryAccessFailure = classifyRepositoryAccessFailure(
    error,
    pages.length
  );
  if (repositoryAccessFailure) {
    return repositoryAccessFailure;
  }
  const failure = toGitHubProviderFailure(error);
  if (
    pages.length > 0 &&
    failure.status === GitHubProviderResultStatus.ProviderRateLimit
  ) {
    return {
      status: GitHubProviderResultStatus.Success,
      value: mergeBundledPullRequestsResults(
        pages,
        normalized,
        GitHubBundledPullRequestsStopReason.ProviderRateLimit
      ),
    };
  }
  return failure;
}
