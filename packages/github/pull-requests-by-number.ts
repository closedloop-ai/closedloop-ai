import "server-only";
import type { Octokit } from "@octokit/rest";
import {
  buildPullRequestsByNumberQuery,
  mapPullRequestsByNumberResponse,
  normalizePullRequestNumbers,
  type PullRequestsByNumberGraphqlResponse,
} from "@repo/api/src/github-pull-requests-by-number";
import { mapRateLimitBudget } from "@repo/api/src/github-read-model";
import type {
  GitHubBundledPullRequestsObserver,
  GitHubBundledPullRequestsResult,
  GitHubRepositoryDefaultObservationContext,
} from "@repo/api/src/types/github-read-model";
import { GitHubBundledPullRequestsStopReason } from "@repo/api/src/types/github-read-model";
import { log } from "@repo/observability/log";
import {
  classifyRepositoryAccessFailure,
  recoverPartialGraphqlEnvelope,
  toGitHubProviderFailure,
} from "./provider-error-classification";
import {
  type GitHubProviderResult,
  GitHubProviderResultStatus,
} from "./provider-result";

/**
 * ISS-7892: fetch an explicit set of pull requests in one round trip.
 *
 * The reconcile sweep's self-heal batch used to be a stop condition on the
 * paged window read, which could only ever find a target that happened to fall
 * inside the page budget — and kept the sweep paging its whole budget every
 * tick while any target did not. Asking for the numbers directly costs one
 * request whatever their age.
 */
export async function queryPullRequestsByNumberWithProviderResult(
  octokit: Octokit,
  owner: string,
  repo: string,
  numbers: readonly number[],
  observer?: GitHubBundledPullRequestsObserver,
  repositoryDefaultContext?: GitHubRepositoryDefaultObservationContext
): Promise<GitHubProviderResult<GitHubBundledPullRequestsResult>> {
  const requested = normalizePullRequestNumbers(numbers);
  if (requested.length === 0) {
    return {
      status: GitHubProviderResultStatus.Success,
      value: emptyPullRequestsByNumberResult(),
    };
  }
  let data: PullRequestsByNumberGraphqlResponse;
  try {
    data = await octokit.graphql<PullRequestsByNumberGraphqlResponse>(
      buildPullRequestsByNumberQuery(requested),
      { owner, repo }
    );
  } catch (error) {
    // Order matters, and it is the bundled read's own resolver order:
    // repo-access, then rate limit, then partial.
    //
    // A repo-access verdict (ISS-5093) outranks everything. A repository this
    // credential cannot reach answers `repository: null`, which is a partial
    // response shape — recovering it first would report "nothing to heal" for a
    // repo we cannot see, and cost the pool its verdict.
    //
    // A rate limit then outranks partial recovery (tamsinb review). GitHub can
    // answer with SOME aliases populated and a RATE_LIMITED entry in `errors[]`;
    // recovering that as a plain Success hides the rate limit from the caller,
    // and the self-heal debounce would stamp every requested number as
    // attempted — including the ones the rate limit stopped it from resolving,
    // which then wait out the debounce before anything retries them. Unlike the
    // bundled read there are no already-fetched pages to preserve here, so the
    // whole read reports the rate limit and nothing is stamped.
    const denial = classifyRepositoryAccessFailure(error, 0);
    if (denial) {
      return denial;
    }
    const failure = toGitHubProviderFailure(error);
    if (failure.status === GitHubProviderResultStatus.ProviderRateLimit) {
      return failure;
    }
    const partial = recoverPartialPullRequests(error);
    if (!partial) {
      return failure;
    }
    log.warn("[github/pull-requests-by-number] recovered from partial data", {
      owner,
      repo,
      requested: requested.length,
      graphqlErrorCount: partial.errors.length,
    });
    data = partial.data;
  }
  const mapped = mapPullRequestsByNumberResponse(
    data,
    undefined,
    repositoryDefaultContext
  );
  observer?.({
    page: 0,
    itemCount: mapped.pullRequests.length,
    rateLimit: mapped.rateLimit,
  });
  return { status: GitHubProviderResultStatus.Success, value: mapped };
}

function emptyPullRequestsByNumberResult(): GitHubBundledPullRequestsResult {
  return {
    pullRequests: [],
    rateLimit: mapRateLimitBudget(null),
    pageInfo: { hasNextPage: false, endCursor: null },
    hasMore: false,
    truncated: false,
    nextCursor: null,
    fetchedPages: 0,
    stopReason: GitHubBundledPullRequestsStopReason.Complete,
  };
}

/**
 * A pull request that no longer resolves — deleted, or moved out of reach —
 * makes GitHub answer HTTP 200 with every OTHER alias populated plus an
 * `errors[]` entry for that one, and octokit throws on the errors. Verified
 * against `closedloop-ai/closedloop-ai`: asking for a live number and a
 * nonexistent one together returns both the live PR's fields and the error.
 *
 * Discarding that would be the starvation bug this read exists to remove: one
 * gone PR in the batch would fail every tick forever, so the batch's other
 * targets would never be filled and none of them would ever be debounced.
 */
function recoverPartialPullRequests(error: unknown) {
  return recoverPartialGraphqlEnvelope(error, isPullRequestsByNumberResponse);
}

function isPullRequestsByNumberResponse(
  value: unknown
): value is PullRequestsByNumberGraphqlResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { repository?: unknown }).repository === "object" &&
    (value as { repository?: unknown }).repository !== null
  );
}
