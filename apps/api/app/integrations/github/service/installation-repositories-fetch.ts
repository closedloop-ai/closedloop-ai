import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import type { RepositoryDefaultUnavailableObservation } from "@repo/api/src/types/repository-default-identity";
import {
  RepositoryDefaultReason,
  RepositoryDefaultSource,
} from "@repo/api/src/types/repository-default-identity";
import { GitHubProviderResultStatus } from "@repo/github";
import { toGitHubProviderFailure } from "@repo/github/provider-error-classification";
import {
  createGitHubRepositoryDefaultUnavailableObservation,
  mapGitHubProviderResultToRepositoryDefaultFailure,
} from "@repo/github/repository-default-provider-failure";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { v7 as uuidv7 } from "uuid";
import { acquireInstallationClient } from "@/lib/github/installation-client";

import {
  RepositoryArtifactRelinkFailureReason,
  type RepositoryArtifactRelinkFailureReason as RepositoryArtifactRelinkFailureReasonType,
} from "./repository-relink-telemetry";
import { mapInstallationRepositoryResponse } from "./repository-response";
import type { RepositoryInput } from "./repository-sync";

const INSTALLATION_REPOSITORY_PAGE_SIZE = 100;
const INSTALLATION_REPOSITORY_MAX_PAGES = 20;
const GITHUB_REST_API_VERSION = "2026-03-10";

export type FetchInstallationRepositoriesResult =
  | { ok: true; repositories: RepositoryInput[] }
  | {
      ok: false;
      repositories: RepositoryInput[];
      error: RepositoryArtifactRelinkFailureReasonType;
      unavailable: RepositoryDefaultUnavailableObservation;
    };

/**
 * Read one installation grant through its existing installation credential.
 * A single acquisition key and timestamp cover every page in this bounded
 * walk, so retries within the attempt produce one idempotency identity.
 */
export async function fetchInstallationRepositories(
  providerInstallationId: number
): Promise<FetchInstallationRepositoriesResult> {
  const repositories: RepositoryInput[] = [];
  const acquisition = {
    observationKey: `installation_repositories_rest:${uuidv7()}`,
    observedAt: new Date(),
  };
  const provenance = {
    source: RepositoryDefaultSource.InstallationRepositoriesRest,
    mechanism: GitHubFetchMechanism.Rest,
    trigger: GitHubFetchTrigger.UserAction,
    credentialType: GitHubFetchCredentialType.GitHubApp,
    observationKey: acquisition.observationKey,
    observedAt: acquisition.observedAt.toISOString(),
  };
  let page = 1;
  let reportedTotal: number | null = null;
  let hitPageCap = false;

  const acquired = await acquireInstallationClient(
    String(providerInstallationId)
  );
  if (acquired.status !== GitHubProviderResultStatus.Success) {
    const failure = RepositoryArtifactRelinkFailureReason.RepositoryFetchFailed;
    log.warn("[github/oauth] Failed to fetch installation repositories", {
      installationId: providerInstallationId,
      page,
      status: acquired.status,
      failure,
    });
    const unavailable = mapGitHubProviderResultToRepositoryDefaultFailure(
      acquired,
      provenance
    );
    if (!unavailable) {
      throw new Error("Successful installation client reached failure branch");
    }
    return {
      ok: false,
      repositories,
      error: failure,
      unavailable: unavailable.observation,
    };
  }

  try {
    let hasMore = true;
    while (hasMore) {
      const { data } =
        await acquired.value.rest.apps.listReposAccessibleToInstallation({
          per_page: INSTALLATION_REPOSITORY_PAGE_SIZE,
          page,
          headers: { "X-GitHub-Api-Version": GITHUB_REST_API_VERSION },
        });
      if (page === 1 && Number.isInteger(data.total_count)) {
        reportedTotal = data.total_count;
      }
      repositories.push(
        ...data.repositories.map((repository) =>
          mapInstallationRepositoryResponse(repository, acquisition)
        )
      );
      const pageWasFull =
        data.repositories.length === INSTALLATION_REPOSITORY_PAGE_SIZE;
      page += 1;
      hitPageCap = pageWasFull && page > INSTALLATION_REPOSITORY_MAX_PAGES;
      hasMore = pageWasFull && !hitPageCap;
    }
  } catch (error) {
    const failure =
      page === 1
        ? RepositoryArtifactRelinkFailureReason.RepositoryFetchFailed
        : RepositoryArtifactRelinkFailureReason.RepositoryFetchPartial;
    log.warn("[github/oauth] Failed to fetch installation repositories", {
      installationId: providerInstallationId,
      page,
      error: parseError(error),
      failure,
    });
    const unavailable = mapGitHubProviderResultToRepositoryDefaultFailure(
      toGitHubProviderFailure(error),
      provenance
    );
    if (!unavailable) {
      throw new Error("Successful repository page read reached failure branch");
    }
    return {
      ok: false,
      repositories,
      error: failure,
      unavailable: unavailable.observation,
    };
  }

  const shortOfGrant =
    reportedTotal !== null && repositories.length < reportedTotal;
  if (hitPageCap || shortOfGrant) {
    log.warn("[github/oauth] Installation repository walk ended incomplete", {
      installationId: providerInstallationId,
      fetchedCount: repositories.length,
      reportedTotal,
      hitPageCap,
    });
    return {
      ok: false,
      repositories,
      error: RepositoryArtifactRelinkFailureReason.RepositoryFetchPartial,
      unavailable: createGitHubRepositoryDefaultUnavailableObservation(
        hitPageCap
          ? RepositoryDefaultReason.Capped
          : RepositoryDefaultReason.ProviderError,
        provenance
      ),
    };
  }
  return { ok: true, repositories };
}
