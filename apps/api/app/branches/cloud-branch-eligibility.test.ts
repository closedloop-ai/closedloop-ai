import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import {
  type NormalizedPersistedRepositoryDefaultAuthority,
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  type RepositoryDefaultEvidence,
  RepositoryDefaultReason,
  RepositoryDefaultSource,
} from "@repo/api/src/types/repository-default-identity";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import { describe, expect, it } from "vitest";
import { renderSql } from "@/__tests__/support/branches/branch-read-service.test-helpers";
import {
  branchHasCloudEligibility,
  isCloudBranchEligible,
} from "./cloud-branch-eligibility";

describe("isCloudBranchEligible", () => {
  it("admits only a non-default branch with complete exact authority", () => {
    expect(eligible("feature/cloud", [authority()])).toBe(true);
    expect(eligible("main", [authority()])).toBe(false);
  });

  it("re-evaluates a changed default from the newest observation", () => {
    expect(
      eligible("main", [
        authority({
          defaultBranch: "main",
          observedAt: "2026-08-10T00:00:00.000Z",
        }),
        authority({
          defaultBranch: "trunk",
          observedAt: "2026-08-11T00:00:00.000Z",
        }),
      ])
    ).toBe(true);
  });

  it("orders comparable webhook observations by provider event time", () => {
    expect(
      eligible("main", [
        authority({
          defaultBranch: "main",
          mechanism: GitHubFetchMechanism.Webhook,
          observedAt: "2026-08-11T00:00:00.000Z",
          eventAt: "2026-08-10T20:00:00.000Z",
        }),
        authority({
          defaultBranch: "trunk",
          mechanism: GitHubFetchMechanism.Webhook,
          observedAt: "2026-08-10T23:00:00.000Z",
          eventAt: "2026-08-10T21:00:00.000Z",
        }),
      ])
    ).toBe(true);
  });

  it("does not let a delayed webhook outrank a newer REST snapshot", () => {
    expect(
      eligible("main", [
        authority({
          defaultBranch: "trunk",
          mechanism: GitHubFetchMechanism.Rest,
          observedAt: "2026-08-11T00:00:00.000Z",
        }),
        authority({
          defaultBranch: "main",
          mechanism: GitHubFetchMechanism.Webhook,
          observedAt: "2026-08-11T01:00:00.000Z",
          eventAt: "2026-08-10T23:00:00.000Z",
        }),
      ])
    ).toBe(true);
  });

  it("does not fall back when the newest observation is unavailable", () => {
    expect(
      eligible("feature/cloud", [
        authority({ observedAt: "2026-08-10T00:00:00.000Z" }),
        authority({
          availability: RepositoryDefaultAvailability.Unavailable,
          completeness: RepositoryDefaultCompleteness.Unavailable,
          observedAt: "2026-08-11T00:00:00.000Z",
        }),
      ])
    ).toBe(false);
  });

  it("fails closed for legacy, partial, stale, malformed, and identity mismatch", () => {
    const legacy = legacyAuthority();
    expect(eligible("feature/cloud", [legacy])).toBe(false);
    expect(
      eligible("feature/cloud", [
        authority({
          availability: RepositoryDefaultAvailability.Stale,
          completeness: RepositoryDefaultCompleteness.Partial,
        }),
      ])
    ).toBe(false);
    expect(
      eligible("feature/cloud", [authority({ providerRepositoryId: "999" })])
    ).toBe(false);
    expect(
      eligible("feature/cloud", [
        authority({ observedAt: "not-an-instant" }),
        authority({ observedAt: "2026-08-11T00:00:00.000Z" }),
      ])
    ).toBe(false);
  });

  it("treats an all-null legacy group as absence when fresh authority exists", () => {
    expect(eligible("feature/cloud", [legacyAuthority(), authority()])).toBe(
      true
    );

    const corrupt = authority();
    corrupt.provenance = undefined;
    expect(eligible("feature/cloud", [corrupt, authority()])).toBe(false);
  });

  it("fails closed when equally current sources disagree", () => {
    expect(
      eligible("feature/cloud", [
        authority(),
        authority({ defaultBranch: "trunk" }),
      ])
    ).toBe(false);
  });

  it("uses exact fork-head authority without inferring the base repository", () => {
    const baseAuthority = authority({
      fullName: "acme/base",
      providerRepositoryId: "456",
    });
    const forkAuthority = authority({
      fullName: "contributor/fork",
      providerRepositoryId: "789",
    });
    expect(
      isCloudBranchEligible({
        branchName: "feature/cloud",
        repository: {
          provider: VcsProviderKind.GitHub,
          providerRepositoryId: "789",
          fullName: "contributor/fork",
        },
        authorities: [baseAuthority, forkAuthority],
      })
    ).toBe(true);
    expect(
      isCloudBranchEligible({
        branchName: "feature/cloud",
        repository: {
          provider: VcsProviderKind.GitHub,
          providerRepositoryId: "789",
          fullName: "contributor/fork",
        },
        authorities: [baseAuthority],
      })
    ).toBe(false);
  });

  it("scopes the by-id twin and every persisted authority source to one organization", async () => {
    let captured: unknown;
    const eligible = await branchHasCloudEligibility(
      {
        $queryRaw: <T>(query: unknown) => {
          captured = query;
          return Promise.resolve([
            { id: "22222222-2222-4222-8222-222222222222" },
          ] as T);
        },
      },
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222"
    );

    const sql = renderSql(captured);
    expect(eligible).toBe(true);
    expect(sql).toContain("a.organization_id");
    expect(sql).toContain("pr.organization_id = a.organization_id");
    expect(sql).toContain("installation.organization_id = a.organization_id");
    expect(sql).toContain(
      "public_repository.organization_id = a.organization_id"
    );
    expect(sql).toContain(
      "LOWER(repository.full_name) = b.repository_full_name"
    );
    expect(sql).toContain(
      "LOWER(public_repository.full_name) = b.repository_full_name"
    );
    expect(sql).toContain("branch_participation");
    expect(sql).toContain("pr.id = b.current_pull_request_detail_id");
    expect(sql).toContain(
      "AND LOWER(pr.head_repository_full_name) = b.repository_full_name"
    );
    expect(sql).toContain("current_pull_request_authority");
    expect(sql).toContain(
      "pr.head_repository_default_branch_observed_at IS NOT NULL"
    );
    expect(sql).toContain("head_repository_default_branch_reason");
    expect(sql).toContain("head_repository_default_branch_observation_key");
    expect(sql).toContain("head_repository_default_branch_event_at");
    expect(sql).toContain(
      "COALESCE(authority.event_at, authority.observed_at)"
    );
    expect(sql).toContain("repository.id = b.repository_id");
    expect(sql).toContain("COALESCE(BOOL_AND");
  });
});

function eligible(
  branchName: string,
  authorities: NormalizedPersistedRepositoryDefaultAuthority[]
) {
  return isCloudBranchEligible({
    branchName,
    repository: {
      provider: VcsProviderKind.GitHub,
      providerRepositoryId: "123",
      fullName: "acme/api",
    },
    authorities,
  });
}

function authority(
  overrides: {
    availability?: RepositoryDefaultAvailability;
    completeness?: RepositoryDefaultCompleteness;
    defaultBranch?: string;
    eventAt?: string;
    mechanism?: GitHubFetchMechanism;
    observedAt?: string;
    providerRepositoryId?: string;
    fullName?: string;
  } = {}
): NormalizedPersistedRepositoryDefaultAuthority {
  const evidence = authorityEvidence(overrides);
  return {
    repository: {
      provider: VcsProviderKind.GitHub,
      providerRepositoryId: overrides.providerRepositoryId ?? "123",
      fullName: overrides.fullName ?? "acme/api",
    },
    evidence,
    provenance: {
      source: RepositoryDefaultSource.RepositoryRest,
      mechanism: overrides.mechanism ?? GitHubFetchMechanism.Rest,
      trigger: GitHubFetchTrigger.UserAction,
      credentialType: GitHubFetchCredentialType.UserOAuth,
      observationKey: "observation-1",
      observedAt: overrides.observedAt ?? "2026-08-11T00:00:00.000Z",
      ...(overrides.eventAt ? { eventAt: overrides.eventAt } : {}),
    },
  };
}

function legacyAuthority(): NormalizedPersistedRepositoryDefaultAuthority {
  return {
    repository: {
      provider: VcsProviderKind.GitHub,
      providerRepositoryId: "123",
      fullName: "acme/api",
    },
    evidence: {
      availability: RepositoryDefaultAvailability.Unavailable,
      completeness: RepositoryDefaultCompleteness.Unavailable,
      reason: RepositoryDefaultReason.LegacyRecord,
    },
  };
}

function authorityEvidence(overrides: {
  availability?: RepositoryDefaultAvailability;
  completeness?: RepositoryDefaultCompleteness;
  defaultBranch?: string;
}): RepositoryDefaultEvidence {
  if (overrides.availability === RepositoryDefaultAvailability.Stale) {
    return {
      availability: RepositoryDefaultAvailability.Stale,
      completeness: RepositoryDefaultCompleteness.Partial,
      defaultBranch: overrides.defaultBranch ?? "main",
      reason: RepositoryDefaultReason.ProviderError,
    };
  }
  if (
    overrides.availability === RepositoryDefaultAvailability.Unavailable ||
    (overrides.completeness !== undefined &&
      overrides.completeness !== RepositoryDefaultCompleteness.Complete)
  ) {
    return {
      availability: RepositoryDefaultAvailability.Unavailable,
      completeness:
        overrides.completeness === RepositoryDefaultCompleteness.Partial
          ? RepositoryDefaultCompleteness.Partial
          : RepositoryDefaultCompleteness.Unavailable,
      reason: RepositoryDefaultReason.ProviderError,
    };
  }
  return {
    availability: RepositoryDefaultAvailability.Available,
    completeness: RepositoryDefaultCompleteness.Complete,
    defaultBranch: overrides.defaultBranch ?? "main",
  };
}
