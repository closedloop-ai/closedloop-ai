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
 * Execute the live installation GraphQL list read with one attempt-stable
 * repository-default context shared by every bounded page.
 */
export function readRepositoryPullRequestsWithAuthority(
  octokit: PullRequestListParameters[0],
  owner: PullRequestListParameters[1],
  name: PullRequestListParameters[2],
  options: PullRequestListParameters[3],
  observer: PullRequestListParameters[4]
): Promise<RepositoryPullRequestListResult> {
  const repositoryDefaultContext: GitHubRepositoryDefaultObservationContext = {
    mechanism: GitHubFetchMechanism.Graphql,
    trigger: GitHubFetchTrigger.SurfaceOpen,
    credentialType: GitHubFetchCredentialType.GitHubApp,
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
