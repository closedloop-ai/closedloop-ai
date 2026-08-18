import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import {
  RepositoryDefaultCompleteness,
  RepositoryDefaultReason,
  RepositoryDefaultSource,
} from "@repo/api/src/types/repository-default-identity";
import { describe, expect, it } from "vitest";
import {
  GitHubProviderResultStatus,
  GitHubUserTokenProviderResultStatus,
} from "../index";
import {
  classifyGitHubProviderError,
  toGitHubProviderFailure,
} from "../provider-error-classification";
import {
  createGitHubRepositoryDefaultUnavailableEvidence,
  createGitHubRepositoryDefaultUnavailableObservation,
  mapGitHubProviderResultToRepositoryDefaultFailure,
} from "../repository-default-provider-failure";

const PROVENANCE = {
  source: RepositoryDefaultSource.PullRequestRest,
  mechanism: GitHubFetchMechanism.Rest,
  trigger: GitHubFetchTrigger.UserAction,
  credentialType: GitHubFetchCredentialType.UserOAuth,
  credentialOwnerId: "11111111-1111-4111-8111-111111111111",
  observationKey: "attempt-1",
  observedAt: "2026-08-10T20:00:00.000Z",
} as const;

describe("repository-default provider failures", () => {
  it("does not manufacture poorer evidence from a successful result", () => {
    expect(
      mapGitHubProviderResultToRepositoryDefaultFailure(
        { status: GitHubProviderResultStatus.Success, value: "ok" },
        PROVENANCE
      )
    ).toBeUndefined();
  });

  it("maps rate limits and preserves nullable retry metadata outside evidence", () => {
    expect(
      mapGitHubProviderResultToRepositoryDefaultFailure(
        {
          status: GitHubProviderResultStatus.ProviderRateLimit,
          retryAfterSeconds: 37,
        },
        PROVENANCE
      )
    ).toEqual({
      observation: {
        reason: RepositoryDefaultReason.RateLimited,
        provenance: PROVENANCE,
      },
      retryAfterSeconds: 37,
    });

    expect(
      mapGitHubProviderResultToRepositoryDefaultFailure(
        {
          status: GitHubProviderResultStatus.ProviderRateLimit,
          retryAfterSeconds: null,
        },
        PROVENANCE
      )
    ).toEqual(expect.objectContaining({ retryAfterSeconds: null }));
  });

  it("maps revoked user credentials to permission denied", () => {
    expect(
      mapGitHubProviderResultToRepositoryDefaultFailure(
        {
          status: GitHubUserTokenProviderResultStatus.CredentialUnauthorized,
        },
        PROVENANCE
      )
    ).toEqual({
      observation: {
        reason: RepositoryDefaultReason.PermissionDenied,
        provenance: PROVENANCE,
      },
    });
  });

  it("distinguishes user scope denial from an installation-filtered repository", () => {
    const insufficientScope = {
      status: GitHubUserTokenProviderResultStatus.CredentialInsufficientScope,
    } as const;

    expect(
      mapGitHubProviderResultToRepositoryDefaultFailure(
        insufficientScope,
        PROVENANCE
      )?.observation.reason
    ).toBe(RepositoryDefaultReason.PermissionDenied);
    expect(
      mapGitHubProviderResultToRepositoryDefaultFailure(insufficientScope, {
        ...PROVENANCE,
        credentialType: GitHubFetchCredentialType.GitHubApp,
      })?.observation.reason
    ).toBe(RepositoryDefaultReason.PermissionFiltered);
  });

  it("maps a generic unavailable provider to provider error", () => {
    expect(
      mapGitHubProviderResultToRepositoryDefaultFailure(
        { status: GitHubProviderResultStatus.ProviderUnavailable },
        PROVENANCE
      )
    ).toEqual({
      observation: {
        reason: RepositoryDefaultReason.ProviderError,
        provenance: PROVENANCE,
      },
    });
  });

  it("maps ProviderRepoNotFound to provider error — preserving the 404 mapping that existed before ISS-5093 split the status out of ProviderUnavailable", () => {
    expect(
      mapGitHubProviderResultToRepositoryDefaultFailure(
        { status: GitHubProviderResultStatus.ProviderRepoNotFound },
        PROVENANCE
      )
    ).toEqual({
      observation: {
        reason: RepositoryDefaultReason.ProviderError,
        provenance: PROVENANCE,
      },
    });
  });

  it("keeps non-rate installation 403 failures permission-filtered", () => {
    const error = { status: 403, message: "Resource not accessible" };

    expect(classifyGitHubProviderError(error)).toEqual({
      status: GitHubProviderResultStatus.ProviderPermissionFiltered,
    });
    expect(toGitHubProviderFailure(error)).toEqual({
      status: GitHubProviderResultStatus.ProviderPermissionFiltered,
    });
    expect(
      mapGitHubProviderResultToRepositoryDefaultFailure(
        {
          status: GitHubProviderResultStatus.ProviderPermissionFiltered,
        },
        PROVENANCE
      )
    ).toEqual({
      observation: {
        reason: RepositoryDefaultReason.PermissionFiltered,
        provenance: PROVENANCE,
      },
    });
  });

  it.each([
    RepositoryDefaultReason.Capped,
    RepositoryDefaultReason.PermissionFiltered,
    RepositoryDefaultReason.Ambiguous,
    RepositoryDefaultReason.Conflicting,
  ])("constructs explicit reachable producer reason %s", (reason) => {
    expect(
      createGitHubRepositoryDefaultUnavailableObservation(reason, PROVENANCE)
    ).toEqual({ reason, provenance: PROVENANCE });
  });

  it("keeps a capped acquisition explicitly partial", () => {
    expect(
      createGitHubRepositoryDefaultUnavailableEvidence(
        RepositoryDefaultReason.Capped
      )
    ).toEqual({
      availability: "unavailable",
      completeness: RepositoryDefaultCompleteness.Partial,
      reason: RepositoryDefaultReason.Capped,
    });
  });
});
