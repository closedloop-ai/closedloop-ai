import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import { RepositoryDefaultSource } from "@repo/api/src/types/repository-default-identity";
import { mapGitHubRepositoryDefaultAuthority } from "@/lib/github/repository-default-authority";

import type { RepositoryInput } from "./repository-sync";

export type InstallationRepositoryResponse = {
  id: number;
  full_name: string;
  name: string;
  owner: { login: string };
  private: boolean;
  default_branch?: unknown;
};

export type InstallationRepositoryAcquisition = {
  observationKey: string;
  observedAt: Date;
};

/** Map one installation REST repository without losing default authority. */
export function mapInstallationRepositoryResponse(
  repository: InstallationRepositoryResponse,
  acquisition: InstallationRepositoryAcquisition
): RepositoryInput {
  return {
    githubRepoId: String(repository.id),
    fullName: repository.full_name,
    name: repository.name,
    owner: repository.owner.login,
    private: repository.private,
    defaultAuthority: mapGitHubRepositoryDefaultAuthority({
      providerRepositoryId: String(repository.id),
      fullName: repository.full_name,
      defaultBranch: repository.default_branch,
      source: RepositoryDefaultSource.InstallationRepositoriesRest,
      mechanism: GitHubFetchMechanism.Rest,
      trigger: GitHubFetchTrigger.UserAction,
      credentialType: GitHubFetchCredentialType.GitHubApp,
      observationKey: acquisition.observationKey,
      observedAt: acquisition.observedAt,
    }),
  };
}
