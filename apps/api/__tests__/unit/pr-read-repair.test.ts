/**
 * Unit tests for pr-read-repair module (post-artifact-cutover).
 *
 * schedulePrReadRepair — eligibility filtering over `PrReadRepairInput[]`:
 * - Returns early when inputs array is empty
 * - Skips inputs already in MERGED state (when verified)
 * - Skips inputs verified within the 24h staleness threshold
 * - Skips inputs with a refresh attempt within the 1h debounce window
 * - Schedules via waitUntil for merged-but-never-verified PRs
 * - Schedules via waitUntil for stale open PRs
 *
 * repairSinglePrLink (invoked via captured waitUntil promise):
 * - Stamps lastRefreshAttemptAt on the current PullRequestDetail
 * - Skips when PR URL cannot be parsed
 * - Skips when installationId cannot be resolved
 * - Skips when getSinglePullRequest returns null
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Module-level mocks ---

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn(),
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

vi.mock("@repo/github", () => ({
  getSinglePullRequest: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { BranchViewPrLifecycleRepairStatus } from "@repo/api/src/types/branch-view";
import { GitHubPRState } from "@repo/api/src/types/github";
import { withDb } from "@repo/database";
import { getSinglePullRequest } from "@repo/github";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import {
  getPrReadRepairStatus,
  type PrReadRepairInput,
  schedulePrReadRepair,
} from "@/lib/pr-read-repair";

const mockWaitUntil = vi.mocked(waitUntil);
const mockWithDb = vi.mocked(withDb) as unknown as ReturnType<typeof vi.fn> & {
  tx: ReturnType<typeof vi.fn>;
};
const mockGetSinglePullRequest = vi.mocked(getSinglePullRequest);
const mockLog = vi.mocked(log);

const ORG_ID = "org-uuid-test";

/** 24 hours + 1ms — past the staleness threshold */
const STALE_MS = 24 * 60 * 60 * 1000 + 1;

function msAgo(ms: number): Date {
  return new Date(Date.now() - ms);
}

function makeInput(
  overrides: Partial<PrReadRepairInput> = {}
): PrReadRepairInput {
  return {
    id: "link-uuid-1",
    externalUrl: "https://github.com/acme/my-repo/pull/42",
    projectId: "proj-uuid-1",
    organizationId: ORG_ID,
    prState: GitHubPRState.Open,
    lastVerifiedAt: null,
    lastRefreshAttemptAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// schedulePrReadRepair — eligibility filtering
// ---------------------------------------------------------------------------

describe("schedulePrReadRepair — eligibility filtering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns early and does not call waitUntil when inputs is empty", () => {
    schedulePrReadRepair([], ORG_ID);
    expect(mockWaitUntil).not.toHaveBeenCalled();
  });

  it("does not call waitUntil when the PR is merged and has been verified", () => {
    const input = makeInput({
      prState: GitHubPRState.Merged,
      lastVerifiedAt: msAgo(60 * 60 * 1000),
    });
    schedulePrReadRepair([input], ORG_ID);
    expect(mockWaitUntil).not.toHaveBeenCalled();
  });

  it("calls waitUntil for a merged PR that was never verified", () => {
    const input = makeInput({
      prState: GitHubPRState.Merged,
      lastVerifiedAt: null,
    });
    schedulePrReadRepair([input], ORG_ID);
    expect(mockWaitUntil).toHaveBeenCalledOnce();
  });

  it("does not call waitUntil when verified within the 24h staleness threshold", () => {
    const input = makeInput({
      prState: GitHubPRState.Open,
      lastVerifiedAt: msAgo(60 * 60 * 1000),
      lastRefreshAttemptAt: null,
    });
    schedulePrReadRepair([input], ORG_ID);
    expect(mockWaitUntil).not.toHaveBeenCalled();
  });

  it("does not call waitUntil when a refresh attempt was made within the 1h debounce window", () => {
    const input = makeInput({
      prState: GitHubPRState.Open,
      lastVerifiedAt: null,
      lastRefreshAttemptAt: msAgo(30 * 60 * 1000),
    });
    schedulePrReadRepair([input], ORG_ID);
    expect(mockWaitUntil).not.toHaveBeenCalled();
  });

  it("calls waitUntil for an open PR never verified before", () => {
    const input = makeInput({
      prState: GitHubPRState.Open,
      lastVerifiedAt: null,
      lastRefreshAttemptAt: null,
    });
    schedulePrReadRepair([input], ORG_ID);
    expect(mockWaitUntil).toHaveBeenCalledOnce();
  });

  it("calls waitUntil for an open PR whose lastVerifiedAt is past the 24h staleness threshold", () => {
    const input = makeInput({
      prState: GitHubPRState.Open,
      lastVerifiedAt: msAgo(STALE_MS),
      lastRefreshAttemptAt: null,
    });
    schedulePrReadRepair([input], ORG_ID);
    expect(mockWaitUntil).toHaveBeenCalledOnce();
  });

  it("calls waitUntil for a closed (non-merged) PR past the staleness threshold", () => {
    const input = makeInput({
      prState: GitHubPRState.Closed,
      lastVerifiedAt: msAgo(STALE_MS),
      lastRefreshAttemptAt: null,
    });
    schedulePrReadRepair([input], ORG_ID);
    expect(mockWaitUntil).toHaveBeenCalledOnce();
  });

  it("calls waitUntil only for eligible inputs when list is mixed", () => {
    const mergedVerified = makeInput({
      id: "input-merged",
      prState: GitHubPRState.Merged,
      lastVerifiedAt: msAgo(60 * 60 * 1000),
    });
    const fresh = makeInput({
      id: "input-fresh",
      prState: GitHubPRState.Open,
      lastVerifiedAt: msAgo(60 * 60 * 1000),
    });
    const eligible = makeInput({
      id: "input-stale",
      prState: GitHubPRState.Open,
      lastVerifiedAt: null,
    });
    schedulePrReadRepair([mergedVerified, fresh, eligible], ORG_ID);
    expect(mockWaitUntil).toHaveBeenCalledOnce();
  });

  it("keeps client status pending during a short in-flight repair attempt", () => {
    const nowMs = Date.now();
    expect(
      getPrReadRepairStatus(
        makeInput({
          prState: GitHubPRState.Open,
          lastVerifiedAt: null,
          lastRefreshAttemptAt: null,
        }),
        nowMs
      )
    ).toBe(BranchViewPrLifecycleRepairStatus.Pending);
    expect(
      getPrReadRepairStatus(
        makeInput({
          prState: GitHubPRState.Open,
          lastVerifiedAt: new Date(nowMs - 60 * 60 * 1000),
          lastRefreshAttemptAt: null,
        }),
        nowMs
      )
    ).toBe(BranchViewPrLifecycleRepairStatus.Idle);
    expect(
      getPrReadRepairStatus(
        makeInput({
          prState: GitHubPRState.Open,
          lastVerifiedAt: null,
          lastRefreshAttemptAt: new Date(nowMs - 10 * 1000),
        }),
        nowMs
      )
    ).toBe(BranchViewPrLifecycleRepairStatus.Pending);
    expect(
      getPrReadRepairStatus(
        makeInput({
          prState: GitHubPRState.Open,
          lastVerifiedAt: null,
          lastRefreshAttemptAt: new Date(nowMs - 30 * 60 * 1000),
        }),
        nowMs
      )
    ).toBe(BranchViewPrLifecycleRepairStatus.Idle);
  });
});

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
            installation: { installationId: "install-99" },
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
        repository: {
          installation: { organizationId: input.organizationId },
        },
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
            installation: { organizationId: input.organizationId },
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
        installation: { organizationId: input.organizationId },
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
        repository: {
          installation: { organizationId: input.organizationId },
        },
      },
      select: { id: true, repositoryId: true },
    });
  });

  it("skips update when getSinglePullRequest returns null", async () => {
    const input = makeInput();

    // Call 1: resolveRepositoryId → valid
    mockWithDb.mockImplementationOnce((cb: (db: unknown) => unknown) =>
      cb({
        gitHubInstallationRepository: {
          findFirst: vi.fn().mockResolvedValue({
            id: "repo-uuid-99",
            installation: { installationId: "install-99" },
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
      expect.stringContaining("getSinglePullRequest returned null"),
      expect.any(Object)
    );
  });

  it("resolveRepositoryId queries by fullName scoped to org", async () => {
    const input = makeInput({
      externalUrl: "https://github.com/acme/target-repo/pull/7",
    });
    const mockRepoFindFirst = vi.fn().mockResolvedValue({
      id: "repo-uuid-target",
      installation: { installationId: "install-target" },
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
          installation: { organizationId: ORG_ID },
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
      installation: { installationId: "install-shared" },
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
            installation: { installationId: "install-shared" },
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
