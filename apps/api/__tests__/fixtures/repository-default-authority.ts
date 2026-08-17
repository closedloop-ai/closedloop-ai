import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import {
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultSource,
} from "@repo/api/src/types/repository-default-identity";

/** Complete persisted GitHub authority columns for cloud write-path tests. */
export function persistedGitHubRepositoryAuthority(input: {
  githubRepoId: string;
  fullName: string;
  defaultBranch?: string;
}) {
  return {
    githubRepoId: input.githubRepoId,
    fullName: input.fullName,
    defaultBranchName: input.defaultBranch ?? "main",
    defaultBranchAvailability: RepositoryDefaultAvailability.Available,
    defaultBranchCompleteness: RepositoryDefaultCompleteness.Complete,
    defaultBranchReason: null,
    defaultBranchSource: RepositoryDefaultSource.PushWebhook,
    defaultBranchMechanism: GitHubFetchMechanism.Webhook,
    defaultBranchTrigger: GitHubFetchTrigger.Webhook,
    defaultBranchCredentialType: GitHubFetchCredentialType.GitHubApp,
    defaultBranchCredentialOwnerId: null,
    defaultBranchObservationKey: "persisted-authority",
    defaultBranchObservedAt: new Date("2026-08-10T09:00:00.000Z"),
    defaultBranchEventAt: new Date("2026-08-10T09:00:00.000Z"),
  };
}
