import { GITHUB_BUNDLED_PULL_REQUESTS_DEFAULT_PAGE_SIZE } from "@repo/api/src/github-read-model";
import { GitHubCredentialKind } from "@repo/api/src/types/github";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/database")>()),
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@repo/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/github")>()),
  queryBundledPullRequestsWithProviderResult: vi.fn(),
}));

vi.mock("@/lib/github/github-sync-client-pool", () => ({
  getGitHubSyncClient: vi.fn(),
}));

vi.mock("../reconcile-projection-write", () => ({
  resolveReconcileTargets: vi.fn().mockResolvedValue(new Map()),
  writeReconciledPullRequest: vi.fn(),
  writeReconciledPullRequestFailures: vi.fn().mockResolvedValue(0),
}));

vi.mock("@/lib/github/github-repo-sync-state", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/github/github-repo-sync-state")
  >()),
  classifyRepoSyncTier: vi.fn(),
}));

vi.mock("@/lib/github/installation-repository-lookup", () => ({
  findInstallationRepositoryId: vi.fn(),
}));

import { withDb } from "@repo/database";
import {
  GitHubProviderResultStatus,
  queryBundledPullRequestsWithProviderResult,
} from "@repo/github";
import { getGitHubSyncClient } from "@/lib/github/github-sync-client-pool";
import { findInstallationRepositoryId } from "@/lib/github/installation-repository-lookup";
import {
  RECONCILE_MAX_ITEMS,
  RECONCILE_MAX_PAGES,
  reconcileRepo,
} from "../repo-reconciler";

/**
 * ISS-7891: the page size and the page budget are one decision.
 *
 * The page shrank to survive GitHub's ~10s GraphQL execution budget, and the
 * page count grew to keep a tick's coverage from collapsing with it. Changing
 * either alone silently breaks the other half: a bigger page re-crosses the
 * budget and every sweep 502s, a smaller budget quarters the backlog drain and
 * nothing fails loudly.
 */

const mockWithDb = withDb as unknown as ReturnType<typeof vi.fn> & {
  tx: ReturnType<typeof vi.fn>;
};
const mockGetClient = getGitHubSyncClient as unknown as ReturnType<
  typeof vi.fn
>;
const mockQuery =
  queryBundledPullRequestsWithProviderResult as unknown as ReturnType<
    typeof vi.fn
  >;
const mockFindInstallationRepositoryId =
  findInstallationRepositoryId as unknown as ReturnType<typeof vi.fn>;

const NOW = new Date("2026-08-24T12:00:00.000Z");
const INPUT = {
  organizationId: "org-1",
  repositoryFullName: "acme/widgets",
  watermark: null,
  cursor: null,
  consecutiveFailureCount: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockWithDb.mockImplementation((fn: (client: unknown) => unknown) =>
    fn({
      pullRequestDetail: {
        findMany: vi.fn(() => Promise.resolve([])),
        updateManyAndReturn: vi.fn(() => Promise.resolve([])),
      },
      // ISS-12034: the coverage-gap arm's raw read.
      $queryRaw: vi.fn(() => Promise.resolve([])),
      gitHubRepoSyncState: {
        updateMany: vi.fn(() => Promise.resolve({ count: 1 })),
      },
    })
  );
  mockWithDb.tx.mockImplementation((fn: (client: unknown) => unknown) =>
    fn({
      pullRequestDetail: {
        findMany: vi.fn(() => Promise.resolve([])),
        updateManyAndReturn: vi.fn(() => Promise.resolve([])),
      },
      $queryRaw: vi.fn(() => Promise.resolve([])),
    })
  );
  mockFindInstallationRepositoryId.mockResolvedValue(null);
  mockGetClient.mockResolvedValue({
    ok: true,
    value: {
      octokit: {},
      kind: GitHubCredentialKind.Installation,
      actingAs: { installationId: "inst-1" },
      credentialOwnerId: null,
      rateLimitTier: null,
      recordRateLimit: vi.fn(() => Promise.resolve()),
      recordRepoAccess: vi.fn(() => Promise.resolve()),
    },
  });
  mockQuery.mockResolvedValue({
    status: GitHubProviderResultStatus.Success,
    value: { pullRequests: [], truncated: false, nextCursor: null },
  });
});

describe("reconcile page budget", () => {
  it("asks the provider for the whole per-tick budget", async () => {
    await reconcileRepo(INPUT, { now: NOW });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.anything(),
      "acme",
      "widgets",
      expect.anything(),
      {
        after: null,
        maxItems: RECONCILE_MAX_ITEMS,
        maxPages: RECONCILE_MAX_PAGES,
        includeStatusCheckRollup: false,
      },
      expect.anything(),
      expect.anything()
    );
  });

  it("budgets exactly the pages the default page size needs to reach maxItems", () => {
    // The coupling itself: a page size raised back toward GitHub's 100 ceiling,
    // or a page count trimmed, leaves a tick unable to cover the items it
    // claims to — and nothing else in the suite notices.
    expect(
      RECONCILE_MAX_PAGES * GITHUB_BUNDLED_PULL_REQUESTS_DEFAULT_PAGE_SIZE
    ).toBe(RECONCILE_MAX_ITEMS);
  });
});
