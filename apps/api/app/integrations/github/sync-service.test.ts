import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule({
    ArtifactType: {
      BRANCH: "BRANCH",
      SESSION: "SESSION",
    },
    GitHubInstallationStatus: {
      ACTIVE: "ACTIVE",
    },
  });
});

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

vi.mock("@repo/observability/log", () => ({
  log: {
    warn: vi.fn(),
  },
}));

vi.mock("@/lib/integration-encryption", () => ({
  decryptIntegrationToken: vi.fn(),
}));

import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
  GitHubSyncResultReason,
} from "@repo/api/src/types/github-read-model";
import {
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultReason,
  RepositoryDefaultSource,
} from "@repo/api/src/types/repository-default-identity";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import {
  GitHubProviderResultStatus,
  type GitHubSinglePullRequestResult,
  GitHubUserTokenProviderResultStatus,
  getSinglePullRequestWithProviderResult,
} from "@repo/github";
import { getUserTokenOctokit } from "@repo/github/user-token-auth";
import { log } from "@repo/observability/log";
import { decryptIntegrationToken } from "@/lib/integration-encryption";
import { mockWithDbCall } from "../../../__tests__/utils/db-helpers";
import {
  GitHubServerSyncReason,
  GitHubServerSyncStatus,
  githubServerSyncService,
} from "./sync-service";

const organizationId = "org-1";
const branchArtifactId = "branch-1";
const actorUserId = "019fed13-b752-77c3-bf22-0a6c655d4a38";
const now = new Date("2026-07-06T09:00:00.000Z");
// Marker object the mocked user-token factory returns; the unified single-PR
// read must receive it as its first argument (PLN-1525 step 4).
const userTokenOctokit = { kind: "user-token-octokit" };
const mockGetUserTokenOctokit = getUserTokenOctokit as ReturnType<typeof vi.fn>;

describe("githubServerSyncService", () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
    mockWithDbCall(mockDb);
    mockDb.artifact.findFirst.mockResolvedValue(makeBranchTarget());
    mockDb.artifactLink.findFirst.mockResolvedValue(makeSessionPrLink());
    mockDb.gitHubUserConnection.findUnique.mockResolvedValue(
      makeUserConnection()
    );
    mockDb.gitHubUserConnection.updateMany.mockResolvedValue({ count: 1 });
    mockDb.pullRequestDetail.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    mockDb.branchDetail.updateMany.mockResolvedValue({ count: 1 });
    vi.mocked(decryptIntegrationToken).mockResolvedValue("decrypted-token");
    mockGetUserTokenOctokit.mockReturnValue(userTokenOctokit);
    vi.mocked(getSinglePullRequestWithProviderResult).mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: makeProviderPullRequest(),
    });
  });

  it("does not use user OAuth as overflow for App-covered repositories", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchTarget({ removedAt: null })
    );

    const result =
      await githubServerSyncService.refreshTombstonedBranchPullRequest({
        actorUserId,
        branchArtifactId,
        organizationId,
        now,
      });

    expect(result).toEqual({
      status: GitHubServerSyncStatus.NotApplicable,
      reason: GitHubServerSyncReason.NoTombstonedRepository,
    });
    expect(mockDb.gitHubUserConnection.findUnique).not.toHaveBeenCalled();
    expect(decryptIntegrationToken).not.toHaveBeenCalled();
    expect(getSinglePullRequestWithProviderResult).not.toHaveBeenCalled();
  });

  it("does not use user OAuth for inactive repositories that are not tombstoned", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchTarget({
        installationStatus: "SUSPENDED",
        removedAt: null,
      })
    );

    const result =
      await githubServerSyncService.refreshTombstonedBranchPullRequest({
        actorUserId,
        branchArtifactId,
        organizationId,
        now,
      });

    expect(result).toEqual({
      status: GitHubServerSyncStatus.Failed,
      reason: GitHubSyncResultReason.NoActiveRepository,
    });
    expect(mockDb.gitHubUserConnection.findUnique).not.toHaveBeenCalled();
    expect(decryptIntegrationToken).not.toHaveBeenCalled();
    expect(getSinglePullRequestWithProviderResult).not.toHaveBeenCalled();
  });

  it("denies cross-user user-token sync without an owned session PR reference", async () => {
    mockDb.artifactLink.findFirst.mockResolvedValue(null);

    const result =
      await githubServerSyncService.refreshTombstonedBranchPullRequest({
        actorUserId,
        branchArtifactId,
        organizationId,
        now,
      });

    expect(result).toEqual({
      status: GitHubServerSyncStatus.Failed,
      reason: GitHubSyncResultReason.NoEligibleSessionReference,
    });
    expect(mockDb.artifactLink.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: [
            {
              metadata: {
                path: ["linkKind"],
                equals: SessionArtifactLinkKind.SessionPr,
              },
            },
            {
              metadata: {
                path: ["repositoryFullName"],
                equals: "closedloop-ai/symphony-alpha",
              },
            },
            {
              metadata: {
                path: ["prNumber"],
                equals: 2294,
              },
            },
          ],
          source: expect.objectContaining({
            session: { is: { userId: actorUserId } },
          }),
        }),
      })
    );
    expect(mockDb.gitHubUserConnection.findUnique).not.toHaveBeenCalled();
    expect(decryptIntegrationToken).not.toHaveBeenCalled();
    expect(getSinglePullRequestWithProviderResult).not.toHaveBeenCalled();
    expect(mockDb.branchDetail.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fetchCredentialOwnerId: actorUserId,
          fetchCredentialType: GitHubFetchCredentialType.UserOAuth,
          fetchMechanism: GitHubFetchMechanism.Rest,
          fetchResultReason: GitHubSyncResultReason.NoEligibleSessionReference,
          fetchTrigger: GitHubFetchTrigger.UserAction,
        }),
      })
    );
  });

  it.each([
    {
      name: "missing",
      connection: null,
      reason: GitHubSyncResultReason.NoCredential,
    },
    {
      name: "revoked",
      connection: makeUserConnection({ revokedAt: now }),
      reason: GitHubSyncResultReason.CredentialRevoked,
    },
    {
      name: "expired",
      connection: makeUserConnection({
        tokenExpiresAt: new Date("2026-07-06T08:59:59.000Z"),
      }),
      reason: GitHubSyncResultReason.CredentialExpired,
    },
    {
      name: "insufficient scope",
      connection: makeUserConnection({ scopes: [] }),
      reason: GitHubSyncResultReason.CredentialInsufficientScope,
    },
  ])("stops cleanly for $name OAuth credentials", async ({
    connection,
    reason,
  }) => {
    mockDb.gitHubUserConnection.findUnique.mockResolvedValue(connection);

    const result =
      await githubServerSyncService.refreshTombstonedBranchPullRequest({
        actorUserId,
        branchArtifactId,
        organizationId,
        now,
      });

    expect(result).toEqual({
      status: GitHubServerSyncStatus.Failed,
      reason,
    });
    expect(decryptIntegrationToken).not.toHaveBeenCalled();
    expect(getSinglePullRequestWithProviderResult).not.toHaveBeenCalled();
    expect(mockDb.pullRequestDetail.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({
          lastRefreshAttemptAt: now,
        }),
      })
    );
    expect(mockDb.pullRequestDetail.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ fetchResultReason: reason }),
      })
    );
  });

  it.each([
    {
      providerStatus:
        GitHubUserTokenProviderResultStatus.CredentialUnauthorized,
      reason: GitHubSyncResultReason.CredentialRevoked,
    },
    {
      providerStatus:
        GitHubUserTokenProviderResultStatus.CredentialInsufficientScope,
      reason: GitHubSyncResultReason.CredentialInsufficientScope,
    },
  ])("stamps $reason when GitHub rejects the live user token", async ({
    providerStatus,
    reason,
  }) => {
    vi.mocked(getSinglePullRequestWithProviderResult).mockResolvedValueOnce({
      status: providerStatus,
    });

    const result =
      await githubServerSyncService.refreshTombstonedBranchPullRequest({
        actorUserId,
        branchArtifactId,
        organizationId,
        now,
      });

    expect(result).toEqual({
      status: GitHubServerSyncStatus.Failed,
      reason,
    });
    expect(mockDb.pullRequestDetail.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          repository: { removedAt: { not: null } },
        }),
      })
    );
    expect(mockDb.pullRequestDetail.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ fetchResultReason: reason }),
      })
    );
  });

  it("refreshes a tombstoned linked PR with user OAuth provenance", async () => {
    const result =
      await githubServerSyncService.refreshTombstonedBranchPullRequest({
        actorUserId,
        branchArtifactId,
        organizationId,
        now,
      });

    expect(result).toEqual({
      status: GitHubServerSyncStatus.Refreshed,
      reason: GitHubSyncResultReason.Success,
    });
    expect(mockGetUserTokenOctokit).toHaveBeenCalledWith("decrypted-token");
    expect(getSinglePullRequestWithProviderResult).toHaveBeenCalledWith(
      userTokenOctokit,
      "closedloop-ai",
      "symphony-alpha",
      2294,
      {
        credentialType: GitHubFetchCredentialType.UserOAuth,
        credentialOwnerId: actorUserId,
        observationKey: expect.any(String),
        observedAt: now.toISOString(),
        trigger: GitHubFetchTrigger.UserAction,
      }
    );
    expect(mockDb.gitHubUserConnection.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { lastUsedAt: now },
        where: expect.objectContaining({
          id: "connection-1",
          organizationId,
          userId: actorUserId,
          revokedAt: null,
        }),
      })
    );
    expect(mockDb.pullRequestDetail.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          repository: { removedAt: { not: null } },
          currentForBranches: {
            some: expect.objectContaining({
              repository: { removedAt: { not: null } },
            }),
          },
        }),
      })
    );
    expect(mockDb.pullRequestDetail.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fetchCredentialOwnerId: actorUserId,
          fetchCredentialType: GitHubFetchCredentialType.UserOAuth,
          fetchMechanism: GitHubFetchMechanism.Rest,
          fetchResultReason: GitHubSyncResultReason.Success,
          fetchTrigger: GitHubFetchTrigger.UserAction,
          isDraft: false,
          additions: 33,
          deletions: 7,
          changedFiles: 4,
          lastVerifiedAt: now,
          prState: "MERGED",
        }),
      })
    );
    const branchUpdate = mockDb.branchDetail.updateMany.mock.calls.at(-1)?.[0];
    expect(branchUpdate?.data).toMatchObject({
      fetchCredentialOwnerId: actorUserId,
      fetchResultReason: GitHubSyncResultReason.Success,
      headSha: "head-sha",
      headShaObservedAt: now,
    });
    expect(branchUpdate?.data).not.toHaveProperty("lastActivityAt");
  });

  it("rejects a refreshed PR when the stable GitHub id changed", async () => {
    vi.mocked(getSinglePullRequestWithProviderResult).mockResolvedValueOnce({
      status: GitHubProviderResultStatus.Success,
      value: makeProviderPullRequest({ githubId: "different-pr-id" }),
    });

    const result =
      await githubServerSyncService.refreshTombstonedBranchPullRequest({
        actorUserId,
        branchArtifactId,
        organizationId,
        now,
      });

    expect(result).toEqual({
      status: GitHubServerSyncStatus.Failed,
      reason: GitHubSyncResultReason.Unsupported,
    });
    expect(mockDb.pullRequestDetail.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fetchResultReason: GitHubSyncResultReason.Unsupported,
        }),
      })
    );
    expect(mockDb.branchDetail.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fetchResultReason: GitHubSyncResultReason.Unsupported,
        }),
      })
    );
  });

  it("does not bump branch activity for unchanged open PR refreshes", async () => {
    vi.mocked(getSinglePullRequestWithProviderResult).mockResolvedValueOnce({
      status: GitHubProviderResultStatus.Success,
      value: makeProviderPullRequest({
        closedAt: null,
        mergedAt: null,
        state: "OPEN",
      }),
    });

    const result =
      await githubServerSyncService.refreshTombstonedBranchPullRequest({
        actorUserId,
        branchArtifactId,
        organizationId,
        now,
      });

    expect(result).toEqual({
      status: GitHubServerSyncStatus.Refreshed,
      reason: GitHubSyncResultReason.Success,
    });
    const branchUpdate = mockDb.branchDetail.updateMany.mock.calls.at(-1)?.[0];
    expect(branchUpdate?.data).toMatchObject({
      fetchCredentialOwnerId: actorUserId,
      fetchResultReason: GitHubSyncResultReason.Success,
      headSha: "head-sha",
      headShaObservedAt: now,
    });
    expect(branchUpdate?.data).not.toHaveProperty("lastActivityAt");
  });

  it("warns and returns retryable when GitHub is unavailable during refresh", async () => {
    mockDb.pullRequestDetail.findFirst.mockResolvedValue(
      storedPullRequestAuthority()
    );
    vi.mocked(getSinglePullRequestWithProviderResult).mockResolvedValueOnce({
      status: GitHubProviderResultStatus.ProviderUnavailable,
    });

    const result =
      await githubServerSyncService.refreshTombstonedBranchPullRequest({
        actorUserId,
        branchArtifactId,
        organizationId,
        now,
      });

    expect(result).toEqual({
      status: GitHubServerSyncStatus.Retryable,
      reason: GitHubServerSyncReason.ProviderUnavailable,
    });
    expect(log.warn).toHaveBeenCalledWith(
      "[github/sync] Tombstoned PR refresh failed",
      expect.objectContaining({
        reason: GitHubSyncResultReason.ProviderUnavailable,
        providerStatus: GitHubProviderResultStatus.ProviderUnavailable,
        branchArtifactId,
        organizationId,
      })
    );
    expect(mockDb.pullRequestDetail.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          headRepositoryDefaultBranchAvailability:
            RepositoryDefaultAvailability.Stale,
          headRepositoryDefaultBranchName: "trunk",
          headRepositoryDefaultBranchReason:
            RepositoryDefaultReason.ProviderError,
          headRepositoryDefaultBranchSource:
            RepositoryDefaultSource.PullRequestRest,
        }),
      })
    );
  });

  it("fails refresh when branch provenance settlement loses its guarded write", async () => {
    mockDb.branchDetail.updateMany.mockResolvedValueOnce({ count: 0 });

    const result =
      await githubServerSyncService.refreshTombstonedBranchPullRequest({
        actorUserId,
        branchArtifactId,
        organizationId,
        now,
      });

    expect(result).toEqual({
      status: GitHubServerSyncStatus.Failed,
      reason: GitHubServerSyncReason.GuardedWriteFailed,
    });
    expect(mockDb.branchDetail.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          repository: { removedAt: { not: null } },
        }),
      })
    );
    expect(log.warn).toHaveBeenCalledWith(
      "[github/sync] Tombstoned PR refresh failed",
      expect.objectContaining({
        reason: GitHubServerSyncReason.GuardedWriteFailed,
        branchArtifactId,
        organizationId,
      })
    );
  });
});

function createMockDb() {
  return {
    artifact: {
      findFirst: vi.fn(),
    },
    artifactLink: {
      findFirst: vi.fn(),
    },
    branchDetail: {
      updateMany: vi.fn(),
    },
    gitHubUserConnection: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    pullRequestDetail: {
      findFirst: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn(),
    },
    repositoryDefaultObservationReceipt: {
      createMany: vi.fn(),
    },
  };
}

function makeBranchTarget(
  overrides: {
    currentPullRequestDetail?: {
      githubId: string;
      id: string;
      number: number;
    } | null;
    installationStatus?: string;
    private?: boolean;
    removedAt?: Date | null;
  } = {}
) {
  return {
    id: branchArtifactId,
    organizationId,
    branch: {
      repositoryId: "repo-1",
      currentPullRequestDetail: overrides.currentPullRequestDetail ?? {
        githubId: "github-pr-1",
        id: "pr-detail-1",
        number: 2294,
      },
      repository: {
        id: "repo-1",
        fullName: "closedloop-ai/symphony-alpha",
        owner: "closedloop-ai",
        name: "symphony-alpha",
        private: overrides.private ?? true,
        removedAt: resolveRemovedAt(overrides.removedAt),
        installation: {
          organizationId,
          status: overrides.installationStatus ?? "ACTIVE",
        },
      },
    },
  };
}

function makeSessionPrLink() {
  return {
    metadata: {
      linkKind: SessionArtifactLinkKind.SessionPr,
      repositoryFullName: "closedloop-ai/symphony-alpha",
      prNumber: 2294,
    },
  };
}

function makeUserConnection(
  overrides: {
    revokedAt?: Date | null;
    scopes?: string[];
    tokenExpiresAt?: Date | null;
  } = {}
) {
  return {
    id: "connection-1",
    accessTokenEncrypted: "encrypted-token",
    revokedAt: overrides.revokedAt ?? null,
    tokenExpiresAt: overrides.tokenExpiresAt ?? null,
    scopes: overrides.scopes ?? ["repo"],
  };
}

function makeProviderPullRequest(
  overrides: Partial<GitHubSinglePullRequestResult> = {}
): GitHubSinglePullRequestResult {
  return {
    githubId: "github-pr-1",
    number: 2294,
    title: "FEA-2605",
    htmlUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/2294",
    headBranch: "feat/fea-2605-github-provenance",
    baseBranch: "main",
    state: "MERGED",
    createdAt: "2026-07-06T09:00:00.000Z",
    mergedAt: "2026-07-06T10:00:00.000Z",
    closedAt: "2026-07-06T10:00:00.000Z",
    authorLogin: "shafty023",
    isDraft: false,
    headSha: "head-sha",
    baseSha: "base-sha",
    mergeCommitSha: "merge-sha",
    additions: 33,
    deletions: 7,
    changedFiles: 4,
    ...overrides,
  };
}

function resolveRemovedAt(value: Date | null | undefined): Date | null {
  if (value === undefined) {
    return new Date("2026-07-06T08:30:00.000Z");
  }
  return value;
}

function storedPullRequestAuthority() {
  return {
    headRepositoryGithubId: "5826",
    headRepositoryFullName: "fork-owner/repo",
    headRepositoryDefaultBranchName: "trunk",
    headRepositoryDefaultBranchAvailability:
      RepositoryDefaultAvailability.Available,
    headRepositoryDefaultBranchCompleteness:
      RepositoryDefaultCompleteness.Complete,
    headRepositoryDefaultBranchReason: null,
    headRepositoryDefaultBranchSource: RepositoryDefaultSource.PullRequestRest,
    headRepositoryDefaultBranchMechanism: GitHubFetchMechanism.Rest,
    headRepositoryDefaultBranchTrigger: GitHubFetchTrigger.UserAction,
    headRepositoryDefaultBranchCredentialType:
      GitHubFetchCredentialType.UserOAuth,
    headRepositoryDefaultBranchCredentialOwnerId: actorUserId,
    headRepositoryDefaultBranchObservationKey: "previous-attempt",
    headRepositoryDefaultBranchObservedAt: new Date("2026-07-06T08:00:00.000Z"),
    headRepositoryDefaultBranchEventAt: null,
  };
}
