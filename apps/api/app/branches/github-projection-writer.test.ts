vi.mock("./branch-detail-signal", () => ({ emitBranchDetailChanged: vi.fn() }));

import {
  BranchBaseBranchSource,
  BranchHeadShaSource,
} from "@repo/api/src/types/artifact";
import {
  GitHubCredentialKind,
  GitHubPRState,
} from "@repo/api/src/types/github";
import { GitHubActorType } from "@repo/api/src/types/github-actor";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
  GitHubSyncResultReason,
} from "@repo/api/src/types/github-read-model";
import {
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultSource,
  repositoryDefaultAuthorityValidator,
} from "@repo/api/src/types/repository-default-identity";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import { clerkClient } from "@repo/auth/server";
import { GitHubInstallationStatus, withDb } from "@repo/database";
import {
  GitHubProviderResultStatus,
  type GitHubSinglePullRequestResult,
  getSinglePullRequestWithProviderResult,
} from "@repo/github";
import { getUserTokenOctokit } from "@repo/github/user-token-auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pullRequestInput } from "@/__tests__/support/branches/github-projection-writer.test-fixtures";
import { writeReconciledPullRequest } from "@/app/cron/reconcile-pull-requests/reconcile-projection-write";
import {
  GitHubServerSyncStatus,
  githubServerSyncService,
} from "@/app/integrations/github/sync-service";
import { settleActiveBranchPullRequestRefresh } from "./branch-pull-request-authority-refresh";
import { branchService } from "./branch-service";
import {
  BranchProjectionMode,
  writeExistingBranchPullRequestProjection,
} from "./github-projection-writer";
import { ensurePullRequestAuthorIdentity } from "./pull-request-author-identity";

const {
  invalidateBranchStatusChecksForHeadChangeMock,
  persistPullRequestLifecycleActivityMock,
  refilePullRequestUnderGitHubHeadMock,
} = vi.hoisted(() => ({
  invalidateBranchStatusChecksForHeadChangeMock: vi.fn(),
  persistPullRequestLifecycleActivityMock: vi.fn(),
  refilePullRequestUnderGitHubHeadMock: vi.fn(),
}));

// ISS-12463: the branch-owner seed is raw SQL this stubbed database does not
// model; its wiring is pinned by the real-Postgres seed-wiring suite.
vi.mock("@/app/branches/branch-owner-seed/branch-owner-seed", () => ({
  seedBranchOwners: vi.fn().mockResolvedValue(0),
}));

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule({
    ChecksStatus: { UNKNOWN: "UNKNOWN", PENDING: "PENDING" },
  });
});

vi.mock("@/lib/branch-status-checks", () => ({
  invalidateBranchStatusChecksForHeadChange:
    invalidateBranchStatusChecksForHeadChangeMock,
}));

vi.mock("@/app/branches/pull-request-lifecycle-activity", () => ({
  persistPullRequestLifecycleActivityInTransaction:
    persistPullRequestLifecycleActivityMock,
}));

vi.mock("./pull-request-author-identity", () => ({
  ensurePullRequestAuthorIdentity: vi.fn(),
}));

vi.mock("./pull-request-github-head-refile", () => ({
  refilePullRequestUnderGitHubHead: refilePullRequestUnderGitHubHeadMock,
}));

vi.mock("@repo/github", async () => {
  const actual =
    await vi.importActual<typeof import("@repo/github")>("@repo/github");
  return {
    ...actual,
    getSinglePullRequestWithProviderResult: vi.fn(),
  };
});

vi.mock("@repo/github/user-token-auth", () => ({
  getUserTokenOctokit: vi.fn(),
}));

vi.mock("@repo/auth/server", () => ({
  clerkClient: vi.fn(),
}));

const dbMock = {
  $executeRaw: vi.fn(),
  $queryRaw: vi.fn(),
  artifactLink: {
    findMany: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    update: vi.fn(),
  },
  branchDetail: {
    findFirst: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  pullRequestDetail: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    updateManyAndReturn: vi.fn(),
    upsert: vi.fn(),
  },
  repositoryDefaultObservationReceipt: { createMany: vi.fn() },
};

describe("writeExistingBranchPullRequestProjection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.branchDetail.findFirst.mockResolvedValue({
      artifactId: "branch-artifact-1",
      headSha: "old-sha",
    });
    dbMock.pullRequestDetail.findMany.mockResolvedValue([]);
    dbMock.pullRequestDetail.findFirst.mockImplementation(({ where }) =>
      where.id
        ? {
            id: where.id,
            branchArtifactId: "branch-artifact-1",
          }
        : null
    );
    dbMock.pullRequestDetail.findUnique.mockResolvedValue(null);
    dbMock.$executeRaw.mockResolvedValue(1);
    dbMock.$queryRaw.mockImplementation((query: { sql?: string }) => {
      if (query.sql?.includes("FROM pull_request_detail AS pr")) {
        return [
          {
            branchArtifactId: "branch-artifact-1",
            organizationId: "org-1",
            repositoryFullName: "acme/app",
            number: 123,
          },
        ];
      }
      if (query.sql?.includes("FROM branch_detail")) {
        return [{ artifactId: "branch-artifact-1" }];
      }
      return [];
    });
    dbMock.artifactLink.findMany.mockResolvedValue([]);
    dbMock.pullRequestDetail.update.mockResolvedValue({});
    dbMock.pullRequestDetail.updateMany.mockResolvedValue({ count: 1 });
    dbMock.pullRequestDetail.upsert.mockResolvedValue({ id: "pr-detail-1" });
    dbMock.branchDetail.update.mockResolvedValue({});
    dbMock.branchDetail.updateMany.mockResolvedValue({ count: 1 });
    invalidateBranchStatusChecksForHeadChangeMock.mockResolvedValue(undefined);
  });

  it("writes the full branch projection and current PR pointer", async () => {
    await writeExistingBranchPullRequestProjection(
      transactionClient(),
      {
        branchArtifactId: "branch-artifact-1",
        currentHeadSha: "old-sha",
      },
      {
        ...pullRequestInput(),
        authorLogin: "octocat",
        authorProviderUserId: "123",
        authorActorType: GitHubActorType.User,
      }
    );

    expect(dbMock.branchDetail.updateMany).toHaveBeenCalledWith({
      where: { artifactId: "branch-artifact-1", organizationId: "org-1" },
      data: expect.objectContaining({
        baseBranch: "main",
        baseBranchSource: BranchBaseBranchSource.PullRequestBase,
        branchName: "feature/shared",
        headSha: "new-sha",
        headShaSource: BranchHeadShaSource.PullRequestWebhook,
      }),
    });
    expect(invalidateBranchStatusChecksForHeadChangeMock).toHaveBeenCalledWith(
      dbMock,
      "branch-artifact-1"
    );
    expect(dbMock.pullRequestDetail.updateMany).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        branchArtifactId: "branch-artifact-1",
        isCurrent: true,
        id: { not: "pr-detail-1" },
      },
      data: { isCurrent: false },
    });
    expect(dbMock.branchDetail.updateMany).toHaveBeenCalledWith({
      where: { artifactId: "branch-artifact-1", organizationId: "org-1" },
      data: { currentPullRequestDetailId: "pr-detail-1" },
    });
    expect(ensurePullRequestAuthorIdentity).toHaveBeenCalledWith(dbMock, {
      organizationId: "org-1",
      githubId: "github-pr-123",
      authorLogin: "octocat",
      authorProviderUserId: "123",
      authorActorType: GitHubActorType.User,
    });
  });

  it("can update only the PR detail and branch pointer for synchronize ownership", async () => {
    dbMock.pullRequestDetail.findMany.mockResolvedValueOnce([
      {
        id: "pr-detail-1",
        branchArtifactId: "branch-artifact-1",
        githubId: "github-pr-123",
        repositoryId: "repo-1",
        repositoryFullName: "acme/app",
        number: 123,
      },
    ]);
    dbMock.$queryRaw
      .mockResolvedValueOnce([
        {
          branchArtifactId: "branch-artifact-1",
          organizationId: "org-1",
          repositoryFullName: "acme/app",
          number: 123,
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ artifactId: "branch-artifact-1" }])
      .mockResolvedValueOnce([]);
    await writeExistingBranchPullRequestProjection(
      transactionClient(),
      {
        branchArtifactId: "branch-artifact-1",
        branchProjectionMode: BranchProjectionMode.PointerOnly,
        currentHeadSha: "old-sha",
        pullRequestDetailId: "pr-detail-1",
      },
      pullRequestInput()
    );

    expect(dbMock.pullRequestDetail.updateMany).toHaveBeenCalledWith({
      where: { id: "pr-detail-1", organizationId: "org-1" },
      data: expect.objectContaining({
        additions: 44,
        deletions: 6,
        changedFiles: 3,
        htmlUrl: "https://github.com/acme/app/pull/123",
        isCurrent: true,
        title: "Shared writer",
      }),
    });
    expect(
      invalidateBranchStatusChecksForHeadChangeMock
    ).not.toHaveBeenCalled();
    expect(dbMock.branchDetail.updateMany).toHaveBeenCalledWith({
      where: { artifactId: "branch-artifact-1", organizationId: "org-1" },
      data: { currentPullRequestDetailId: "pr-detail-1" },
    });
  });

  it("persists provider head authority through the production projection writer", async () => {
    dbMock.pullRequestDetail.findFirst.mockResolvedValue(
      emptyStoredAuthority()
    );
    dbMock.pullRequestDetail.updateMany.mockResolvedValue({ count: 1 });

    await writeExistingBranchPullRequestProjection(
      transactionClient(),
      { branchArtifactId: "branch-artifact-1", currentHeadSha: "old-sha" },
      {
        ...pullRequestInput(),
        headRefOid: "exact-head-oid",
        headRepositoryObservation: {
          authority: {
            repository: {
              provider: VcsProviderKind.GitHub,
              providerRepositoryId: "5826",
              fullName: "fork-owner/repo",
            },
            evidence: {
              availability: RepositoryDefaultAvailability.Available,
              completeness: RepositoryDefaultCompleteness.Complete,
              defaultBranch: "trunk",
            },
            provenance: {
              source: RepositoryDefaultSource.PullRequestRest,
              mechanism: GitHubFetchMechanism.Rest,
              trigger: GitHubFetchTrigger.Backfill,
              credentialType: GitHubFetchCredentialType.GitHubApp,
              observationKey: "rest-attempt-1",
              observedAt: "2026-08-10T20:00:00.000Z",
            },
          },
        },
      }
    );

    expect(dbMock.pullRequestDetail.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          headRepositoryGithubId: "5826",
          headRepositoryDefaultBranchName: "trunk",
          headRepositoryDefaultBranchObservationKey: "rest-attempt-1",
        }),
      })
    );
    expect(dbMock.pullRequestDetail.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          headRefName: "feature/shared",
          headRefOid: "exact-head-oid",
        }),
      })
    );
    expect(dbMock.pullRequestDetail.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.not.objectContaining({ headRefName: expect.anything() }),
        update: expect.not.objectContaining({ headRefName: expect.anything() }),
      })
    );
    expect(dbMock.pullRequestDetail.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.not.objectContaining({ headRefOid: expect.anything() }),
        update: expect.not.objectContaining({ headRefOid: expect.anything() }),
      })
    );
  });

  it("does not substitute branch head state for an explicitly unavailable PR-head oid", async () => {
    dbMock.pullRequestDetail.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        ...emptyStoredAuthority(),
        headRefName: "feature/existing",
        headRefOid: "existing-pr-head-oid",
      });

    await writeExistingBranchPullRequestProjection(
      transactionClient(),
      { branchArtifactId: "branch-artifact-1", currentHeadSha: "old-sha" },
      {
        ...pullRequestInput(),
        headSha: "branch-projection-sha",
        headRefOid: null,
        headRepositoryObservation: {
          authority: providerHeadAuthority("fork-owner/repo"),
        },
      }
    );

    expect(dbMock.pullRequestDetail.findFirst).toHaveBeenCalledTimes(2);
    expect(dbMock.pullRequestDetail.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          headRefName: expect.anything(),
          headRefOid: expect.anything(),
        }),
      })
    );
  });

  it("does not invent a PR head name from a projection without head authority", async () => {
    await writeExistingBranchPullRequestProjection(
      transactionClient(),
      { branchArtifactId: "branch-artifact-1", currentHeadSha: "old-sha" },
      { ...pullRequestInput(), headRepositoryObservation: undefined }
    );

    expect(dbMock.pullRequestDetail.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.not.objectContaining({ headRefName: expect.anything() }),
        update: expect.not.objectContaining({ headRefName: expect.anything() }),
      })
    );
  });
});

describe("settleActiveBranchPullRequestRefresh", () => {
  it("passes the provider head pair through the active-refresh authority write", async () => {
    vi.clearAllMocks();
    dbMock.pullRequestDetail.findFirst.mockResolvedValue(
      emptyStoredAuthority()
    );
    dbMock.pullRequestDetail.updateMany.mockResolvedValue({ count: 1 });
    const txMock = vi.mocked(withDb.tx);
    txMock.mockImplementation((callback) => callback(transactionClient()));

    try {
      const wrote = await settleActiveBranchPullRequestRefresh({
        organizationId: "org-1",
        branchArtifactId: "branch-artifact-1",
        repositoryId: "repo-1",
        pullRequestDetailId: "pr-detail-1",
        freshPr: providerPullRequest(),
        now: new Date("2026-08-10T20:00:00.000Z"),
      });

      expect(wrote).toBe(true);
      expect(dbMock.pullRequestDetail.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            headRefName: "feature/provider-head",
            headRefOid: "provider-head-oid",
          }),
        })
      );
      // ISS-12344: the settled read then re-files the PR under its head.
      expect(refilePullRequestUnderGitHubHeadMock).toHaveBeenCalledWith(
        "org-1",
        "pr-detail-1",
        providerPullRequest()
      );
    } finally {
      txMock.mockReset();
    }
  });

  it("asks for no ISS-12344 move when the guarded settle lost its row", async () => {
    vi.clearAllMocks();
    dbMock.pullRequestDetail.updateMany.mockResolvedValue({ count: 0 });
    const txMock = vi.mocked(withDb.tx);
    txMock.mockImplementation((callback) => callback(transactionClient()));

    try {
      const wrote = await settleActiveBranchPullRequestRefresh({
        organizationId: "org-1",
        branchArtifactId: "branch-artifact-1",
        repositoryId: "repo-1",
        pullRequestDetailId: "pr-detail-1",
        freshPr: providerPullRequest(),
        now: new Date("2026-08-10T20:00:00.000Z"),
      });

      expect(wrote).toBe(false);
      expect(refilePullRequestUnderGitHubHeadMock).not.toHaveBeenCalled();
    } finally {
      txMock.mockReset();
    }
  });
});

describe("githubServerSyncService", () => {
  it("persists the tombstoned provider head pair through the production entry", async () => {
    vi.clearAllMocks();
    const tx = tombstonedSyncTransaction();
    const withDbMock = vi.mocked(withDb) as ReturnType<typeof vi.fn>;
    const txMock = vi.mocked(withDb.tx);
    const userTokenOctokit = { kind: "user-token-octokit" };
    withDbMock.mockImplementation((callback) => callback(tx as never));
    txMock.mockImplementation((callback) => callback(tx as never));
    // PLN-1742 M5 tail: the user credential comes from Clerk alone.
    vi.mocked(clerkClient).mockResolvedValue({
      users: {
        getUserOauthAccessToken: vi.fn().mockResolvedValue({
          data: [
            { token: "clerk-token", scopes: ["repo"], externalAccountId: "ea" },
          ],
        }),
      },
    } as never);
    const getUserTokenOctokitMock = getUserTokenOctokit as ReturnType<
      typeof vi.fn
    >;
    getUserTokenOctokitMock.mockReturnValue(userTokenOctokit);
    vi.mocked(getSinglePullRequestWithProviderResult).mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: tombstonedProviderPullRequest(),
    });

    try {
      const result =
        await githubServerSyncService.refreshTombstonedBranchPullRequest({
          actorUserId: "user-1",
          branchArtifactId: "branch-artifact-1",
          organizationId: "org-1",
          now: new Date("2026-08-10T20:00:00.000Z"),
        });

      expect(result).toEqual({
        status: GitHubServerSyncStatus.Refreshed,
        reason: GitHubSyncResultReason.Success,
      });
      expect(tx.pullRequestDetail.updateMany).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          data: expect.objectContaining({
            authorLogin: "octocat",
            authorProviderUserId: "123",
            authorActorType: GitHubActorType.User,
          }),
        })
      );
      expect(tx.pullRequestDetail.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "pr-detail-1",
            organizationId: "org-1",
            headRefName: null,
            headRefOid: null,
          }),
          data: expect.objectContaining({
            headRefName: "feature/tombstoned",
            headRefOid: "tombstoned-head-oid",
          }),
        })
      );
      // ISS-12344: the settled read then re-files the PR under its head.
      expect(refilePullRequestUnderGitHubHeadMock).toHaveBeenCalledWith(
        "org-1",
        "pr-detail-1",
        tombstonedProviderPullRequest()
      );
    } finally {
      withDbMock.mockReset();
      txMock.mockReset();
    }
  });
});

describe("branchService PR projection", () => {
  it("passes the branch name and provider head oid through the authority CAS", async () => {
    const tx = branchServiceTransaction();
    const txMock = vi.mocked(withDb.tx);
    txMock.mockImplementation((callback) => callback(tx as never));

    try {
      const authority = providerHeadAuthority("acme/app");
      const result = await branchService.upsertBranchArtifact({
        organizationId: "org-1",
        repositoryId: "repo-1",
        repositoryFullName: "acme/app",
        branchName: "feature/branch-service",
        projectId: null,
        headSha: "branch-service-head-oid",
        repositoryDefaultObservation: { authority },
        pullRequest: {
          githubId: "github-pr-123",
          number: 123,
          title: "Branch service writer",
          htmlUrl: "https://github.com/acme/app/pull/123",
          state: GitHubPRState.Open,
          headRepositoryObservation: { authority },
        },
      });

      expect(result.ok).toBe(true);
      expect(tx.pullRequestDetail.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            headRefName: "feature/branch-service",
            headRefOid: "branch-service-head-oid",
          }),
        })
      );
    } finally {
      txMock.mockReset();
    }
  });
});

describe("writeReconciledPullRequest", () => {
  it("passes the GraphQL head pair through the reconciliation authority write", async () => {
    vi.clearAllMocks();
    // ISS-8919: identity is one batched read keyed on `number: { in: [...] }`,
    // not a per-PR findUnique.
    dbMock.pullRequestDetail.findMany.mockImplementation(
      (args: { where?: { number?: { in?: number[] } } }) =>
        Promise.resolve(
          (args?.where?.number?.in ?? []).map((number) => ({
            id: "pr-detail-1",
            number,
            branchArtifact: {
              branch: { branchName: "feature/graphql-head" },
            },
          }))
        )
    );
    dbMock.pullRequestDetail.findFirst.mockResolvedValue(
      emptyStoredAuthority()
    );
    dbMock.pullRequestDetail.updateMany.mockResolvedValue({ count: 1 });
    dbMock.pullRequestDetail.updateManyAndReturn.mockResolvedValue([
      { branchArtifactId: null },
    ]);
    const withDbMock = vi.mocked(withDb) as ReturnType<typeof vi.fn>;
    withDbMock.mockImplementation((callback) => callback(transactionClient()));
    vi.mocked(withDb.tx).mockImplementation((callback) =>
      callback(transactionClient())
    );

    try {
      const wrote = await writeReconciledPullRequest(
        providerReadModelPullRequest(),
        {
          organizationId: "org-1",
          repositoryId: "repo-1",
          repositoryFullName: "acme/app",
          credentialKind: GitHubCredentialKind.Installation,
          credentialOwnerId: null,
          now: new Date("2026-08-10T20:00:00.000Z"),
        }
      );

      expect(wrote).toBe(true);
      expect(dbMock.pullRequestDetail.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            headRefName: "feature/graphql-head",
            headRefOid: "graphql-head-oid",
          }),
        })
      );
    } finally {
      withDbMock.mockReset();
    }
  });
});

function transactionClient() {
  return dbMock as unknown as Parameters<
    typeof writeExistingBranchPullRequestProjection
  >[0];
}

function emptyStoredAuthority() {
  return {
    headRefName: null,
    headRefOid: null,
    headRepositoryGithubId: null,
    headRepositoryFullName: null,
    headRepositoryDefaultBranchName: null,
    headRepositoryDefaultBranchAvailability: null,
    headRepositoryDefaultBranchCompleteness: null,
    headRepositoryDefaultBranchReason: null,
    headRepositoryDefaultBranchSource: null,
    headRepositoryDefaultBranchMechanism: null,
    headRepositoryDefaultBranchTrigger: null,
    headRepositoryDefaultBranchCredentialType: null,
    headRepositoryDefaultBranchCredentialOwnerId: null,
    headRepositoryDefaultBranchObservationKey: null,
    headRepositoryDefaultBranchObservedAt: null,
    headRepositoryDefaultBranchEventAt: null,
  };
}

function providerPullRequest() {
  return {
    ...pullRequestInput(),
    headBranch: "feature/provider-head",
    headSha: "provider-head-oid",
    headRepository: providerHeadAuthority("fork-owner/repo"),
  } as never;
}

function providerHeadAuthority(fullName: string) {
  return repositoryDefaultAuthorityValidator.parse({
    repository: {
      provider: VcsProviderKind.GitHub,
      providerRepositoryId: "5826",
      fullName,
    },
    evidence: {
      availability: RepositoryDefaultAvailability.Available,
      completeness: RepositoryDefaultCompleteness.Complete,
      defaultBranch: "trunk",
    },
    provenance: {
      source: RepositoryDefaultSource.PullRequestRest,
      mechanism: GitHubFetchMechanism.Rest,
      trigger: GitHubFetchTrigger.Backfill,
      credentialType: GitHubFetchCredentialType.GitHubApp,
      observationKey: "rest-attempt-1",
      observedAt: "2026-08-10T20:00:00.000Z",
    },
  });
}

function providerReadModelPullRequest() {
  return {
    ...pullRequestInput(),
    source: "provider",
    headBranch: "feature/graphql-head",
    headSha: "graphql-head-oid",
    updatedAt: "2026-08-10T20:00:00.000Z",
    headRepository: repositoryDefaultAuthorityValidator.parse({
      repository: {
        provider: VcsProviderKind.GitHub,
        providerRepositoryId: "5826",
        fullName: "fork-owner/repo",
      },
      evidence: {
        availability: RepositoryDefaultAvailability.Available,
        completeness: RepositoryDefaultCompleteness.Complete,
        defaultBranch: "trunk",
      },
      provenance: {
        source: RepositoryDefaultSource.PullRequestGraphql,
        mechanism: GitHubFetchMechanism.Graphql,
        trigger: GitHubFetchTrigger.Backfill,
        credentialType: GitHubFetchCredentialType.GitHubApp,
        observationKey: "graphql-attempt-1",
        observedAt: "2026-08-10T20:00:00.000Z",
      },
    }),
  } as never;
}

function tombstonedProviderPullRequest(): GitHubSinglePullRequestResult {
  return {
    githubId: "github-pr-1",
    number: 123,
    title: "Tombstoned PR",
    htmlUrl: "https://github.com/acme/app/pull/123",
    headBranch: "feature/tombstoned",
    baseBranch: "main",
    state: GitHubPRState.Merged,
    createdAt: "2026-08-10T19:00:00.000Z",
    mergedAt: "2026-08-10T19:30:00.000Z",
    closedAt: "2026-08-10T19:30:00.000Z",
    authorLogin: "octocat",
    authorProviderUserId: "123",
    authorActorType: GitHubActorType.User,
    isDraft: false,
    headSha: "tombstoned-head-oid",
    baseSha: "base-oid",
    mergeCommitSha: "merge-oid",
    additions: 10,
    deletions: 2,
    changedFiles: 3,
    headRepository: providerHeadAuthority("fork-owner/repo"),
  };
}

function tombstonedSyncTransaction() {
  return {
    artifact: {
      findFirst: vi.fn().mockResolvedValue({
        id: "branch-artifact-1",
        organizationId: "org-1",
        // ISS-8522: the lane derives its target from the branch's own rows, so
        // the fixture carries the row rather than a pointer join.
        pullRequestDetails: [
          {
            id: "pr-detail-1",
            branchArtifactId: "branch-artifact-1",
            repositoryId: "repo-1",
            repositoryFullName: "acme/app",
            // ISS-8901: the lane now gates on the PR's OWN repository being
            // tombstoned (`syncTargetCanonicalPullRequest`), and the production
            // select fetches `removedAt` alongside `fullName` for exactly that
            // read, so the double has to carry it too.
            repository: {
              fullName: "acme/app",
              removedAt: new Date("2026-08-10T18:00:00.000Z"),
            },
            number: 123,
            title: "Tombstoned PR",
            htmlUrl: "https://github.com/acme/app/pull/123",
            prState: "OPEN",
            isDraft: false,
            reviewDecision: null,
            githubCreatedAt: new Date("2026-08-01T00:00:00.000Z"),
            closedAt: null,
            mergedAt: null,
            lastVerifiedAt: null,
            fetchMechanism: "webhook",
            githubId: "github-pr-1",
            additions: 2,
            deletions: 1,
            changedFiles: 1,
          },
        ],
        branch: {
          repositoryId: "repo-1",
          repositoryFullName: "acme/app",
          currentPullRequestDetailId: "pr-detail-1",
          repository: {
            id: "repo-1",
            fullName: "acme/app",
            owner: "acme",
            name: "app",
            private: true,
            removedAt: new Date("2026-08-10T18:00:00.000Z"),
            installation: {
              organizationId: "org-1",
              status: GitHubInstallationStatus.ACTIVE,
            },
          },
        },
      }),
    },
    artifactLink: {
      findFirst: vi.fn().mockResolvedValue({
        metadata: {
          linkKind: SessionArtifactLinkKind.SessionPr,
          repositoryFullName: "acme/app",
          prNumber: 123,
        },
      }),
    },
    branchDetail: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    gitHubUserConnection: {
      findUnique: vi.fn().mockResolvedValue({
        id: "connection-1",
        organizationId: "org-1",
        userId: "user-1",
        githubUserId: "9001",
        login: "octocat",
        revokedAt: null,
        tokenExpiresAt: null,
        scopes: ["repo"],
        rateLimitTier: null,
        // PLN-1742 M2: this lane shares the resolver's connection read, which
        // samples `lastUsedAt` — so the row it selects carries it.
        lastUsedAt: null,
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    pullRequestDetail: {
      findFirst: vi.fn().mockResolvedValue(emptyStoredAuthority()),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    repositoryDefaultObservationReceipt: { createMany: vi.fn() },
    // PLN-1742: the Clerk lane reads the caller's Clerk id off the user row.
    user: {
      findUnique: vi.fn().mockResolvedValue({ clerkId: "c_1" }),
    },
  };
}

function branchServiceTransaction() {
  const pullRequestDetailFindFirst = vi
    .fn()
    .mockResolvedValue(emptyStoredAuthority());
  return {
    $executeRaw: vi.fn().mockResolvedValue(1),
    $queryRaw: vi.fn().mockResolvedValue([persistedRepositoryAuthority()]),
    artifact: {
      create: vi.fn().mockResolvedValue({ id: "branch-artifact-1" }),
      findUnique: vi.fn().mockResolvedValue({
        id: "branch-artifact-1",
        organizationId: "org-1",
        branch: null,
        pullRequest: null,
      }),
    },
    artifactLink: { upsert: vi.fn() },
    branchDetail: {
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    pullRequestDetail: {
      findFirst: pullRequestDetailFindFirst,
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({
        id: "pr-detail-1",
        branchArtifactId: "branch-artifact-1",
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    repositoryDefaultObservationReceipt: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

function persistedRepositoryAuthority() {
  return {
    githubRepoId: "5826",
    fullName: "acme/app",
    defaultBranchName: "trunk",
    defaultBranchAvailability: RepositoryDefaultAvailability.Available,
    defaultBranchCompleteness: RepositoryDefaultCompleteness.Complete,
    defaultBranchReason: null,
    defaultBranchSource: RepositoryDefaultSource.PullRequestRest,
    defaultBranchMechanism: GitHubFetchMechanism.Rest,
    defaultBranchTrigger: GitHubFetchTrigger.Backfill,
    defaultBranchCredentialType: GitHubFetchCredentialType.GitHubApp,
    defaultBranchCredentialOwnerId: null,
    defaultBranchObservationKey: "rest-attempt-1",
    defaultBranchObservedAt: new Date("2026-08-10T20:00:00.000Z"),
    defaultBranchEventAt: null,
  };
}
