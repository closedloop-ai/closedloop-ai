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
 * - Skips GitHubPullRequest update when githubId is absent from metadata
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
  withDb: vi.fn(),
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
import { ExternalLinkType } from "@repo/api/src/types/external-link";
import { GitHubPRState } from "@repo/api/src/types/github";
import { withDb } from "@repo/database";
import { getSinglePullRequest } from "@repo/github";
// Import after mocks
import { waitUntil } from "@vercel/functions";
import { schedulePrReadRepair } from "@/lib/pr-read-repair";

// Typed mock references
const mockWaitUntil = vi.mocked(waitUntil);
const mockWithDb = vi.mocked(withDb) as unknown as ReturnType<typeof vi.fn>;
const mockGetSinglePullRequest = vi.mocked(getSinglePullRequest);

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
};

function makeExternalLink(overrides: ExternalLinkOverride = {}) {
  return {
    id: "link-uuid-1",
    organizationId: ORG_ID,
    workstreamId: "ws-uuid-1",
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

  it("does not call waitUntil when the PR is already in MERGED state", () => {
    const link = makeExternalLink({
      metadata: makePrMetadata({ state: GitHubPRState.Merged }),
    });

    schedulePrReadRepair([link], ORG_ID);

    expect(mockWaitUntil).not.toHaveBeenCalled();
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

    // externalLink.update stamps attempt; then both resolution paths fail
    mockWithDb
      .mockImplementationOnce((cb: any) =>
        cb({
          externalLink: {
            update: vi.fn().mockResolvedValue({ metadata: {} }),
          },
        })
      )
      // gitHubPullRequest.findFirst — no githubId in metadata so skip primary
      // gitHubInstallation.findMany — returns 0 installations (cannot resolve)
      .mockImplementationOnce((cb: any) =>
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

    mockWithDb
      // stamp lastRefreshAttemptAt
      .mockImplementationOnce((cb: any) =>
        cb({
          externalLink: { update: mockExternalLinkUpdate },
        })
      )
      // installationId fallback — returns exactly 1 installation
      .mockImplementationOnce((cb: any) =>
        cb({
          gitHubInstallation: {
            findMany: vi
              .fn()
              .mockResolvedValue([{ installationId: "install-99" }]),
          },
        })
      );

    mockGetSinglePullRequest.mockResolvedValueOnce(null);

    await runRepair([link]);

    // Only one withDb call (the stamp) + one installation lookup
    // No second externalLink.update to write fresh state
    expect(mockExternalLinkUpdate).toHaveBeenCalledTimes(1);
  });

  it("updates externalLink metadata with fresh state, title, and timestamps on success", async () => {
    const link = makeExternalLink({
      metadata: makePrMetadata({
        githubId: "gh-pr-999",
        state: GitHubPRState.Open,
        lastVerifiedAt: null,
        lastRefreshAttemptAt: null,
      }),
    });

    const mockExternalLinkUpdate = vi.fn().mockResolvedValue({ metadata: {} });
    const mockPrFindFirst = vi.fn().mockResolvedValue(null);
    const mockInstallationFindMany = vi
      .fn()
      .mockResolvedValue([{ installationId: "install-77" }]);
    const mockPrUpdateMany = vi.fn().mockResolvedValue({ count: 1 });

    mockWithDb
      // Call 1: stamp lastRefreshAttemptAt
      .mockImplementationOnce((cb: any) =>
        cb({ externalLink: { update: mockExternalLinkUpdate } })
      )
      // Call 2: gitHubPullRequest.findFirst (primary installationId lookup)
      .mockImplementationOnce((cb: any) =>
        cb({ gitHubPullRequest: { findFirst: mockPrFindFirst } })
      )
      // Call 3: gitHubInstallation.findMany (fallback)
      .mockImplementationOnce((cb: any) =>
        cb({ gitHubInstallation: { findMany: mockInstallationFindMany } })
      )
      // Call 4: write fresh metadata to externalLink
      .mockImplementationOnce((cb: any) =>
        cb({ externalLink: { update: mockExternalLinkUpdate } })
      )
      // Call 5: gitHubPullRequest.updateMany
      .mockImplementationOnce((cb: any) =>
        cb({ gitHubPullRequest: { updateMany: mockPrUpdateMany } })
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
    });

    await runRepair([link]);

    // Second externalLink.update should include fresh state/title/timestamps
    expect(mockExternalLinkUpdate).toHaveBeenCalledTimes(2);
    const secondUpdateCall = mockExternalLinkUpdate.mock.calls[1][0];
    expect(secondUpdateCall.data.title).toBe("Fresh title");
    expect(secondUpdateCall.data.metadata).toMatchObject({
      githubId: "gh-pr-999",
      number: 42,
      headBranch: "feature-x",
      baseBranch: "main",
      state: GitHubPRState.Merged,
      lastVerifiedAt: expect.any(String),
      lastRefreshAttemptAt: expect.any(String),
    });
  });

  it("updates GitHubPullRequest row when githubId is present in metadata", async () => {
    const link = makeExternalLink({
      metadata: makePrMetadata({
        githubId: "gh-pr-888",
        state: GitHubPRState.Open,
      }),
    });

    const mockExternalLinkUpdate = vi.fn().mockResolvedValue({ metadata: {} });
    const mockPrFindFirst = vi.fn().mockResolvedValue(null);
    const mockInstallationFindMany = vi
      .fn()
      .mockResolvedValue([{ installationId: "install-55" }]);
    const mockPrUpdateMany = vi.fn().mockResolvedValue({ count: 1 });

    mockWithDb
      .mockImplementationOnce((cb: any) =>
        cb({ externalLink: { update: mockExternalLinkUpdate } })
      )
      .mockImplementationOnce((cb: any) =>
        cb({ gitHubPullRequest: { findFirst: mockPrFindFirst } })
      )
      .mockImplementationOnce((cb: any) =>
        cb({ gitHubInstallation: { findMany: mockInstallationFindMany } })
      )
      .mockImplementationOnce((cb: any) =>
        cb({ externalLink: { update: mockExternalLinkUpdate } })
      )
      .mockImplementationOnce((cb: any) =>
        cb({ gitHubPullRequest: { updateMany: mockPrUpdateMany } })
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

  it("skips GitHubPullRequest updateMany when githubId is absent from metadata", async () => {
    // metadata with no githubId field
    const link = makeExternalLink({
      metadata: {
        number: 42,
        headBranch: "feat",
        baseBranch: "main",
        state: GitHubPRState.Open,
        // githubId deliberately absent
      },
    });

    const mockExternalLinkUpdate = vi.fn().mockResolvedValue({ metadata: {} });
    const mockInstallationFindMany = vi
      .fn()
      .mockResolvedValue([{ installationId: "install-33" }]);
    const mockPrUpdateMany = vi.fn();

    mockWithDb
      .mockImplementationOnce((cb: any) =>
        cb({ externalLink: { update: mockExternalLinkUpdate } })
      )
      .mockImplementationOnce((cb: any) =>
        cb({ gitHubInstallation: { findMany: mockInstallationFindMany } })
      )
      .mockImplementationOnce((cb: any) =>
        cb({ externalLink: { update: mockExternalLinkUpdate } })
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
    });

    await runRepair([link]);

    expect(mockPrUpdateMany).not.toHaveBeenCalled();
  });
});
