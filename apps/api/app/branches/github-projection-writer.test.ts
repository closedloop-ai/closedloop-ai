import {
  BranchBaseBranchSource,
  BranchHeadShaSource,
} from "@repo/api/src/types/artifact";
import {
  GitHubCredentialKind,
  GitHubPRState,
} from "@repo/api/src/types/github";
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
import { GitHubInstallationStatus, withDb } from "@repo/database";
import {
  GitHubProviderResultStatus,
  type GitHubSinglePullRequestResult,
  getSinglePullRequestWithProviderResult,
} from "@repo/github";
import { getUserTokenOctokit } from "@repo/github/user-token-auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { writeReconciledPullRequest } from "@/app/cron/reconcile-pull-requests/reconcile-projection-write";
import {
  GitHubServerSyncStatus,
  githubServerSyncService,
} from "@/app/integrations/github/sync-service";
import { decryptIntegrationToken } from "@/lib/integration-encryption";
import { settleActiveBranchPullRequestRefresh } from "./branch-pull-request-authority-refresh";
import { branchService } from "./branch-service";
import {
  adoptRepolessPullRequestDetail,
  BranchProjectionMode,
  buildPullRequestDetailCreate,
  buildPullRequestDetailUpdate,
  writeExistingBranchPullRequestProjection,
} from "./github-projection-writer";

const { invalidateBranchStatusChecksForHeadChangeMock } = vi.hoisted(() => ({
  invalidateBranchStatusChecksForHeadChangeMock: vi.fn(),
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

vi.mock("@/lib/integration-encryption", () => ({
  decryptIntegrationToken: vi.fn(),
}));

const dbMock = {
  branchDetail: {
    update: vi.fn(),
  },
  pullRequestDetail: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
  },
  repositoryDefaultObservationReceipt: { createMany: vi.fn() },
};

describe("writeExistingBranchPullRequestProjection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.pullRequestDetail.findFirst.mockResolvedValue(null);
    dbMock.pullRequestDetail.update.mockResolvedValue({});
    dbMock.pullRequestDetail.updateMany.mockResolvedValue({ count: 0 });
    dbMock.pullRequestDetail.upsert.mockResolvedValue({ id: "pr-detail-1" });
    dbMock.branchDetail.update.mockResolvedValue({});
    invalidateBranchStatusChecksForHeadChangeMock.mockResolvedValue(undefined);
  });

  it("writes the full branch projection and current PR pointer", async () => {
    await writeExistingBranchPullRequestProjection(
      transactionClient(),
      {
        branchArtifactId: "branch-artifact-1",
        currentHeadSha: "old-sha",
      },
      pullRequestInput()
    );

    expect(dbMock.branchDetail.update).toHaveBeenCalledWith({
      where: { artifactId: "branch-artifact-1" },
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
        branchArtifactId: "branch-artifact-1",
        isCurrent: true,
        id: { not: "pr-detail-1" },
      },
      data: { isCurrent: false },
    });
    expect(dbMock.branchDetail.update).toHaveBeenCalledWith({
      where: { artifactId: "branch-artifact-1" },
      data: { currentPullRequestDetailId: "pr-detail-1" },
    });
  });

  it("can update only the PR detail and branch pointer for synchronize ownership", async () => {
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

    expect(dbMock.pullRequestDetail.update).toHaveBeenCalledWith({
      where: { id: "pr-detail-1" },
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
    expect(dbMock.branchDetail.update).toHaveBeenCalledTimes(1);
    expect(dbMock.branchDetail.update).toHaveBeenCalledWith({
      where: { artifactId: "branch-artifact-1" },
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
    const userTokenOctokit = { kind: "user-token-octokit" };
    withDbMock.mockImplementation((callback) => callback(tx as never));
    vi.mocked(decryptIntegrationToken).mockResolvedValue("decrypted-token");
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
    } finally {
      withDbMock.mockReset();
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
    dbMock.pullRequestDetail.findUnique.mockResolvedValue({
      id: "pr-detail-1",
    });
    dbMock.pullRequestDetail.findFirst.mockResolvedValue(
      emptyStoredAuthority()
    );
    dbMock.pullRequestDetail.updateMany.mockResolvedValue({ count: 1 });
    const withDbMock = vi.mocked(withDb) as ReturnType<typeof vi.fn>;
    withDbMock.mockImplementation((callback) => callback(transactionClient()));

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

describe("PullRequestDetail projection payloads", () => {
  it("leaves the exact PR-head pair to the authority compare-and-set", () => {
    const input = {
      ...pullRequestInput(),
      headRefOid: "exact-head-oid",
    };

    const create = buildPullRequestDetailCreate(input);
    const update = buildPullRequestDetailUpdate(input);

    expect(create).not.toHaveProperty("headRefName");
    expect(create).not.toHaveProperty("headRefOid");
    expect(update).not.toHaveProperty("headRefName");
    expect(update).not.toHaveProperty("headRefOid");
  });
});

describe("adoptRepolessPullRequestDetail (FEA-3212)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.pullRequestDetail.findFirst.mockResolvedValue(null);
    dbMock.pullRequestDetail.update.mockResolvedValue({});
    dbMock.pullRequestDetail.updateMany.mockResolvedValue({ count: 0 });
  });

  it("adopts exactly one row when two githubId=null rows share (branchArtifactId, number), avoiding a P2002 stamp on both", async () => {
    // Two repo-less rows for the same branch+number both have githubId=null
    // (writer-discipline dedup is not a DB constraint). findFirst returns the
    // single deterministic target; only that row is stamped.
    dbMock.pullRequestDetail.findFirst.mockResolvedValue({ id: "pr-row-a" });
    dbMock.pullRequestDetail.updateMany.mockResolvedValue({ count: 1 });

    await adoptRepolessPullRequestDetail(transactionClient(), {
      branchArtifactId: "branch-artifact-1",
      number: 123,
      repositoryId: "repo-1",
      githubId: "github-pr-123",
    });

    expect(dbMock.pullRequestDetail.findFirst).toHaveBeenCalledWith({
      where: {
        branchArtifactId: "branch-artifact-1",
        number: 123,
        githubId: null,
      },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    // Atomic compare-and-set scoped to the single chosen id: updateMany where
    // { id, githubId: null } — never a broad { githubId: null } across many rows
    // (which would stamp the same githubId onto both and hit P2002 on
    // github_id), and never a plain update-by-id (which loses the null re-check
    // guard against a concurrent writer stamping the row first).
    expect(dbMock.pullRequestDetail.update).not.toHaveBeenCalled();
    expect(dbMock.pullRequestDetail.updateMany).toHaveBeenCalledTimes(1);
    expect(dbMock.pullRequestDetail.updateMany).toHaveBeenCalledWith({
      where: { id: "pr-row-a", githubId: null },
      data: { repositoryId: "repo-1", githubId: "github-pr-123" },
    });
  });

  it("compare-and-set is a no-op when a concurrent writer already adopted the chosen row (count 0, no clobber)", async () => {
    // findFirst picked pr-row-a while githubId was still null, but another
    // writer stamped it before this write lands. The scoped updateMany matches
    // zero rows (count 0) — no error, no clobber of the winner's githubId.
    dbMock.pullRequestDetail.findFirst.mockResolvedValue({ id: "pr-row-a" });
    dbMock.pullRequestDetail.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      adoptRepolessPullRequestDetail(transactionClient(), {
        branchArtifactId: "branch-artifact-1",
        number: 123,
        repositoryId: "repo-1",
        githubId: "github-pr-123",
      })
    ).resolves.toBeUndefined();

    expect(dbMock.pullRequestDetail.updateMany).toHaveBeenCalledWith({
      where: { id: "pr-row-a", githubId: null },
      data: { repositoryId: "repo-1", githubId: "github-pr-123" },
    });
    expect(dbMock.pullRequestDetail.update).not.toHaveBeenCalled();
  });

  it("is a no-op when no repo-less row matches", async () => {
    dbMock.pullRequestDetail.findFirst.mockResolvedValue(null);

    await adoptRepolessPullRequestDetail(transactionClient(), {
      branchArtifactId: "branch-artifact-1",
      number: 123,
      repositoryId: "repo-1",
      githubId: "github-pr-123",
    });

    expect(dbMock.pullRequestDetail.update).not.toHaveBeenCalled();
    expect(dbMock.pullRequestDetail.updateMany).not.toHaveBeenCalled();
  });
});

function pullRequestInput() {
  return {
    organizationId: "org-1",
    repositoryId: "repo-1",
    githubId: "github-pr-123",
    number: 123,
    title: "Shared writer",
    body: "Body",
    htmlUrl: "https://github.com/acme/app/pull/123",
    headBranch: "feature/shared",
    baseBranch: "main",
    headSha: "new-sha",
    prState: GitHubPRState.Open,
    isDraft: false,
    additions: 44,
    deletions: 6,
    changedFiles: 3,
    closedAt: null,
    mergedAt: null,
    mergeCommitSha: null,
  };
}

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
        branch: {
          repositoryId: "repo-1",
          currentPullRequestDetail: {
            githubId: "github-pr-1",
            id: "pr-detail-1",
            number: 123,
          },
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
        accessTokenEncrypted: "encrypted-token",
        revokedAt: null,
        tokenExpiresAt: null,
        scopes: ["repo"],
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    pullRequestDetail: {
      findFirst: vi.fn().mockResolvedValue(emptyStoredAuthority()),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    repositoryDefaultObservationReceipt: { createMany: vi.fn() },
  };
}

function branchServiceTransaction() {
  const pullRequestDetailFindFirst = vi
    .fn()
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(emptyStoredAuthority());
  return {
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
    },
    pullRequestDetail: {
      findFirst: pullRequestDetailFindFirst,
      upsert: vi.fn().mockResolvedValue({ id: "pr-detail-1" }),
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
