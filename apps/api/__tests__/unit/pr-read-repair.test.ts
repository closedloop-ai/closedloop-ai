/**
 * The PR read-repair pass itself, driven through the captured waitUntil
 * promise: repository/installation resolution, the client it resolves, the
 * FEA-2732 relink, lifecycle stamping, and the backfill of a missing detail
 * row.
 *
 * Which rows earn a repair in the first place is covered by
 * pr-read-repair-eligibility.test.ts.
 */

import {
  GitHubFetchCredentialType,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Module-level mocks ---

const { mockGetInstallationOctokit, mockOctokit } = vi.hoisted(() => ({
  mockGetInstallationOctokit: vi.fn(),
  mockOctokit: { marker: "installation-octokit" },
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn(),
}));

vi.mock("@repo/github/installation-auth", () => ({
  // Spy wrapper (not a bare vi.fn implementation) so restore/reset passes can
  // never strip the marker client the SUT threads into @repo/github reads.
  // Mint-failure tests inject a one-shot rejection through the spy; any
  // non-undefined spy result wins over the resolved marker client fallback.
  getInstallationOctokit: (installationId: string) =>
    mockGetInstallationOctokit(installationId) ?? Promise.resolve(mockOctokit),
}));

vi.mock("@repo/database", () => ({
  ArtifactSubtype: {
    PRD: "PRD",
    IMPLEMENTATION_PLAN: "IMPLEMENTATION_PLAN",
    TEMPLATE: "TEMPLATE",
    FEATURE: "FEATURE",
  },
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    BRANCH: "BRANCH",
    DEPLOYMENT: "DEPLOYMENT",
  },
  GitHubInstallationStatus: {
    PENDING_CLAIM: "PENDING_CLAIM",
    ACTIVE: "ACTIVE",
    SUSPENDED: "SUSPENDED",
  },
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@repo/github", () => {
  const GitHubProviderResultStatus = {
    Success: "success",
    ProviderRateLimit: "provider_rate_limit",
    ProviderUnavailable: "provider_unavailable",
  };
  const getSinglePullRequest = vi.fn();
  return {
    getSinglePullRequest,
    getSinglePullRequestWithProviderResult: async (...args: unknown[]) => {
      const value = await getSinglePullRequest(...args);
      return value
        ? { status: GitHubProviderResultStatus.Success, value }
        : { status: GitHubProviderResultStatus.ProviderUnavailable };
    },
    GitHubProviderResultStatus,
    // Real classifier so the mint-failure test pins the production
    // rate-limit-vs-unavailable classification.
  };
});

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { GitHubPRState } from "@repo/api/src/types/github";
import { GitHubInstallationStatus, withDb } from "@repo/database";
import { getSinglePullRequest } from "@repo/github";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import {
  type PrReadRepairInput,
  schedulePrReadRepair,
} from "@/lib/pr-read-repair";
import {
  makePrReadRepairInput as makeInput,
  PR_READ_REPAIR_ORG_ID as ORG_ID,
} from "../utils/pr-read-repair-fixtures";

const mockWaitUntil = vi.mocked(waitUntil);
const mockWithDb = vi.mocked(withDb) as unknown as ReturnType<typeof vi.fn> & {
  tx: ReturnType<typeof vi.fn>;
};
const mockGetSinglePullRequest = vi.mocked(getSinglePullRequest);
const mockLog = vi.mocked(log);

// ---------------------------------------------------------------------------
// repairSinglePrLink — repair logic (invoked via captured waitUntil promise)
// ---------------------------------------------------------------------------

/** Run the scheduled repair and await the captured waitUntil promise. */
async function runRepair(inputs: PrReadRepairInput[]): Promise<void> {
  schedulePrReadRepair(inputs, ORG_ID);
  const capturedPromise = mockWaitUntil.mock.calls[0]?.[0] as
    | Promise<void>
    | undefined;
  if (capturedPromise) {
    await capturedPromise;
  }
}

function makeFreshPr(
  overrides: Partial<{
    githubId: string;
    number: number;
    title: string;
    state: GitHubPRState;
    createdAt: string | null;
    mergedAt: string | null;
    closedAt: string | null;
    authorLogin: string | null;
    isDraft: boolean;
    headSha: string;
    baseSha: string;
    mergeCommitSha: string | null;
  }> = {}
) {
  return {
    githubId: "gh-pr-new",
    number: 42,
    title: "New PR",
    htmlUrl: "https://github.com/acme/my-repo/pull/42",
    headBranch: "feature-x",
    baseBranch: "main",
    state: GitHubPRState.Open,
    createdAt: null,
    mergedAt: null,
    closedAt: null,
    authorLogin: null,
    isDraft: false,
    headSha: "abc123",
    baseSha: "def456",
    mergeCommitSha: null,
    ...overrides,
  };
}

describe("repairSinglePrLink — stamp + parse guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithDb.tx = vi.fn();
  });

  it("stamps lastRefreshAttemptAt before calling GitHub API", async () => {
    const input = makeInput({
      prState: GitHubPRState.Open,
      lastVerifiedAt: null,
    });
    const mockDetailUpdate = vi.fn().mockResolvedValue({});
    const mockExistingDetailFindFirst = vi.fn().mockResolvedValue({
      id: "detail-1",
      repositoryId: "repo-uuid-99",
    });

    // Call 1: resolveRepositoryId → valid
    mockWithDb.mockImplementationOnce((cb: (db: unknown) => unknown) =>
      cb({
        gitHubInstallationRepository: {
          findFirst: vi.fn().mockResolvedValue({
            id: "repo-uuid-99",
            removedAt: null,
            installation: {
              installationId: "install-99",
              status: GitHubInstallationStatus.ACTIVE,
            },
          }),
        },
      })
    );
    // Call 2: existing detail lookup
    mockWithDb.mockImplementationOnce((cb: (db: unknown) => unknown) =>
      cb({
        pullRequestDetail: {
          findFirst: mockExistingDetailFindFirst,
        },
      })
    );
    // Call 3: shared lifecycle helper stamps before calling GitHub
    mockWithDb.mockImplementationOnce((cb: (db: unknown) => unknown) =>
      cb({
        pullRequestDetail: {
          updateMany: mockDetailUpdate.mockResolvedValue({ count: 1 }),
        },
      })
    );
    mockGetSinglePullRequest.mockResolvedValueOnce(null);

    await runRepair([input]);

    expect(mockExistingDetailFindFirst).toHaveBeenCalledWith({
      where: {
        OR: [
          { artifactId: input.id },
          { branchArtifactId: input.id, isCurrent: true },
        ],
        branchArtifact: { organizationId: input.organizationId },
      },
      select: { id: true, repositoryId: true },
    });
    expect(mockDetailUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "detail-1",
          branchArtifactId: input.id,
          repositoryId: "repo-uuid-99",
          branchArtifact: { organizationId: input.organizationId },
          repository: {
            removedAt: null,
            installation: {
              organizationId: input.organizationId,
              status: GitHubInstallationStatus.ACTIVE,
            },
          },
        },
        data: expect.objectContaining({
          lastRefreshAttemptAt: expect.any(Date),
        }),
      })
    );
  });

  it("skips the input when the PR URL cannot be parsed (no GitHub match)", async () => {
    const input = makeInput({
      externalUrl: "https://not-github.com/some/page",
    });

    await runRepair([input]);

    // Should not attempt to stamp or call GitHub
    expect(mockWithDb).not.toHaveBeenCalled();
    expect(mockGetSinglePullRequest).not.toHaveBeenCalled();
  });

  it("skips the GitHub API call when no installationId can be resolved", async () => {
    const input = makeInput();
    const mockFallbackDetailFindFirst = vi.fn().mockResolvedValue(null);

    // Call 1: resolveRepositoryId → null
    mockWithDb.mockImplementationOnce((cb: (db: unknown) => unknown) =>
      cb({
        gitHubInstallationRepository: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      })
    );
    // Call 2: resolveInstallationId primary → no detail
    mockWithDb.mockImplementationOnce((cb: (db: unknown) => unknown) =>
      cb({
        pullRequestDetail: { findFirst: mockFallbackDetailFindFirst },
      })
    );
    // Call 3: resolveInstallationId fallback → 0 installations
    mockWithDb.mockImplementationOnce((cb: (db: unknown) => unknown) =>
      cb({
        gitHubInstallation: { findMany: vi.fn().mockResolvedValue([]) },
      })
    );

    await runRepair([input]);

    expect(mockFallbackDetailFindFirst).toHaveBeenCalledWith({
      where: {
        OR: [{ artifactId: input.id }, { branchArtifactId: input.id }],
        branchArtifact: { organizationId: input.organizationId },
        repository: {
          installation: { organizationId: input.organizationId },
        },
      },
      select: { repositoryId: true },
    });
    expect(mockGetInstallationOctokit).not.toHaveBeenCalled();
    expect(mockGetSinglePullRequest).not.toHaveBeenCalled();
  });

  it("resolves fallback repository installation through the input organization", async () => {
    const input = makeInput();
    const mockFallbackDetailFindFirst = vi
      .fn()
      .mockResolvedValue({ repositoryId: "repo-uuid-99" });
    const mockScopedRepoFindFirst = vi.fn().mockResolvedValue({
      installation: { installationId: "install-99" },
    });
    const mockExistingDetailFindFirst = vi.fn().mockResolvedValue(null);

    // Call 1: resolveRepositoryId → no owner/repo match
    mockWithDb.mockImplementationOnce((cb: (db: unknown) => unknown) =>
      cb({
        gitHubInstallationRepository: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      })
    );
    // Call 2: resolveInstallationId primary → detail points to a repo
    mockWithDb.mockImplementationOnce((cb: (db: unknown) => unknown) =>
      cb({
        pullRequestDetail: { findFirst: mockFallbackDetailFindFirst },
      })
    );
    // Call 3: resolveInstallationId repository lookup must stay org-scoped
    mockWithDb.mockImplementationOnce((cb: (db: unknown) => unknown) =>
      cb({
        gitHubInstallationRepository: { findFirst: mockScopedRepoFindFirst },
      })
    );
    // Call 4: existing detail lookup misses, so the backfill path fetches.
    mockWithDb.mockImplementationOnce((cb: (db: unknown) => unknown) =>
      cb({ pullRequestDetail: { findFirst: mockExistingDetailFindFirst } })
    );
    mockGetSinglePullRequest.mockResolvedValueOnce(null);

    await runRepair([input]);

    expect(mockFallbackDetailFindFirst).toHaveBeenCalledWith({
      where: {
        OR: [{ artifactId: input.id }, { branchArtifactId: input.id }],
        branchArtifact: { organizationId: input.organizationId },
        repository: {
          installation: { organizationId: input.organizationId },
        },
      },
      select: { repositoryId: true },
    });
    expect(mockScopedRepoFindFirst).toHaveBeenCalledWith({
      where: {
        id: "repo-uuid-99",
        removedAt: null,
        installation: {
          organizationId: input.organizationId,
          status: GitHubInstallationStatus.ACTIVE,
        },
      },
      select: { installation: { select: { installationId: true } } },
    });
    expect(mockExistingDetailFindFirst).toHaveBeenCalledWith({
      where: {
        OR: [
          { artifactId: input.id },
          { branchArtifactId: input.id, isCurrent: true },
        ],
        branchArtifact: { organizationId: input.organizationId },
      },
      select: { id: true, repositoryId: true },
    });
  });

  it("does not fall back to another installation when owner/repo is tombstoned", async () => {
    const input = makeInput({
      externalUrl: "https://github.com/acme/tombstoned-repo/pull/42",
    });
    const mockRepoFindFirst = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "repo-uuid-tombstoned",
      });

    mockWithDb.mockImplementationOnce((cb: (db: unknown) => unknown) =>
      cb({
        gitHubInstallationRepository: {
          findFirst: mockRepoFindFirst,
        },
      })
    );

    await runRepair([input]);

    expect(mockRepoFindFirst).toHaveBeenNthCalledWith(1, {
      where: {
        fullName: "acme/tombstoned-repo",
        removedAt: null,
        installation: {
          organizationId: ORG_ID,
          status: GitHubInstallationStatus.ACTIVE,
        },
      },
      select: {
        id: true,
        installation: { select: { installationId: true } },
      },
    });
    expect(mockRepoFindFirst).toHaveBeenNthCalledWith(2, {
      where: {
        fullName: "acme/tombstoned-repo",
        installation: { organizationId: ORG_ID },
      },
      select: { id: true },
      orderBy: { updatedAt: "desc" },
    });
    expect(mockWithDb).toHaveBeenCalledTimes(1);
    expect(mockGetSinglePullRequest).not.toHaveBeenCalled();
    expect(mockWithDb.tx).not.toHaveBeenCalled();
  });

  it("prefers the active repository row when a tombstone shares the same fullName", async () => {
    const input = makeInput({
      externalUrl: "https://github.com/acme/restored-repo/pull/42",
    });
    const mockRepoFindFirst = vi.fn((query: { where?: { removedAt?: null } }) =>
      Promise.resolve(
        query.where?.removedAt === null
          ? {
              id: "repo-uuid-active",
              installation: { installationId: "install-active" },
            }
          : { id: "repo-uuid-tombstoned" }
      )
    );
    const mockExistingDetailFindFirst = vi.fn().mockResolvedValue(null);

    mockWithDb.mockImplementationOnce((cb: (db: unknown) => unknown) =>
      cb({
        gitHubInstallationRepository: {
          findFirst: mockRepoFindFirst,
        },
      })
    );
    mockWithDb.mockImplementationOnce((cb: (db: unknown) => unknown) =>
      cb({ pullRequestDetail: { findFirst: mockExistingDetailFindFirst } })
    );
    mockGetSinglePullRequest.mockResolvedValueOnce(null);

    await runRepair([input]);

    expect(mockRepoFindFirst).toHaveBeenCalledOnce();
    expect(mockRepoFindFirst).toHaveBeenCalledWith({
      where: {
        fullName: "acme/restored-repo",
        removedAt: null,
        installation: {
          organizationId: ORG_ID,
          status: GitHubInstallationStatus.ACTIVE,
        },
      },
      select: {
        id: true,
        installation: { select: { installationId: true } },
      },
    });
    expect(mockExistingDetailFindFirst).toHaveBeenCalled();
    expect(mockGetInstallationOctokit).toHaveBeenCalledTimes(1);
    expect(mockGetInstallationOctokit).toHaveBeenCalledWith("install-active");
    expect(mockGetSinglePullRequest).toHaveBeenCalledWith(
      mockOctokit,
      "acme",
      "restored-repo",
      42,
      expect.objectContaining({
        credentialType: GitHubFetchCredentialType.GitHubApp,
        observationKey: expect.any(String),
        trigger: GitHubFetchTrigger.Backfill,
      })
    );
  });

  it("relinks an existing tombstoned PR detail to the restored active repository before refresh", async () => {
    const input = makeInput({
      externalUrl: "https://github.com/acme/restored-repo/pull/42",
    });
    const mockRepoFindFirst = vi.fn((query: { where?: { removedAt?: null } }) =>
      Promise.resolve(
        query.where?.removedAt === null
          ? {
              id: "repo-uuid-active",
              installation: { installationId: "install-active" },
            }
          : { id: "repo-uuid-tombstoned" }
      )
    );
    const mockExistingDetailFindFirst = vi.fn().mockResolvedValue({
      id: "detail-1",
      repositoryId: "repo-uuid-tombstoned",
    });
    const relinkTx = {
      branchDetail: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      pullRequestDetail: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const stampUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const refreshTx = {
      artifact: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      branchDetail: {
        findFirst: vi.fn().mockResolvedValue({ headSha: "abc123" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      branchStatusCheck: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      pullRequestDetail: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };

    mockWithDb.mockImplementationOnce((cb: (db: unknown) => unknown) =>
      cb({
        gitHubInstallationRepository: { findFirst: mockRepoFindFirst },
      })
    );
    mockWithDb.mockImplementationOnce((cb: (db: unknown) => unknown) =>
      cb({ pullRequestDetail: { findFirst: mockExistingDetailFindFirst } })
    );
    mockWithDb.mockImplementationOnce((cb: (db: unknown) => unknown) =>
      cb({
        pullRequestDetail: {
          updateMany: stampUpdate,
        },
      })
    );
    mockWithDb.tx
      .mockImplementationOnce((cb: (tx: unknown) => unknown) => cb(relinkTx))
      .mockImplementationOnce((cb: (tx: unknown) => unknown) => cb(refreshTx));
    mockGetSinglePullRequest.mockResolvedValueOnce(makeFreshPr());

    await runRepair([input]);

    expect(relinkTx.branchDetail.updateMany).toHaveBeenCalledWith({
      where: {
        artifactId: input.id,
        repositoryId: "repo-uuid-tombstoned",
        artifact: { organizationId: input.organizationId },
      },
      data: { repositoryId: "repo-uuid-active" },
    });
    expect(relinkTx.pullRequestDetail.updateMany).toHaveBeenCalledWith({
      where: {
        id: "detail-1",
        repositoryId: "repo-uuid-tombstoned",
        branchArtifactId: input.id,
        branchArtifact: { organizationId: input.organizationId },
      },
      data: { repositoryId: "repo-uuid-active" },
    });
    expect(stampUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "detail-1",
          repositoryId: "repo-uuid-active",
        }),
      })
    );
    // One shared client per repaired link: minted once, then threaded through
    // the lifecycle-refresh fetch below.
    expect(mockGetInstallationOctokit).toHaveBeenCalledTimes(1);
    expect(mockGetInstallationOctokit).toHaveBeenCalledWith("install-active");
    expect(mockGetSinglePullRequest).toHaveBeenCalledWith(
      mockOctokit,
      "acme",
      "restored-repo",
      42,
      expect.objectContaining({
        credentialType: GitHubFetchCredentialType.GitHubApp,
        observationKey: expect.any(String),
        trigger: GitHubFetchTrigger.Backfill,
      })
    );
  });

  it("relinks and stamps the refresh attempt when the installation client mint fails", async () => {
    const input = makeInput({
      externalUrl: "https://github.com/acme/restored-repo/pull/42",
    });
    const mockRepoFindFirst = vi.fn((query: { where?: { removedAt?: null } }) =>
      Promise.resolve(
        query.where?.removedAt === null
          ? {
              id: "repo-uuid-active",
              installation: { installationId: "install-active" },
            }
          : { id: "repo-uuid-tombstoned" }
      )
    );
    const mockExistingDetailFindFirst = vi.fn().mockResolvedValue({
      id: "detail-1",
      repositoryId: "repo-uuid-tombstoned",
    });
    const relinkTx = {
      branchDetail: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      pullRequestDetail: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const stampUpdate = vi.fn().mockResolvedValue({ count: 1 });

    mockWithDb.mockImplementationOnce((cb: (db: unknown) => unknown) =>
      cb({
        gitHubInstallationRepository: { findFirst: mockRepoFindFirst },
      })
    );
    mockWithDb.mockImplementationOnce((cb: (db: unknown) => unknown) =>
      cb({ pullRequestDetail: { findFirst: mockExistingDetailFindFirst } })
    );
    mockWithDb.mockImplementationOnce((cb: (db: unknown) => unknown) =>
      cb({ pullRequestDetail: { updateMany: stampUpdate } })
    );
    mockWithDb.tx.mockImplementationOnce((cb: (tx: unknown) => unknown) =>
      cb(relinkTx)
    );
    mockGetInstallationOctokit.mockReturnValueOnce(
      Promise.reject(new Error("token exchange failed"))
    );

    await runRepair([input]);

    // The relink needs no GitHub call, so it still lands.
    expect(relinkTx.branchDetail.updateMany).toHaveBeenCalledWith({
      where: {
        artifactId: input.id,
        repositoryId: "repo-uuid-tombstoned",
        artifact: { organizationId: input.organizationId },
      },
      data: { repositoryId: "repo-uuid-active" },
    });
    // The attempt is stamped so the 1h debounce engages; without it every
    // later read would reschedule this same repair.
    expect(stampUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "detail-1",
          repositoryId: "repo-uuid-active",
        }),
        data: expect.objectContaining({
          lastRefreshAttemptAt: expect.any(Date),
        }),
      })
    );
    expect(mockGetSinglePullRequest).not.toHaveBeenCalled();
  });

  it("does not use the single-installation fallback for a tombstoned stored PR repository", async () => {
    const input = makeInput();

    // Call 1: active owner/repo lookup misses.
    mockWithDb.mockImplementationOnce((cb: (db: unknown) => unknown) =>
      cb({
        gitHubInstallationRepository: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      })
    );
    // Call 2: stored PR detail points at a repository id.
    mockWithDb.mockImplementationOnce((cb: (db: unknown) => unknown) =>
      cb({
        pullRequestDetail: {
          findFirst: vi.fn().mockResolvedValue({ repositoryId: "repo-dead" }),
        },
      })
    );
    // Call 3: active repository lookup rejects the tombstoned row.
    mockWithDb.mockImplementationOnce((cb: (db: unknown) => unknown) =>
      cb({
        gitHubInstallationRepository: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      })
    );

    await runRepair([input]);

    expect(mockWithDb).toHaveBeenCalledTimes(3);
    expect(mockGetInstallationOctokit).not.toHaveBeenCalled();
    expect(mockGetSinglePullRequest).not.toHaveBeenCalled();
    expect(mockWithDb.tx).not.toHaveBeenCalled();
  });

  it("skips update when getSinglePullRequest returns null", async () => {
    const input = makeInput();

    // Call 1: resolveRepositoryId → valid
    mockWithDb.mockImplementationOnce((cb: (db: unknown) => unknown) =>
      cb({
        gitHubInstallationRepository: {
          findFirst: vi.fn().mockResolvedValue({
            id: "repo-uuid-99",
            removedAt: null,
            installation: {
              installationId: "install-99",
              status: GitHubInstallationStatus.ACTIVE,
            },
          }),
        },
      })
    );
    // Call 2: existing detail lookup misses, so backfill path fetches once.
    mockWithDb.mockImplementationOnce((cb: (db: unknown) => unknown) =>
      cb({ pullRequestDetail: { findFirst: vi.fn().mockResolvedValue(null) } })
    );

    mockGetSinglePullRequest.mockResolvedValueOnce(null);

    await runRepair([input]);

    expect(mockWithDb.tx).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.stringContaining("PR provider read failed"),
      expect.any(Object)
    );
  });

  it("resolveRepositoryId queries by fullName scoped to org", async () => {
    const input = makeInput({
      externalUrl: "https://github.com/acme/target-repo/pull/7",
    });
    const mockRepoFindFirst = vi.fn().mockResolvedValue({
      id: "repo-uuid-target",
      removedAt: null,
      installation: {
        installationId: "install-target",
        status: GitHubInstallationStatus.ACTIVE,
      },
    });

    // Call 1: resolveRepositoryId
    mockWithDb.mockImplementationOnce((cb: (db: unknown) => unknown) =>
      cb({
        gitHubInstallationRepository: { findFirst: mockRepoFindFirst },
      })
    );
    // Call 2: existing detail lookup misses, so the backfill path fetches.
    mockWithDb.mockImplementationOnce((cb: (db: unknown) => unknown) =>
      cb({ pullRequestDetail: { findFirst: vi.fn().mockResolvedValue(null) } })
    );
    mockGetSinglePullRequest.mockResolvedValueOnce(null);

    await runRepair([input]);

    expect(mockRepoFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          fullName: "acme/target-repo",
          removedAt: null,
          installation: {
            organizationId: ORG_ID,
            status: GitHubInstallationStatus.ACTIVE,
          },
        },
        select: {
          id: true,
          installation: { select: { installationId: true } },
        },
      })
    );
  });

  it("memoizes repositoryId across two inputs for the same repo (only one DB lookup)", async () => {
    const inputA = makeInput({
      id: "input-a",
      externalUrl: "https://github.com/acme/shared-repo/pull/10",
    });
    const inputB = makeInput({
      id: "input-b",
      externalUrl: "https://github.com/acme/shared-repo/pull/11",
    });

    const mockRepoFindFirst = vi.fn().mockResolvedValue({
      id: "repo-uuid-shared",
      removedAt: null,
      installation: {
        installationId: "install-shared",
        status: GitHubInstallationStatus.ACTIVE,
      },
    });

    // Input A: resolveRepositoryId (DB hit), then existing detail misses.
    mockWithDb
      .mockImplementationOnce((cb: (db: unknown) => unknown) =>
        cb({ gitHubInstallationRepository: { findFirst: mockRepoFindFirst } })
      )
      .mockImplementationOnce((cb: (db: unknown) => unknown) =>
        cb({
          pullRequestDetail: { findFirst: vi.fn().mockResolvedValue(null) },
        })
      );

    // Input B: resolveRepositoryId uses cache, then existing detail misses.
    mockWithDb.mockImplementationOnce((cb: (db: unknown) => unknown) =>
      cb({ pullRequestDetail: { findFirst: vi.fn().mockResolvedValue(null) } })
    );

    mockGetSinglePullRequest
      .mockResolvedValueOnce(makeFreshPr({ githubId: "gh-pr-10", number: 10 }))
      .mockResolvedValueOnce(makeFreshPr({ githubId: "gh-pr-11", number: 11 }));

    // tx for inputs A and B
    mockWithDb.tx
      .mockImplementationOnce((cb: (tx: unknown) => unknown) =>
        cb({
          pullRequestDetail: {
            findFirst: vi.fn().mockResolvedValue(null),
          },
          artifact: {
            create: vi
              .fn()
              .mockResolvedValue({ id: "created-a", pullRequestDetails: [] }),
          },
        })
      )
      .mockImplementationOnce((cb: (tx: unknown) => unknown) =>
        cb({
          pullRequestDetail: {
            findFirst: vi.fn().mockResolvedValue(null),
          },
          artifact: {
            create: vi
              .fn()
              .mockResolvedValue({ id: "created-b", pullRequestDetails: [] }),
          },
        })
      );

    await runRepair([inputA, inputB]);

    expect(mockRepoFindFirst).toHaveBeenCalledOnce();
  });

  it("repairs eligible links concurrently rather than sequentially", async () => {
    // Explicit short timeout: a regression to a sequential loop deadlocks the
    // barrier below, and this surfaces it as a fast failure rather than waiting
    // out the runner's default timeout.
    const inputA = makeInput({
      id: "input-a",
      externalUrl: "https://github.com/acme/repo-a/pull/10",
    });
    const inputB = makeInput({
      id: "input-b",
      externalUrl: "https://github.com/acme/repo-b/pull/11",
    });

    // Drop any once-queued implementations leaked from earlier tests so the
    // persistent barrier implementations below take effect on the first call.
    mockWithDb.mockReset();
    mockGetSinglePullRequest.mockReset();

    // Generic db stub: satisfies both resolveRepositoryId and the existing
    // detail lookup regardless of concurrent call interleaving.
    mockWithDb.mockImplementation((cb: (db: unknown) => unknown) =>
      cb({
        gitHubInstallationRepository: {
          findFirst: vi.fn().mockResolvedValue({
            id: "repo-shared",
            removedAt: null,
            installation: {
              installationId: "install-shared",
              status: GitHubInstallationStatus.ACTIVE,
            },
          }),
        },
        pullRequestDetail: { findFirst: vi.fn().mockResolvedValue(null) },
      })
    );
    mockWithDb.tx.mockImplementation((cb: (tx: unknown) => unknown) =>
      cb({
        pullRequestDetail: { findFirst: vi.fn().mockResolvedValue(null) },
        artifact: {
          create: vi
            .fn()
            .mockResolvedValue({ id: "created", pullRequestDetails: [] }),
        },
      })
    );

    // Barrier: each GitHub fetch blocks until BOTH links have reached it. A
    // sequential loop would await the first fetch forever (the second link
    // never starts), so this only completes when the repairs run concurrently.
    let started = 0;
    let releaseBoth: () => void = () => undefined;
    const bothStarted = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    mockGetSinglePullRequest.mockImplementation(async () => {
      started += 1;
      if (started === 2) {
        releaseBoth();
      }
      await bothStarted;
      return makeFreshPr();
    });

    await runRepair([inputA, inputB]);

    expect(mockGetSinglePullRequest).toHaveBeenCalledTimes(2);
  }, 2000);
});
