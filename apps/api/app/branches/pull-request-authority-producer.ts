import { randomUUID } from "node:crypto";
import {
  type GitHubFetchCredentialType,
  GitHubFetchMechanism,
  type GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import {
  type RepositoryDefaultProvenance,
  RepositoryDefaultSource,
} from "@repo/api/src/types/repository-default-identity";
import type { TransactionClient } from "@repo/database";
import type { GitHubUserTokenProviderResult } from "@repo/github";
import type { GitHubPullRequestRestAuthorityObservation } from "@repo/github/pull-request-rest";
import { mapGitHubProviderResultToRepositoryDefaultFailure } from "@repo/github/repository-default-provider-failure";
import { persistPullRequestHeadRepositoryAuthority } from "./pull-request-head-authority";

/** Creates one stable authority context for a bounded PR REST acquisition. */
export function createPullRequestRestAuthorityProvenance(input: {
  trigger: GitHubFetchTrigger;
  credentialType: GitHubFetchCredentialType;
  credentialOwnerId?: string;
  observedAt: Date;
}): RepositoryDefaultProvenance {
  return {
    source: RepositoryDefaultSource.PullRequestRest,
    mechanism: GitHubFetchMechanism.Rest,
    trigger: input.trigger,
    credentialType: input.credentialType,
    ...(input.credentialOwnerId
      ? { credentialOwnerId: input.credentialOwnerId }
      : {}),
    observationKey: randomUUID(),
    observedAt: input.observedAt.toISOString(),
  };
}

/** Removes source/mechanism before passing context to the REST provider. */
export function toPullRequestRestAuthorityObservation(
  provenance: RepositoryDefaultProvenance
): GitHubPullRequestRestAuthorityObservation {
  return {
    trigger: provenance.trigger,
    credentialType: provenance.credentialType,
    ...(provenance.credentialOwnerId
      ? { credentialOwnerId: provenance.credentialOwnerId }
      : {}),
    observationKey: provenance.observationKey,
    observedAt: provenance.observedAt,
  };
}

/** Persists an exact typed poorer observation for a failed PR provider read. */
export function persistPullRequestProviderFailure<T>(
  db: Pick<
    TransactionClient,
    "pullRequestDetail" | "repositoryDefaultObservationReceipt"
  >,
  scope: { organizationId: string; pullRequestDetailId: string },
  result: Exclude<GitHubUserTokenProviderResult<T>, { status: "success" }>,
  provenance: RepositoryDefaultProvenance
): Promise<boolean> {
  const failure = mapGitHubProviderResultToRepositoryDefaultFailure(
    result,
    provenance
  );
  if (!failure) {
    return Promise.resolve(false);
  }
  return persistPullRequestHeadRepositoryAuthority(db, scope, {
    unavailable: failure.observation,
  });
}
