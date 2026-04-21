/**
 * Unit tests for pr-read-repair module.
 *
 * schedulePrReadRepair — eligibility filtering:
 * - Returns early when externalLinks array is empty
 * - Filters out non-PullRequest type links
 * - Skips links already in MERGED state (terminal — no further refresh needed)
 * - Skips links verified within the 24h staleness threshold
 * - Skips links with a refresh attempt within the 1h debounce window
 * - Schedules via waitUntil for links with missing metadata (need state resolution)
 * - Schedules via waitUntil for non-merged links past the staleness threshold
 *
 * runPrReadRepair (invoked via captured waitUntil promise) — repair logic:
 * - Stamps lastRefreshAttemptAt before calling GitHub API
 * - Skips link when PR URL cannot be parsed
 * - Skips link when installationId cannot be resolved
 * - Skips link when getSinglePullRequest returns null
 * - Updates externalLink metadata with fresh state/title/timestamps on success
 * - Updates GitHubPullRequest row with fresh state data when githubId present
 * - Logs warning when GitHubPullRequest updateMany matches 0 rows
 * - Proceeds to create github_pull_requests when original metadata lacks githubId but fresh PR data is fetched
 *
 * repairSinglePrLink — new functionality (T-4.1 through T-4.4):
 * - creates github_pull_requests when none exists
 * - resolves workstream from artifact
 * - resolves workstream from feature when artifact has none
 * - handles no-workstream case (logs warning, skips github_pull_requests creation)
 * - no duplicate insert on P2002 unique constraint
 * - fixes null workstream_id on external link
 * - correctly resolves repositoryId from installation repositories
 * - repositoryId memoized across two links for same repo (only one DB lookup)
 */

import { vi } from "vitest";

// --- Module-level mocks (factories cannot reference outer variables — use vi.fn() inline) ---

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn(),
}));

vi.mock("@repo/database", () => ({
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

import type { JsonObject } from "@repo/api/src/types/common";
import { EntityType } from "@repo/api/src/types/entity-link";
import { ExternalLinkType } from "@repo/api/src/types/external-link";
import { GitHubPRState } from "@repo/api/src/types/github";
import { withDb } from "@repo/database";
import { getSinglePullRequest } from "@repo/github";
import { log } from "@repo/observability/log";
// Import after mocks
import { waitUntil } from "@vercel/functions";
import { schedulePrReadRepair } from "@/lib/pr-read-repair";

// Typed mock references
const mockWaitUntil = vi.mocked(waitUntil);
const mockWithDb = vi.mocked(withDb) as unknown as ReturnType<typeof vi.fn> & {
  tx: ReturnType<typeof vi.fn>;
};
const mockGetSinglePullRequest = vi.mocked(getSinglePullRequest);
const mockLog = vi.mocked(log);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ORG_ID = "org-uuid-test";

/** 24 hours + 1ms — past the staleness threshold */
const STALE_MS = 24 * 60 * 60 * 1000 + 1;

function msAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

type ExternalLinkOverride = {
  id?: string;
  type?: ExternalLinkType;
  externalUrl?: string;
  metadata?: JsonObject | null;
  workstreamId?: string | null;
};

function makeExternalLink(overrides: ExternalLinkOverride = {}) {
  return {
    id: "link-uuid-1",
    organizationId: ORG_ID,
    workstreamId: "ws-uuid-1" as string | null,
    projectId: "proj-uuid-1",
    type: ExternalLinkType.PullRequest,
    title: "My PR",
    externalUrl: "https://github.com/acme/my-repo/pull/42",
    metadata: null as JsonObject | null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makePrMetadata(
  overrides: Partial<{
    number: number;
    githubId: string;
    headBranch: string;
    baseBranch: string;
    state: string;
    lastVerifiedAt: string | null;
    lastRefreshAttemptAt: string | null;
  }> = {}
): JsonObject {
  return {
    number: 42,
    githubId: "gh-pr-111",
    headBranch: "feature-x",
    baseBranch: "main",
    state: GitHubPRState.Open,
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

  it("returns early and does not call waitUntil when externalLinks is empty", () => {
    schedulePrReadRepair([], ORG_ID);

    expect(mockWaitUntil).not.toHaveBeenCalled();
  });

  it("does not call waitUntil when all links are non-PullRequest type", () => {
    const links = [
      makeExternalLink({ type: ExternalLinkType.FigmaDesign, metadata: null }),
      makeExternalLink({
        type: ExternalLinkType.PreviewDeployment,
        metadata: null,
      }),
    ];

    schedulePrReadRepair(links, ORG_ID);

    expect(mockWaitUntil).not.toHaveBeenCalled();
  });

  it("does not call waitUntil when the PR is merged and has been verified", () => {
    const link = makeExternalLink({
      metadata: makePrMetadata({
        state: GitHubPRState.Merged,
        lastVerifiedAt: msAgo(60 * 60 * 1000),
      }),
    });

    schedulePrReadRepair([link], ORG_ID);

    expect(mockWaitUntil).not.toHaveBeenCalled();
  });

  it("calls waitUntil for a merged PR that was never verified", () => {
    const link = makeExternalLink({
      metadata: makePrMetadata({ state: GitHubPRState.Merged }),
    });

    schedulePrReadRepair([link], ORG_ID);

    expect(mockWaitUntil).toHaveBeenCalledOnce();
  });

  it("does not call waitUntil when link was verified within the 24h staleness threshold", () => {
    // Verified 1 hour ago — still fresh
    const recentlyVerified = msAgo(60 * 60 * 1000);
    const link = makeExternalLink({
      metadata: makePrMetadata({
        state: GitHubPRState.Open,
        lastVerifiedAt: recentlyVerified,
        lastRefreshAttemptAt: null,
      }),
    });

    schedulePrReadRepair([link], ORG_ID);

    expect(mockWaitUntil).not.toHaveBeenCalled();
  });

  it("does not call waitUntil when a refresh attempt was made within the 1h debounce window", () => {
    // Attempted 30 minutes ago — within the 1h debounce
    const recentAttempt = msAgo(30 * 60 * 1000);
    const link = makeExternalLink({
      metadata: makePrMetadata({
        state: GitHubPRState.Open,
        lastVerifiedAt: null,
        lastRefreshAttemptAt: recentAttempt,
      }),
    });

    schedulePrReadRepair([link], ORG_ID);

    expect(mockWaitUntil).not.toHaveBeenCalled();
  });

  it("calls waitUntil for a link with null metadata (never checked before)", () => {
    const link = makeExternalLink({ metadata: null });

    schedulePrReadRepair([link], ORG_ID);

    expect(mockWaitUntil).toHaveBeenCalledOnce();
  });

  it("calls waitUntil for an open PR whose lastVerifiedAt is past the 24h staleness threshold", () => {
    const link = makeExternalLink({
      metadata: makePrMetadata({
        state: GitHubPRState.Open,
        lastVerifiedAt: msAgo(STALE_MS),
        lastRefreshAttemptAt: null,
      }),
    });

    schedulePrReadRepair([link], ORG_ID);

    expect(mockWaitUntil).toHaveBeenCalledOnce();
  });

  it("calls waitUntil for a closed (non-merged) PR past the staleness threshold", () => {
    const link = makeExternalLink({
      metadata: makePrMetadata({
        state: GitHubPRState.Closed,
        lastVerifiedAt: msAgo(STALE_MS),
        lastRefreshAttemptAt: null,
      }),
    });

    schedulePrReadRepair([link], ORG_ID);

    expect(mockWaitUntil).toHaveBeenCalledOnce();
  });

  it("calls waitUntil only for eligible links when list is mixed", () => {
    const mergedLink = makeExternalLink({
      id: "link-merged",
      metadata: makePrMetadata({ state: GitHubPRState.Merged }),
    });
    const freshLink = makeExternalLink({
      id: "link-fresh",
      metadata: makePrMetadata({
        state: GitHubPRState.Open,
        lastVerifiedAt: msAgo(60 * 60 * 1000), // 1h ago — still within threshold
      }),
    });
    const eligibleLink = makeExternalLink({
      id: "link-stale",
      metadata: null, // null = needs check
    });

    schedulePrReadRepair([mergedLink, freshLink, eligibleLink], ORG_ID);

    expect(mockWaitUntil).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// runPrReadRepair — repair logic (exercised via waitUntil capture)
// ---------------------------------------------------------------------------

describe("runPrReadRepair — repair logic", () => {
  /**
   * Run schedulePrReadRepair with the given links and capture the waitUntil
   * promise, then await it so we can assert on DB/GitHub calls synchronously.
   */
  async function runRepair(links: ReturnType<typeof makeExternalLink>[]) {
    schedulePrReadRepair(links, ORG_ID);

    const capturedPromise = mockWaitUntil.mock.calls[0]?.[0] as
      | Promise<void>
      | undefined;
    if (capturedPromise) {
      await capturedPromise;
    }
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // Reinitialize withDb.tx after clearAllMocks (clearAllMocks resets the mock but preserves the property)
    mockWithDb.tx = vi.fn();
  });

  it("stamps lastRefreshAttemptAt on the externalLink before calling GitHub API", async () => {
    const link = makeExternalLink({ metadata: null });

    // update → stamps attempt; findFirst + findMany for installation fallback
    mockWithDb.mockImplementation((cb: any) =>
      cb({
        externalLink: {
          update: vi.fn().mockResolvedValue({ metadata: {} }),
        },
        gitHubPullRequest: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
        gitHubInstallation: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      })
    );

    await runRepair([link]);

    // withDb should have been called to stamp lastRefreshAttemptAt
    expect(mockWithDb).toHaveBeenCalled();
    const firstCallArg = mockWithDb.mock.calls[0][0];
    const mockDb = {
      externalLink: {
        update: vi.fn().mockResolvedValue({ metadata: {} }),
      },
    };
    await firstCallArg(mockDb);
    expect(mockDb.externalLink.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: link.id },
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            lastRefreshAttemptAt: expect.any(String),
          }),
        }),
      })
    );
  });

  it("skips the link when the PR URL cannot be parsed (no GitHub domain match)", async () => {
    const link = makeExternalLink({
      externalUrl: "https://not-github.com/some/page",
      metadata: null,
    });

    await runRepair([link]);

    // Should not attempt to stamp or call GitHub
    expect(mockWithDb).not.toHaveBeenCalled();
    expect(mockGetSinglePullRequest).not.toHaveBeenCalled();
  });

  it("skips the GitHub API call when no installationId can be resolved", async () => {
    const link = makeExternalLink({ metadata: null });

    // Call 1: externalLink.update stamps attempt
    mockWithDb.mockImplementationOnce((cb: any) =>
      cb({
        externalLink: {
          update: vi.fn().mockResolvedValue({ metadata: {} }),
        },
      })
    );
    // Call 2: resolveRepositoryId — gitHubInstallationRepository.findFirst returns null (no repo match)
    mockWithDb.mockImplementationOnce((cb: any) =>
      cb({
        gitHubInstallationRepository: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      })
    );
    // Call 3: resolveInstallationId fallback — gitHubInstallation.findMany returns 0 installations
    mockWithDb.mockImplementationOnce((cb: any) =>
      cb({
        gitHubInstallation: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      })
    );

    await runRepair([link]);

    expect(mockGetSinglePullRequest).not.toHaveBeenCalled();
  });

  it("skips externalLink update when getSinglePullRequest returns null", async () => {
    const link = makeExternalLink({
      metadata: makePrMetadata({
        githubId: undefined as any,
        state: GitHubPRState.Open,
      }),
    });
    const mockExternalLinkUpdate = vi.fn().mockResolvedValue({ metadata: {} });

    // Call 1: stamp lastRefreshAttemptAt
    mockWithDb.mockImplementationOnce((cb: any) =>
      cb({ externalLink: { update: mockExternalLinkUpdate } })
    );
    // Call 2: resolveRepositoryId — gitHubInstallationRepository.findFirst returns result
    mockWithDb.mockImplementationOnce((cb: any) =>
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

    await runRepair([link]);

    // Only the stamp withDb call occurred for externalLink.update; tx was never entered
    expect(mockExternalLinkUpdate).toHaveBeenCalledTimes(1);
    expect(mockWithDb.tx).not.toHaveBeenCalled();
  });

  it("updates externalLink metadata with fresh state, title, and timestamps on success", async () => {
    // link.workstreamId is non-null so resolveWorkstreamId short-circuits immediately.
    const link = makeExternalLink({
      workstreamId: "ws-uuid-1",
      metadata: makePrMetadata({
        githubId: "gh-pr-999",
        state: GitHubPRState.Open,
        lastVerifiedAt: null,
        lastRefreshAttemptAt: null,
      }),
    });

    const mockExternalLinkUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const mockPrUpdateMany = vi.fn().mockResolvedValue({ count: 1 });

    // Call 1: stamp lastRefreshAttemptAt
    mockWithDb.mockImplementationOnce((cb: any) =>
      cb({
        externalLink: {
          update: vi.fn().mockResolvedValue({ metadata: link.metadata }),
        },
      })
    );
    // Call 2: resolveRepositoryId — gitHubInstallationRepository.findFirst
    mockWithDb.mockImplementationOnce((cb: any) =>
      cb({
        gitHubInstallationRepository: {
          findFirst: vi.fn().mockResolvedValue({
            id: "repo-uuid-77",
            installation: { installationId: "install-77" },
          }),
        },
      })
    );

    // withDb.tx: applyExternalLinkUpdate (updateMany) + applyPullRequestUpsert (findFirst → updateMany)
    mockWithDb.tx.mockImplementationOnce((cb: any) =>
      cb({
        externalLink: { updateMany: mockExternalLinkUpdateMany },
        gitHubPullRequest: {
          findFirst: vi.fn().mockResolvedValue({ id: "existing-pr" }),
          create: vi.fn(),
          updateMany: mockPrUpdateMany,
        },
      })
    );

    mockGetSinglePullRequest.mockResolvedValueOnce({
      githubId: "gh-pr-999",
      number: 42,
      title: "Fresh title",
      htmlUrl: "https://github.com/acme/my-repo/pull/42",
      headBranch: "feature-x",
      baseBranch: "main",
      state: GitHubPRState.Merged,
      mergedAt: "2026-04-01T10:00:00Z",
      closedAt: "2026-04-01T10:00:00Z",
      authorLogin: null,
      isDraft: false,
      headSha: "abc123",
      baseSha: "def456",
    });

    await runRepair([link]);

    // externalLink.updateMany in tx should include fresh state/title/timestamps
    expect(mockExternalLinkUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: "Fresh title",
          metadata: expect.objectContaining({
            githubId: "gh-pr-999",
            number: 42,
            headBranch: "feature-x",
            baseBranch: "main",
            state: GitHubPRState.Merged,
            lastVerifiedAt: expect.any(String),
            lastRefreshAttemptAt: expect.any(String),
          }),
        }),
      })
    );
  });

  it("updates GitHubPullRequest row when githubId is present in metadata", async () => {
    // link.workstreamId is non-null so resolveWorkstreamId short-circuits immediately.
    const link = makeExternalLink({
      workstreamId: "ws-uuid-1",
      metadata: makePrMetadata({
        githubId: "gh-pr-888",
        state: GitHubPRState.Open,
      }),
    });

    const mockPrUpdateMany = vi.fn().mockResolvedValue({ count: 1 });

    // Call 1: stamp lastRefreshAttemptAt
    mockWithDb.mockImplementationOnce((cb: any) =>
      cb({
        externalLink: {
          update: vi.fn().mockResolvedValue({ metadata: link.metadata }),
        },
      })
    );
    // Call 2: resolveRepositoryId — gitHubInstallationRepository.findFirst
    mockWithDb.mockImplementationOnce((cb: any) =>
      cb({
        gitHubInstallationRepository: {
          findFirst: vi.fn().mockResolvedValue({
            id: "repo-uuid-55",
            installation: { installationId: "install-55" },
          }),
        },
      })
    );

    // withDb.tx: applyExternalLinkUpdate (updateMany) + applyPullRequestUpsert (findFirst → updateMany)
    // findFirst returns a row → existing PR → calls updateMany
    mockWithDb.tx.mockImplementationOnce((cb: any) =>
      cb({
        externalLink: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        gitHubPullRequest: {
          findFirst: vi.fn().mockResolvedValue({ id: "existing-pr-888" }),
          create: vi.fn(),
          updateMany: mockPrUpdateMany,
        },
      })
    );

    mockGetSinglePullRequest.mockResolvedValueOnce({
      githubId: "gh-pr-888",
      number: 42,
      title: "Updated title",
      htmlUrl: "https://github.com/acme/my-repo/pull/42",
      headBranch: "feature-x",
      baseBranch: "main",
      state: GitHubPRState.Merged,
      mergedAt: "2026-04-02T10:00:00Z",
      closedAt: "2026-04-02T10:00:00Z",
      authorLogin: null,
      isDraft: false,
      headSha: "abc123",
      baseSha: "def456",
    });

    await runRepair([link]);

    expect(mockPrUpdateMany).toHaveBeenCalledWith({
      where: { githubId: "gh-pr-888", organizationId: ORG_ID },
      data: {
        state: GitHubPRState.Merged,
        title: "Updated title",
        mergedAt: new Date("2026-04-02T10:00:00Z"),
        closedAt: new Date("2026-04-02T10:00:00Z"),
      },
    });
  });

  it("proceeds to create github_pull_requests when original metadata lacks githubId but fresh PR data is fetched successfully", async () => {
    // T-4.4 changed behavior: missing githubId in original metadata no longer
    // causes a skip. resolveRepositoryId now provides repositoryId+installationId
    // from the URL, and the fresh PR response provides githubId. The function
    // must proceed to applyPullRequestUpsert and create the row.
    const link = makeExternalLink({
      workstreamId: "ws-uuid-1",
      metadata: {
        number: 42,
        headBranch: "feat",
        baseBranch: "main",
        state: GitHubPRState.Open,
        // githubId deliberately absent from original metadata
      },
    });

    const mockExternalLinkUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const mockRepoFindFirst = vi.fn().mockResolvedValue({
      id: "repo-uuid-1",
      installation: { installationId: "install-33" },
    });
    const mockPrFindFirst = vi.fn().mockResolvedValue(null);
    const mockPrCreate = vi.fn().mockResolvedValue({});

    // Call 1: stamp lastRefreshAttemptAt
    mockWithDb.mockImplementationOnce((cb: any) =>
      cb({
        externalLink: {
          update: vi.fn().mockResolvedValue({ metadata: {} }),
        },
      })
    );
    // Call 2: resolveRepositoryId — gitHubInstallationRepository.findFirst
    mockWithDb.mockImplementationOnce((cb: any) =>
      cb({ gitHubInstallationRepository: { findFirst: mockRepoFindFirst } })
    );

    // withDb.tx for the transactional update (applyExternalLinkUpdate + applyPullRequestUpsert)
    mockWithDb.tx.mockImplementationOnce((cb: any) =>
      cb({
        externalLink: { updateMany: mockExternalLinkUpdateMany },
        gitHubPullRequest: {
          findFirst: mockPrFindFirst,
          create: mockPrCreate,
          updateMany: vi.fn(),
        },
      })
    );

    mockGetSinglePullRequest.mockResolvedValueOnce({
      githubId: "gh-pr-000",
      number: 42,
      title: "PR title",
      htmlUrl: "https://github.com/acme/my-repo/pull/42",
      headBranch: "feat",
      baseBranch: "main",
      state: GitHubPRState.Merged,
      mergedAt: "2026-04-03T00:00:00Z",
      closedAt: "2026-04-03T00:00:00Z",
      authorLogin: null,
      isDraft: false,
      headSha: "abc123",
      baseSha: "def456",
    });

    await runRepair([link]);

    // Must have entered the tx and updated the externalLink
    expect(mockWithDb.tx).toHaveBeenCalledOnce();
    expect(mockExternalLinkUpdateMany).toHaveBeenCalledOnce();
    // applyPullRequestUpsert must have attempted to create (findFirst returned null → no existing row)
    expect(mockPrCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          githubId: "gh-pr-000",
          workstreamId: "ws-uuid-1",
          repositoryId: "repo-uuid-1",
        }),
      })
    );
  });
});

// ---------------------------------------------------------------------------
// repairSinglePrLink — new functionality (T-4.1 through T-4.4)
// ---------------------------------------------------------------------------

describe("repairSinglePrLink — new functionality", () => {
  /**
   * Shared setup: stamp attempt + resolveRepositoryId returning a resolved repo,
   * then an optional resolveWorkstreamId chain, then the tx.
   *
   * This helper wires up the standard happy-path withDb call sequence:
   *   1. externalLink.update (stamp)
   *   2. gitHubInstallationRepository.findFirst (resolveRepositoryId)
   *   ...any extra withDb calls for resolveWorkstreamId...
   *   then mockWithDb.tx is set up by the caller.
   */
  function setupStampAndRepo(
    link: ReturnType<typeof makeExternalLink>,
    repoResult: { id: string; installation: { installationId: string } } | null,
    extraWithDbCalls: ((cb: any) => unknown)[] = []
  ) {
    // Call 1: stamp lastRefreshAttemptAt
    mockWithDb.mockImplementationOnce((cb: any) =>
      cb({
        externalLink: {
          update: vi.fn().mockResolvedValue({
            metadata: link.metadata ?? {},
          }),
        },
      })
    );
    // Call 2: resolveRepositoryId — gitHubInstallationRepository.findFirst
    mockWithDb.mockImplementationOnce((cb: any) =>
      cb({
        gitHubInstallationRepository: {
          findFirst: vi.fn().mockResolvedValue(repoResult),
        },
      })
    );
    // Additional withDb calls (e.g., resolveWorkstreamId entity link walks)
    for (const impl of extraWithDbCalls) {
      mockWithDb.mockImplementationOnce(impl);
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
      headBranch: "feat",
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

  async function runRepair(links: ReturnType<typeof makeExternalLink>[]) {
    schedulePrReadRepair(links, ORG_ID);
    const capturedPromise = mockWaitUntil.mock.calls[0]?.[0] as
      | Promise<void>
      | undefined;
    if (capturedPromise) {
      await capturedPromise;
    }
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset withDb.tx to a fresh mock after clearAllMocks resets the fn
    mockWithDb.tx = vi.fn();
  });

  it("creates github_pull_requests when none exists", async () => {
    const link = makeExternalLink({
      workstreamId: "ws-uuid-1",
      metadata: null,
    });
    const mockPrCreate = vi.fn().mockResolvedValue({});

    setupStampAndRepo(link, {
      id: "repo-uuid-1",
      installation: { installationId: "install-1" },
    });

    mockGetSinglePullRequest.mockResolvedValueOnce(makeFreshPr());

    // tx: externalLink.updateMany + gitHubPullRequest.findFirst (no existing) + create
    mockWithDb.tx.mockImplementationOnce((cb: any) =>
      cb({
        externalLink: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        gitHubPullRequest: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: mockPrCreate,
          updateMany: vi.fn(),
        },
      })
    );

    await runRepair([link]);

    expect(mockPrCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          githubId: "gh-pr-new",
          organizationId: ORG_ID,
          repositoryId: "repo-uuid-1",
          workstreamId: "ws-uuid-1",
          number: 42,
          title: "New PR",
        }),
      })
    );
  });

  it("resolves workstream from artifact when link has no workstreamId", async () => {
    // link.workstreamId is null — resolveWorkstreamId must walk the entity link tree
    const link = makeExternalLink({
      id: "link-no-ws",
      workstreamId: null,
      metadata: null,
    });
    const mockPrCreate = vi.fn().mockResolvedValue({});
    const mockEntityLinkFindMany = vi.fn().mockResolvedValue([
      {
        sourceId: "artifact-uuid-1",
        sourceType: EntityType.Document,
      },
    ]);
    const mockDocumentFindFirst = vi.fn().mockResolvedValue({
      workstreamId: "ws-from-artifact",
    });

    setupStampAndRepo(
      link,
      { id: "repo-uuid-2", installation: { installationId: "install-2" } },
      [
        // resolveWorkstreamId call 1: entityLink.findMany (parent links)
        (cb: any) =>
          cb({
            entityLink: {
              findMany: mockEntityLinkFindMany,
            },
          }),
        // resolveWorkstreamId call 2: artifact.findFirst
        (cb: any) =>
          cb({
            document: {
              findFirst: mockDocumentFindFirst,
            },
          }),
      ]
    );

    mockGetSinglePullRequest.mockResolvedValueOnce(makeFreshPr());

    mockWithDb.tx.mockImplementationOnce((cb: any) =>
      cb({
        externalLink: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        gitHubPullRequest: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: mockPrCreate,
          updateMany: vi.fn(),
        },
      })
    );

    await runRepair([link]);

    expect(mockPrCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workstreamId: "ws-from-artifact",
        }),
      })
    );
    expect(mockEntityLinkFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: ORG_ID }),
      })
    );
    expect(mockDocumentFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: ORG_ID }),
      })
    );
  });

  it("resolves workstream from feature when artifact has no workstreamId", async () => {
    const link = makeExternalLink({
      id: "link-no-ws-2",
      workstreamId: null,
      metadata: null,
    });
    const mockPrCreate = vi.fn().mockResolvedValue({});
    const mockEntityLinkFindManyArtifact = vi.fn().mockResolvedValue([
      {
        sourceId: "artifact-uuid-2",
        sourceType: EntityType.Document,
      },
    ]);
    const mockDocumentFindFirst = vi
      .fn()
      .mockResolvedValue({ workstreamId: null });
    const mockEntityLinkFindManyFeature = vi.fn().mockResolvedValue([
      {
        sourceId: "feature-uuid-1",
        sourceType: EntityType.Document,
      },
    ]);
    const mockFeatureFindFirst = vi.fn().mockResolvedValue({
      workstreamId: "ws-from-feature",
    });

    setupStampAndRepo(
      link,
      { id: "repo-uuid-3", installation: { installationId: "install-3" } },
      [
        // resolveWorkstreamId call 1: entityLink.findMany (parent links)
        (cb: any) =>
          cb({
            entityLink: {
              findMany: mockEntityLinkFindManyArtifact,
            },
          }),
        // resolveWorkstreamId call 2: artifact.findFirst — workstreamId is null → continue to feature
        (cb: any) =>
          cb({
            document: {
              findFirst: mockDocumentFindFirst,
            },
          }),
        // resolveWorkstreamId call 3: entityLink.findMany (feature links)
        (cb: any) =>
          cb({
            entityLink: {
              findMany: mockEntityLinkFindManyFeature,
            },
          }),
        // resolveWorkstreamId call 4: document.findFirst (looking up Feature doc)
        (cb: any) =>
          cb({
            document: {
              findFirst: mockFeatureFindFirst,
            },
          }),
      ]
    );

    mockGetSinglePullRequest.mockResolvedValueOnce(makeFreshPr());

    mockWithDb.tx.mockImplementationOnce((cb: any) =>
      cb({
        externalLink: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        gitHubPullRequest: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: mockPrCreate,
          updateMany: vi.fn(),
        },
      })
    );

    await runRepair([link]);

    expect(mockPrCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workstreamId: "ws-from-feature",
        }),
      })
    );
    expect(mockEntityLinkFindManyArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: ORG_ID }),
      })
    );
    expect(mockDocumentFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: ORG_ID }),
      })
    );
    expect(mockEntityLinkFindManyFeature).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: ORG_ID }),
      })
    );
    expect(mockFeatureFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: ORG_ID }),
      })
    );
  });

  it("logs warning and skips github_pull_requests creation when workstream cannot be resolved", async () => {
    const link = makeExternalLink({
      id: "link-no-ws-3",
      workstreamId: null,
      metadata: null,
    });
    const mockPrCreate = vi.fn();
    const mockEntityLinkFindMany = vi.fn().mockResolvedValue([]);

    setupStampAndRepo(
      link,
      { id: "repo-uuid-4", installation: { installationId: "install-4" } },
      [
        // resolveWorkstreamId call 1: entityLink.findMany → returns empty (no parent links)
        (cb: any) =>
          cb({
            entityLink: {
              findMany: mockEntityLinkFindMany,
            },
          }),
      ]
    );

    mockGetSinglePullRequest.mockResolvedValueOnce(makeFreshPr());

    mockWithDb.tx.mockImplementationOnce((cb: any) =>
      cb({
        externalLink: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        gitHubPullRequest: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: mockPrCreate,
          updateMany: vi.fn(),
        },
      })
    );

    await runRepair([link]);

    // workstreamId is null and repositoryId is non-null — the guard in
    // applyPullRequestUpsert must log a warning and return without creating
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "GitHubPullRequest row not found and cannot backfill"
      ),
      expect.objectContaining({ workstreamId: null })
    );
    expect(mockPrCreate).not.toHaveBeenCalled();
    expect(mockEntityLinkFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: ORG_ID }),
      })
    );
  });

  it("does not throw on P2002 unique constraint violation (concurrent insert dedup)", async () => {
    const link = makeExternalLink({
      workstreamId: "ws-uuid-1",
      metadata: null,
    });
    const p2002Error = Object.assign(new Error("Unique constraint"), {
      code: "P2002",
    });
    const mockPrCreate = vi.fn().mockRejectedValue(p2002Error);

    setupStampAndRepo(link, {
      id: "repo-uuid-5",
      installation: { installationId: "install-5" },
    });

    mockGetSinglePullRequest.mockResolvedValueOnce(makeFreshPr());

    mockWithDb.tx.mockImplementationOnce((cb: any) =>
      cb({
        externalLink: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        gitHubPullRequest: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: mockPrCreate,
          updateMany: vi.fn(),
        },
      })
    );

    // Must not throw — P2002 is silently swallowed as a concurrent-insert dedup
    await expect(runRepair([link])).resolves.toBeUndefined();
    expect(mockPrCreate).toHaveBeenCalledOnce();
  });

  it("fixes null workstream_id on external link by writing resolved workstreamId", async () => {
    // link.workstreamId is null — after resolveWorkstreamId resolves it from artifact,
    // applyExternalLinkUpdate should include workstreamId in the updateMany data
    const link = makeExternalLink({
      id: "link-ws-fix",
      workstreamId: null,
      metadata: null,
    });
    const mockExternalLinkUpdateMany = vi.fn().mockResolvedValue({ count: 1 });

    setupStampAndRepo(
      link,
      { id: "repo-uuid-6", installation: { installationId: "install-6" } },
      [
        // resolveWorkstreamId call 1: entityLink.findMany (parent links)
        (cb: any) =>
          cb({
            entityLink: {
              findMany: vi.fn().mockResolvedValue([
                {
                  sourceId: "artifact-uuid-3",
                  sourceType: EntityType.Document,
                },
              ]),
            },
          }),
        // resolveWorkstreamId call 2: document.findFirst
        (cb: any) =>
          cb({
            document: {
              findFirst: vi.fn().mockResolvedValue({
                workstreamId: "ws-resolved",
              }),
            },
          }),
      ]
    );

    mockGetSinglePullRequest.mockResolvedValueOnce(makeFreshPr());

    mockWithDb.tx.mockImplementationOnce((cb: any) =>
      cb({
        externalLink: { updateMany: mockExternalLinkUpdateMany },
        gitHubPullRequest: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({}),
          updateMany: vi.fn(),
        },
      })
    );

    await runRepair([link]);

    // applyExternalLinkUpdate: link.workstreamId === null and workstreamId !== null
    // → must include workstreamId in the update
    expect(mockExternalLinkUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workstreamId: "ws-resolved",
        }),
      })
    );
  });

  it("correctly resolves repositoryId from installation repositories via resolveRepositoryId", async () => {
    const link = makeExternalLink({
      externalUrl: "https://github.com/acme/target-repo/pull/7",
      workstreamId: "ws-uuid-1",
      metadata: null,
    });
    const mockRepoFindFirst = vi.fn().mockResolvedValue({
      id: "repo-uuid-target",
      installation: { installationId: "install-target" },
    });
    const mockPrCreate = vi.fn().mockResolvedValue({});

    // Call 1: stamp
    mockWithDb.mockImplementationOnce((cb: any) =>
      cb({
        externalLink: {
          update: vi.fn().mockResolvedValue({ metadata: {} }),
        },
      })
    );
    // Call 2: resolveRepositoryId with fullName "acme/target-repo"
    mockWithDb.mockImplementationOnce((cb: any) =>
      cb({
        gitHubInstallationRepository: { findFirst: mockRepoFindFirst },
      })
    );

    mockGetSinglePullRequest.mockResolvedValueOnce(
      makeFreshPr({ githubId: "gh-pr-target", number: 7 })
    );

    mockWithDb.tx.mockImplementationOnce((cb: any) =>
      cb({
        externalLink: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        gitHubPullRequest: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: mockPrCreate,
          updateMany: vi.fn(),
        },
      })
    );

    await runRepair([link]);

    // resolveRepositoryId must have queried with fullName scoped to org
    expect(mockRepoFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          fullName: "acme/target-repo",
          installation: { organizationId: ORG_ID },
        },
      })
    );
    // The create must have used the resolved repositoryId
    expect(mockPrCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ repositoryId: "repo-uuid-target" }),
      })
    );
  });

  it("memoizes repositoryId across two links for the same repo (only one DB lookup)", async () => {
    // Two links for the same owner/repo — resolveRepositoryId should only
    // call gitHubInstallationRepository.findFirst once; the second link hits the cache.
    const linkA = makeExternalLink({
      id: "link-a",
      externalUrl: "https://github.com/acme/shared-repo/pull/10",
      workstreamId: "ws-uuid-1",
      metadata: null,
    });
    const linkB = makeExternalLink({
      id: "link-b",
      externalUrl: "https://github.com/acme/shared-repo/pull/11",
      workstreamId: "ws-uuid-1",
      metadata: null,
    });

    const mockRepoFindFirst = vi.fn().mockResolvedValue({
      id: "repo-uuid-shared",
      installation: { installationId: "install-shared" },
    });

    // Link A: stamp + resolveRepositoryId (DB hit)
    mockWithDb
      .mockImplementationOnce((cb: any) =>
        cb({
          externalLink: { update: vi.fn().mockResolvedValue({ metadata: {} }) },
        })
      )
      .mockImplementationOnce((cb: any) =>
        cb({ gitHubInstallationRepository: { findFirst: mockRepoFindFirst } })
      );

    // Link B: stamp only — resolveRepositoryId should use cache, no second DB call
    mockWithDb.mockImplementationOnce((cb: any) =>
      cb({
        externalLink: { update: vi.fn().mockResolvedValue({ metadata: {} }) },
      })
    );

    // getSinglePullRequest for both links
    mockGetSinglePullRequest
      .mockResolvedValueOnce(makeFreshPr({ githubId: "gh-pr-10", number: 10 }))
      .mockResolvedValueOnce(makeFreshPr({ githubId: "gh-pr-11", number: 11 }));

    // tx for link A
    mockWithDb.tx
      .mockImplementationOnce((cb: any) =>
        cb({
          externalLink: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
          gitHubPullRequest: {
            findFirst: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue({}),
            updateMany: vi.fn(),
          },
        })
      )
      // tx for link B
      .mockImplementationOnce((cb: any) =>
        cb({
          externalLink: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
          gitHubPullRequest: {
            findFirst: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue({}),
            updateMany: vi.fn(),
          },
        })
      );

    await runRepair([linkA, linkB]);

    // The repo findFirst DB call must have been invoked exactly once (cache hit on link B)
    expect(mockRepoFindFirst).toHaveBeenCalledOnce();
  });
});
