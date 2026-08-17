/**
 * Eligibility filtering for the PR read-repair scheduler: which stale
 * PullRequestDetail rows earn a background repair pass, and what the
 * client-visible pending status is while one is in flight.
 *
 * The repair pass itself (client resolution, relink, stamping, backfill) is
 * covered by pr-read-repair.test.ts.
 */

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
  };
});

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { BranchViewPrLifecycleRepairStatus } from "@repo/api/src/types/branch-view";
import { GitHubPRState } from "@repo/api/src/types/github";
import { waitUntil } from "@vercel/functions";
import {
  getPrReadRepairStatus,
  schedulePrReadRepair,
} from "@/lib/pr-read-repair";
import {
  makePrReadRepairInput as makeInput,
  PR_READ_REPAIR_ORG_ID as ORG_ID,
} from "../utils/pr-read-repair-fixtures";

const mockWaitUntil = vi.mocked(waitUntil);

/** 24 hours + 1ms — past the staleness threshold */
const STALE_MS = 24 * 60 * 60 * 1000 + 1;

function msAgo(ms: number): Date {
  return new Date(Date.now() - ms);
}

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
