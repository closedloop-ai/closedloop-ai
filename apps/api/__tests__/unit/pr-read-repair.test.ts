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
 * - Stamps lastRefreshAttemptAt on the PullRequestDetail
 * - Skips when PR URL cannot be parsed
 * - Skips when installationId cannot be resolved
 * - Skips when getSinglePullRequest returns null
 */

import { vi } from "vitest";

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
    PULL_REQUEST: "PULL_REQUEST",
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

import { GitHubPRState } from "@repo/api/src/types/github";
import { withDb } from "@repo/database";
import { getSinglePullRequest } from "@repo/github";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import {
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
    workstreamId: "ws-uuid-1",
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

    // Call 1: pullRequestDetail.update (stamp)
    mockWithDb.mockImplementationOnce((cb: (db: unknown) => unknown) =>
      cb({ pullRequestDetail: { update: mockDetailUpdate } })
    );
    // Call 2: resolveRepositoryId — returns null (no match)
    mockWithDb.mockImplementationOnce((cb: (db: unknown) => unknown) =>
      cb({
        gitHubInstallationRepository: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      })
    );
    // Call 3: resolveInstallationId primary: no detail → fallback
    mockWithDb.mockImplementationOnce((cb: (db: unknown) => unknown) =>
      cb({
        pullRequestDetail: { findUnique: vi.fn().mockResolvedValue(null) },
      })
    );
    // Call 4: resolveInstallationId fallback: 0 installations
    mockWithDb.mockImplementationOnce((cb: (db: unknown) => unknown) =>
      cb({
        gitHubInstallation: { findMany: vi.fn().mockResolvedValue([]) },
      })
    );

    await runRepair([input]);

    expect(mockDetailUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { artifactId: input.id },
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

    // Call 1: stamp
    mockWithDb.mockImplementationOnce((cb: (db: unknown) => unknown) =>
      cb({ pullRequestDetail: { update: vi.fn().mockResolvedValue({}) } })
    );
    // Call 2: resolveRepositoryId → null
    mockWithDb.mockImplementationOnce((cb: (db: unknown) => unknown) =>
      cb({
        gitHubInstallationRepository: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      })
    );
    // Call 3: resolveInstallationId primary → no detail
    mockWithDb.mockImplementationOnce((cb: (db: unknown) => unknown) =>
      cb({
        pullRequestDetail: { findUnique: vi.fn().mockResolvedValue(null) },
      })
    );
    // Call 4: resolveInstallationId fallback → 0 installations
    mockWithDb.mockImplementationOnce((cb: (db: unknown) => unknown) =>
      cb({
        gitHubInstallation: { findMany: vi.fn().mockResolvedValue([]) },
      })
    );

    await runRepair([input]);

    expect(mockGetSinglePullRequest).not.toHaveBeenCalled();
  });

  it("skips update when getSinglePullRequest returns null", async () => {
    const input = makeInput();
    const mockDetailUpdate = vi.fn().mockResolvedValue({});

    // Call 1: stamp
    mockWithDb.mockImplementationOnce((cb: (db: unknown) => unknown) =>
      cb({ pullRequestDetail: { update: mockDetailUpdate } })
    );
    // Call 2: resolveRepositoryId → valid
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

    mockGetSinglePullRequest.mockResolvedValueOnce(null);

    await runRepair([input]);

    // Only the stamp call; tx never entered
    expect(mockDetailUpdate).toHaveBeenCalledTimes(1);
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

    // Call 1: stamp
    mockWithDb.mockImplementationOnce((cb: (db: unknown) => unknown) =>
      cb({ pullRequestDetail: { update: vi.fn().mockResolvedValue({}) } })
    );
    // Call 2: resolveRepositoryId
    mockWithDb.mockImplementationOnce((cb: (db: unknown) => unknown) =>
      cb({
        gitHubInstallationRepository: { findFirst: mockRepoFindFirst },
      })
    );

    mockGetSinglePullRequest.mockResolvedValueOnce(
      makeFreshPr({ githubId: "gh-pr-target", number: 7 })
    );

    // tx: detail exists → apply update
    mockWithDb.tx.mockImplementationOnce((cb: (tx: unknown) => unknown) =>
      cb({
        pullRequestDetail: {
          findUnique: vi.fn().mockResolvedValue({ artifactId: input.id }),
          update: vi.fn().mockResolvedValue({}),
        },
        artifact: { update: vi.fn().mockResolvedValue({}) },
      })
    );

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

    // Input A: stamp + resolveRepositoryId (DB hit)
    mockWithDb
      .mockImplementationOnce((cb: (db: unknown) => unknown) =>
        cb({ pullRequestDetail: { update: vi.fn().mockResolvedValue({}) } })
      )
      .mockImplementationOnce((cb: (db: unknown) => unknown) =>
        cb({ gitHubInstallationRepository: { findFirst: mockRepoFindFirst } })
      );

    // Input B: stamp only — resolveRepositoryId uses cache
    mockWithDb.mockImplementationOnce((cb: (db: unknown) => unknown) =>
      cb({ pullRequestDetail: { update: vi.fn().mockResolvedValue({}) } })
    );

    mockGetSinglePullRequest
      .mockResolvedValueOnce(makeFreshPr({ githubId: "gh-pr-10", number: 10 }))
      .mockResolvedValueOnce(makeFreshPr({ githubId: "gh-pr-11", number: 11 }));

    // tx for inputs A and B
    mockWithDb.tx
      .mockImplementationOnce((cb: (tx: unknown) => unknown) =>
        cb({
          pullRequestDetail: {
            findUnique: vi.fn().mockResolvedValue(null),
          },
          artifact: { create: vi.fn().mockResolvedValue({}) },
        })
      )
      .mockImplementationOnce((cb: (tx: unknown) => unknown) =>
        cb({
          pullRequestDetail: {
            findUnique: vi.fn().mockResolvedValue(null),
          },
          artifact: { create: vi.fn().mockResolvedValue({}) },
        })
      );

    await runRepair([inputA, inputB]);

    expect(mockRepoFindFirst).toHaveBeenCalledOnce();
  });
});
