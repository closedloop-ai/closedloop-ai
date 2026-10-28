import type {
  GetPullRequestsResponse,
  GitHubPullRequestTrackingScope,
} from "@repo/api/src/types/github";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
  type GitHubRepositoryDefaultObservationContext,
} from "@repo/api/src/types/github-read-model";
import {
  getRepositoryPullRequestsWithMetadata,
  type RepositoryPullRequestListResult,
} from "@repo/github";
import { v7 as uuidv7 } from "uuid";

type PullRequestListParameters = Parameters<
  typeof getRepositoryPullRequestsWithMetadata
>;

/**
 * Depth of the tracked-PR target search, in pages and in items — one number
 * expressed twice, and only true while pages × the shared default page size
 * still reaches the items.
 *
 * This read forwards no `pageSize`, so it inherits
 * `GITHUB_BUNDLED_PULL_REQUESTS_DEFAULT_PAGE_SIZE`. When ISS-7891 cut that from
 * 100 to 25, 5 pages stopped reaching 500 and the search silently shortened to
 * 125: a tracked PR older than that window stayed in `missingTargetNumbers` and
 * never reached the live list, even though the item budget still claimed 500
 * (#5898 review). Pages rise to keep the claim honest; the provider loop still
 * exits the moment every target is found.
 */
export const TARGET_PULL_REQUEST_MAX_PAGES = 20;
export const TARGET_PULL_REQUEST_MAX_ITEMS = 500;

export type RepositoryPullRequestReadOptions = {
  limit?: number;
  trackingScope?: GitHubPullRequestTrackingScope;
};

type TrackedPullRequestListState = Pick<
  GetPullRequestsResponse,
  "trackedPrUrls" | "trackedBranches" | "trackedBranchKeys"
> & { targetDiscoveryTruncated: boolean };

/**
 * Execute the live GraphQL list read with one attempt-stable
 * repository-default context shared by every bounded page.
 *
 * `credentialType` is a parameter and not a constant because PLN-1775 M7 runs
 * this same read with a user token for an installation-free org: the authority
 * this observes is persisted with its provenance, so recording every read as
 * `github_app` would attribute a user-token observation to a credential the
 * org does not have.
 */
export function readRepositoryPullRequestsWithAuthority(
  octokit: PullRequestListParameters[0],
  owner: PullRequestListParameters[1],
  name: PullRequestListParameters[2],
  options: PullRequestListParameters[3],
  observer: PullRequestListParameters[4],
  credential: {
    type?: GitHubFetchCredentialType;
    /**
     * Whose token read it. Required with a user credential and meaningless
     * without one: `credentialType` records which LANE read the authority and
     * this records which USER's grant did, and a `user_oauth` row with a null
     * owner cannot be told apart from any other user's.
     */
    ownerId?: string;
  } = {}
): Promise<RepositoryPullRequestListResult> {
  const repositoryDefaultContext: GitHubRepositoryDefaultObservationContext = {
    mechanism: GitHubFetchMechanism.Graphql,
    trigger: GitHubFetchTrigger.SurfaceOpen,
    credentialType: credential.type ?? GitHubFetchCredentialType.GitHubApp,
    ...(credential.ownerId ? { credentialOwnerId: credential.ownerId } : {}),
    observationKey: `pull_request_graphql:${uuidv7()}`,
    observedAt: new Date().toISOString(),
  };
  return getRepositoryPullRequestsWithMetadata(
    octokit,
    owner,
    name,
    options,
    observer,
    repositoryDefaultContext
  );
}

/** Preserve provider and target-discovery completeness in one route response. */
export function buildRepositoryPullRequestsResponse(
  pullRequests: RepositoryPullRequestListResult,
  tracked: TrackedPullRequestListState
): GetPullRequestsResponse {
  return {
    pullRequests: pullRequests.pullRequests,
    hasMore: pullRequests.hasMore,
    truncated: pullRequests.truncated,
    pageInfo: pullRequests.pageInfo,
    stopReason: pullRequests.stopReason,
    missingTargetNumbers: pullRequests.missingTargetNumbers,
    ...(tracked.targetDiscoveryTruncated
      ? { targetDiscoveryTruncated: true }
      : {}),
    trackedPrUrls: tracked.trackedPrUrls,
    trackedBranches: tracked.trackedBranches,
    trackedBranchKeys: tracked.trackedBranchKeys,
  };
}
