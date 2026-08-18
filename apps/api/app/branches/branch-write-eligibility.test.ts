import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import {
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultReason,
  RepositoryDefaultSource,
  repositoryDefaultAuthorityValidator,
} from "@repo/api/src/types/repository-default-identity";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import { describe, expect, it, vi } from "vitest";
import { renderSql } from "@/__tests__/support/branches/branch-read-service.test-helpers";
import {
  CloudBranchNonMaterializationKind,
  resolveCloudBranchWriteEligibility,
} from "./branch-write-eligibility";

describe("resolveCloudBranchWriteEligibility", () => {
  it("binds an installed Branch repository id to its immutable provider id", async () => {
    const tx = client([persistedAuthority({ githubRepoId: "123" })]);

    const result = await resolveCloudBranchWriteEligibility(tx, {
      ...input(),
      repositoryDefaultObservation: {
        authority: incomingAuthority({ providerRepositoryId: "999" }),
      },
    });

    expect(result).toEqual({
      kind: "not_materialized",
      cause: CloudBranchNonMaterializationKind.ConflictingAuthority,
      reason: RepositoryDefaultReason.Conflicting,
    });
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    const sql = renderSql(tx.$queryRaw.mock.calls[0]?.[0]);
    expect(sql).toContain("repository.id =");
    expect(sql).toContain("FOR SHARE OF repository, installation");
  });

  it("never rewrites provider authority identity from caller identity", async () => {
    const tx = client([
      persistedAuthority({ fullName: "closedloop-ai/different" }),
    ]);

    const result = await resolveCloudBranchWriteEligibility(tx, input());

    expect(result).toEqual({
      kind: "not_materialized",
      cause: CloudBranchNonMaterializationKind.IdentityMismatch,
      reason: RepositoryDefaultReason.Malformed,
    });
  });

  it("keeps malformed retained authority in the decision instead of falling back", async () => {
    const tx = client([
      persistedAuthority({
        defaultBranchObservationKey: null,
        defaultBranchObservedAt: null,
      }),
    ]);

    const result = await resolveCloudBranchWriteEligibility(tx, {
      ...input(),
      repositoryDefaultObservation: { authority: incomingAuthority() },
    });

    expect(result).toMatchObject({
      kind: "not_materialized",
      cause: CloudBranchNonMaterializationKind.AuthorityUnavailable,
    });
  });

  it("fails closed for provider-id disagreement across repo-less retained sources", async () => {
    const tx = client(
      [persistedAuthority({ githubRepoId: "123" })],
      [persistedAuthority({ githubRepoId: "999" })]
    );

    const result = await resolveCloudBranchWriteEligibility(tx, {
      ...input(),
      repositoryId: null,
      repositoryDefaultObservation: undefined,
    });

    expect(result).toEqual({
      kind: "not_materialized",
      cause: CloudBranchNonMaterializationKind.ConflictingAuthority,
      reason: RepositoryDefaultReason.Conflicting,
    });
  });

  it("allows a repo-less exact fresh authority without inventing an installation id", async () => {
    const tx = client([], []);

    const result = await resolveCloudBranchWriteEligibility(tx, {
      ...input(),
      repositoryId: null,
      repositoryDefaultObservation: { authority: incomingAuthority() },
    });

    expect(result).toEqual({ kind: "eligible" });
  });

  it("lets fresh provider authority supersede an all-null legacy group", async () => {
    const tx = client([legacyPersistedAuthority()]);

    const result = await resolveCloudBranchWriteEligibility(tx, {
      ...input(),
      repositoryDefaultObservation: { authority: incomingAuthority() },
    });

    expect(result).toEqual({ kind: "eligible" });
  });
});

function input() {
  return {
    organizationId: "org-1",
    repositoryId: "repo-1",
    repositoryFullName: "ClosedLoop-AI/Sidecar.git",
    branchName: "feature/cloud",
  };
}

function incomingAuthority(overrides: { providerRepositoryId?: string } = {}) {
  return repositoryDefaultAuthorityValidator.parse({
    repository: {
      provider: VcsProviderKind.GitHub,
      providerRepositoryId: overrides.providerRepositoryId ?? "123",
      fullName: "closedloop-ai/sidecar",
    },
    evidence: {
      availability: RepositoryDefaultAvailability.Available,
      completeness: RepositoryDefaultCompleteness.Complete,
      defaultBranch: "main",
    },
    provenance: {
      source: RepositoryDefaultSource.PullRequestRest,
      mechanism: GitHubFetchMechanism.Rest,
      trigger: GitHubFetchTrigger.UserAction,
      credentialType: GitHubFetchCredentialType.GitHubApp,
      observationKey: "fresh-observation",
      observedAt: "2026-08-11T12:00:00.000Z",
    },
  });
}

function persistedAuthority(
  overrides: {
    defaultBranchObservationKey?: string | null;
    defaultBranchObservedAt?: Date | null;
    fullName?: string;
    githubRepoId?: string;
  } = {}
): PersistedAuthorityFixture {
  return { ...completePersistedAuthority(), ...overrides };
}

function completePersistedAuthority() {
  return {
    githubRepoId: "123",
    fullName: "closedloop-ai/sidecar",
    defaultBranchName: "main",
    defaultBranchAvailability: RepositoryDefaultAvailability.Available,
    defaultBranchCompleteness: RepositoryDefaultCompleteness.Complete,
    defaultBranchReason: null,
    defaultBranchSource: RepositoryDefaultSource.RepositoryRest,
    defaultBranchMechanism: GitHubFetchMechanism.Rest,
    defaultBranchTrigger: GitHubFetchTrigger.SurfaceOpen,
    defaultBranchCredentialType: GitHubFetchCredentialType.GitHubApp,
    defaultBranchCredentialOwnerId: null,
    defaultBranchObservationKey: "persisted-observation",
    defaultBranchObservedAt: new Date("2026-08-11T11:00:00.000Z"),
    defaultBranchEventAt: null,
  };
}

function legacyPersistedAuthority(): PersistedAuthorityFixture {
  return {
    ...completePersistedAuthority(),
    defaultBranchName: null,
    defaultBranchAvailability: null,
    defaultBranchCompleteness: null,
    defaultBranchReason: null,
    defaultBranchSource: null,
    defaultBranchMechanism: null,
    defaultBranchTrigger: null,
    defaultBranchCredentialType: null,
    defaultBranchCredentialOwnerId: null,
    defaultBranchObservationKey: null,
    defaultBranchObservedAt: null,
    defaultBranchEventAt: null,
  };
}

function client(
  installationRows: PersistedAuthorityFixture[],
  publicRows: PersistedAuthorityFixture[] = []
) {
  return {
    $queryRaw: vi
      .fn()
      .mockImplementation((query: unknown) =>
        Promise.resolve(
          renderSql(query).includes("public_repositories")
            ? publicRows
            : installationRows
        )
      ),
  };
}

type PersistedAuthorityFixture = {
  githubRepoId: string;
  fullName: string;
  defaultBranchName: string | null;
  defaultBranchAvailability: string | null;
  defaultBranchCompleteness: string | null;
  defaultBranchReason: string | null;
  defaultBranchSource: string | null;
  defaultBranchMechanism: string | null;
  defaultBranchTrigger: string | null;
  defaultBranchCredentialType: string | null;
  defaultBranchCredentialOwnerId: string | null;
  defaultBranchObservationKey: string | null;
  defaultBranchObservedAt: Date | null;
  defaultBranchEventAt: Date | null;
};
