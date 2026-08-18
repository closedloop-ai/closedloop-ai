import type {
  RepositoryDefaultAuthority,
  RepositoryDefaultUnavailableObservation,
} from "@repo/api/src/types/repository-default-identity";
import { RepositoryDefaultReason } from "@repo/api/src/types/repository-default-identity";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import { withDb } from "@repo/database";
import { createGitHubRepositoryDefaultUnavailableEvidence } from "@repo/github/repository-default-provider-failure";
import {
  bulkUpsertInstallationRepositories,
  type RepositoryInput,
} from "./repository-sync";

/**
 * Persist a bounded failed/partial installation walk without tombstoning the
 * unobserved grant. Returned repositories keep their complete evidence; known
 * missing rows receive the attempt's typed poorer observation.
 */
export async function persistIncompleteInstallationRepositoryObservation(
  installationId: string,
  repositories: RepositoryInput[],
  unavailable: RepositoryDefaultUnavailableObservation
): Promise<void> {
  await withDb.tx(async (tx) => {
    const returnedIds = new Set(
      repositories.map((repository) => repository.githubRepoId)
    );
    const known = await tx.gitHubInstallationRepository.findMany({
      where: { installationId, removedAt: null },
      select: {
        githubRepoId: true,
        fullName: true,
        name: true,
        owner: true,
        private: true,
      },
    });
    const poorer = known
      .filter((repository) => !returnedIds.has(repository.githubRepoId))
      .map((repository) => ({
        ...repository,
        defaultAuthority: buildUnavailableAuthority(repository, unavailable),
      }));
    const observations = [...repositories, ...poorer];
    if (observations.length > 0) {
      await bulkUpsertInstallationRepositories(
        tx,
        installationId,
        observations
      );
    }
  });
}

function buildUnavailableAuthority(
  repository: {
    githubRepoId: string;
    fullName: string;
  },
  unavailable: RepositoryDefaultUnavailableObservation
): RepositoryDefaultAuthority {
  if (
    unavailable.reason === RepositoryDefaultReason.LegacyRecord ||
    unavailable.reason === RepositoryDefaultReason.Unknown
  ) {
    throw new Error(
      "Live provider observation used a compatibility-only reason"
    );
  }
  return {
    repository: {
      provider: VcsProviderKind.GitHub,
      providerRepositoryId: repository.githubRepoId,
      fullName: repository.fullName,
    },
    evidence: createGitHubRepositoryDefaultUnavailableEvidence(
      unavailable.reason
    ),
    provenance: unavailable.provenance,
  };
}
