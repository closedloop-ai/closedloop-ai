/**
 * The backfill STATUS SURFACE: what `getLatestBackfillSummary` reports about a
 * run, as opposed to what a run does. Split from `backfill-service.test.ts`
 * (ISS-7408) when that file reached the 1000-line ceiling — these cases need
 * only the settings read, not the provider sweep harness, so they carry their
 * own much smaller mock set.
 *
 * This surface became load-bearing when the Apply route stopped blocking: it is
 * the only thing a client polls to learn a backfill finished.
 */

import { GitHubBackfillStatus } from "@repo/api/src/types/github";
import {
  GitHubCommentThreadKind,
  PullRequestCommentLane,
  PullRequestCommentLaneStatus,
} from "@repo/database/generated/enums";
import { beforeEach, describe, expect, it, vi } from "vitest";

const organizationFindUniqueMock = vi.fn();

vi.mock("@repo/database", () => ({
  GitHubCommentThreadKind,
  PullRequestCommentLane,
  PullRequestCommentLaneStatus,

  ArtifactType: { BRANCH: "BRANCH" },
  GitHubInstallationStatus: { ACTIVE: "ACTIVE" },
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings: [...strings],
      text: strings.join("?"),
      values,
    }),
  },
  withDb: Object.assign(
    (callback: (db: unknown) => unknown) =>
      callback({
        gitHubInstallationRepository: { findMany: vi.fn() },
        artifact: { findMany: vi.fn() },
        organization: { findUnique: organizationFindUniqueMock },
      }),
    {
      tx: (callback: (db: unknown) => unknown) =>
        callback({
          $executeRaw: vi.fn(),
          organization: {
            findUnique: organizationFindUniqueMock,
            update: vi.fn(),
          },
        }),
    }
  ),
}));

vi.mock("@repo/github", () => ({
  GitHubProviderResultStatus: { Success: "success" },
  listPullRequestIssueCommentsWithProviderResult: vi.fn(),
  listPullRequestReviewCommentsWithProviderResult: vi.fn(),
  listPullRequestReviewsWithProviderResult: vi.fn(),
  queryBundledPullRequestsWithProviderResult: vi.fn(),
  queryStatusCheckRollupWithProviderResult: vi.fn(),
}));

vi.mock("./backfill-projection-writer", () => ({
  githubBackfillProjectionWriter: { diff: vi.fn(), write: vi.fn() },
}));

vi.mock("./service", () => ({
  githubService: { getBranches: vi.fn(), getPullRequests: vi.fn() },
}));

const {
  BACKFILL_RUN_GATE_SETTINGS_KEY,
  BACKFILL_SETTINGS_KEY,
  githubBackfillService,
} = await import("./backfill-service");

describe("githubBackfillService status surface", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the latest persisted summary without provider calls", async () => {
    organizationFindUniqueMock.mockResolvedValueOnce({
      settings: {
        [BACKFILL_SETTINGS_KEY]: persistedSummary({
          status: GitHubBackfillStatus.Degraded,
          repositoryCount: 1,
          branchCount: 2,
          pullRequestCount: 3,
          statusCheckProjectionChangeCount: 12,
          dryRun: true,
          ownerApprovalRequired: true,
          failures: ["repo:provider_rate_limit"],
        }),
      },
    });

    const summary =
      await githubBackfillService.getLatestBackfillSummary("org-1");

    expect(summary.repositoryCount).toBe(1);
    expect(summary.failures).toEqual(["repo:provider_rate_limit"]);
    expect(summary.statusCheckProjectionChangeCount).toBe(12);
    expect(summary.lifecycleAtomProjectionChangeCount).toBe(0);
    expect(summary.branchLastActivityProjectionChangeCount).toBe(0);
  });

  it("returns not_started when no latest summary has been persisted", async () => {
    organizationFindUniqueMock.mockResolvedValueOnce({ settings: {} });

    const summary =
      await githubBackfillService.getLatestBackfillSummary("org-1");

    expect(summary.status).toBe(GitHubBackfillStatus.NotStarted);
    expect(summary.repositoryCount).toBe(0);
    expect(summary.dryRun).toBe(true);
    expect(summary.issueCommentProjectionChangeCount).toBe(0);
  });

  it("reports running while the durable run gate is still in flight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T00:00:00.000Z"));
    try {
      organizationFindUniqueMock.mockResolvedValueOnce({
        settings: {
          [BACKFILL_RUN_GATE_SETTINGS_KEY]: {
            inFlightUntil: Date.now() + 60_000,
            cooldownUntil: Date.now() + 60_000,
          },
          [BACKFILL_SETTINGS_KEY]: persistedSummary({
            status: GitHubBackfillStatus.Completed,
            branchCount: 7,
          }),
        },
      });

      const summary =
        await githubBackfillService.getLatestBackfillSummary("org-1");

      // ISS-7408: the summary key is written only when a run FINISHES, so
      // without this overlay a poller started by the route's 202 would read the
      // PREVIOUS run's `completed` and stop before any new data landed.
      expect(summary.status).toBe(GitHubBackfillStatus.Running);
      // The counts stay those of the last completed run — last-known, not
      // progress. Only `status` describes the run in flight.
      expect(summary.branchCount).toBe(7);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops reporting running once the run gate lease has expired", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T00:00:00.000Z"));
    try {
      organizationFindUniqueMock.mockResolvedValueOnce({
        settings: {
          [BACKFILL_RUN_GATE_SETTINGS_KEY]: {
            inFlightUntil: Date.now() - 1,
            cooldownUntil: Date.now() - 1,
          },
          [BACKFILL_SETTINGS_KEY]: persistedSummary({
            status: GitHubBackfillStatus.Completed,
          }),
        },
      });

      const summary =
        await githubBackfillService.getLatestBackfillSummary("org-1");

      // A run killed mid-sweep leaves its lease behind. Bounding the overlay by
      // that lease is what stops the surface pinning to `running` forever and a
      // poller never terminating.
      expect(summary.status).toBe(GitHubBackfillStatus.Completed);
    } finally {
      vi.useRealTimers();
    }
  });
});

function persistedSummary(overrides: Record<string, unknown>) {
  return {
    status: GitHubBackfillStatus.Completed,
    repositoryCount: 1,
    branchCount: 2,
    pullRequestCount: 3,
    branchProjectionChangeCount: 0,
    pullRequestProjectionChangeCount: 0,
    reviewDecisionProjectionChangeCount: 0,
    checkProjectionChangeCount: 0,
    issueCommentProjectionChangeCount: 0,
    reviewCommentProjectionChangeCount: 0,
    reviewThreadProjectionChangeCount: 0,
    reviewProjectionChangeCount: 0,
    statusCheckProjectionChangeCount: 0,
    skippedBranchCount: 0,
    dryRun: false,
    ownerApprovalRequired: false,
    failures: [],
    ...overrides,
  };
}
