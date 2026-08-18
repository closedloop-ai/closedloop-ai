import { StatusCheckRollupFailureReason } from "@repo/api/src/types/github";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
  GitHubSyncResultReason,
} from "@repo/api/src/types/github-read-model";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockClaimDueCheckRunRetries,
  mockClearCheckRunRetry,
  mockDiscardCheckRunRetry,
  mockGetInstallationOctokit,
  mockOctokit,
  mockPersistBranchStatusChecksFromRollup,
  mockQueryStatusCheckRollupWithProviderResult,
  mockSettleRetryableCheckRunFailure,
  mockWithDbTx,
} = vi.hoisted(() => ({
  mockClaimDueCheckRunRetries: vi.fn(),
  mockClearCheckRunRetry: vi.fn(),
  mockDiscardCheckRunRetry: vi.fn(),
  mockGetInstallationOctokit: vi.fn(),
  mockOctokit: { marker: "installation-octokit" },
  mockPersistBranchStatusChecksFromRollup: vi.fn(),
  mockQueryStatusCheckRollupWithProviderResult: vi.fn(),
  mockSettleRetryableCheckRunFailure: vi.fn(),
  mockWithDbTx: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: { tx: mockWithDbTx },
}));

vi.mock("@repo/github", () => {
  return {
    GitHubProviderResultStatus: {
      Success: "success",
      ProviderRateLimit: "provider_rate_limit",
      ProviderUnavailable: "provider_unavailable",
    },
    queryStatusCheckRollupWithProviderResult:
      mockQueryStatusCheckRollupWithProviderResult,
    // Real classifier so the mint-failure test pins the production
    // rate-limit-vs-unavailable classification.
  };
});

vi.mock("@repo/github/installation-auth", () => ({
  // Spy wrapper (not a bare vi.fn implementation) so restore/reset passes can
  // never strip the marker client the drain threads into the rollup query.
  // Mint-failure tests inject a one-shot rejection through the spy; any
  // non-undefined spy result wins over the resolved marker client fallback.
  getInstallationOctokit: (installationId: string) =>
    mockGetInstallationOctokit(installationId) ?? Promise.resolve(mockOctokit),
}));

vi.mock("@/lib/branch-status-check-retry", () => ({
  claimDueCheckRunRetries: mockClaimDueCheckRunRetries,
  clearCheckRunRetry: mockClearCheckRunRetry,
  discardCheckRunRetry: mockDiscardCheckRunRetry,
  settleRetryableCheckRunFailure: mockSettleRetryableCheckRunFailure,
}));

vi.mock("@/lib/branch-status-checks", () => ({
  persistBranchStatusChecksFromRollup: mockPersistBranchStatusChecksFromRollup,
}));

import { GitHubProviderResultStatus } from "@repo/github";
import { drainDueCheckRunRetries } from "./branch-status-check-retry-drain";

const retryClaim = {
  attempts: 1,
  branchArtifactId: "branch-1",
  headSha: "head-1",
  idempotencyKey: "repo:check-run-1:head-1:completed",
  installationId: "installation-1",
  organizationId: "org-1",
  owner: "acme",
  repo: "repo",
  repositoryId: "repo-1",
  resourceId: "check-run-1",
};

describe("drainDueCheckRunRetries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithDbTx.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn({ tx: true })
    );
    mockClaimDueCheckRunRetries.mockResolvedValue([retryClaim]);
    mockPersistBranchStatusChecksFromRollup.mockResolvedValue({
      checksStatusChanged: true,
      nextChecksStatus: "PASSING",
      previousChecksStatus: "UNKNOWN",
      status: "updated",
    });
    mockClearCheckRunRetry.mockResolvedValue("cleared");
    mockDiscardCheckRunRetry.mockResolvedValue("discarded");
    mockSettleRetryableCheckRunFailure.mockResolvedValue("retry_scheduled");
  });

  it("claims due retries, calls GitHub outside the claim transaction, and clears success", async () => {
    let inTransaction = false;
    mockWithDbTx.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      inTransaction = true;
      const result = await fn({ tx: true });
      inTransaction = false;
      return result;
    });
    mockQueryStatusCheckRollupWithProviderResult.mockImplementation(() => {
      expect(inTransaction).toBe(false);
      return Promise.resolve({
        status: GitHubProviderResultStatus.Success,
        value: {
          checks: [],
          ok: true,
          state: "SUCCESS",
          totalCount: 0,
          truncated: false,
        },
      });
    });

    const summary = await drainDueCheckRunRetries(
      new Date("2026-07-03T01:00:00Z"),
      10
    );

    expect(mockClaimDueCheckRunRetries).toHaveBeenCalledWith(
      { tx: true },
      new Date("2026-07-03T01:00:00Z"),
      10
    );
    expect(mockGetInstallationOctokit).toHaveBeenCalledWith("installation-1");
    expect(mockQueryStatusCheckRollupWithProviderResult).toHaveBeenCalledWith(
      mockOctokit,
      "acme",
      "repo",
      "head-1"
    );
    expect(mockPersistBranchStatusChecksFromRollup).toHaveBeenCalledWith(
      { tx: true },
      expect.objectContaining({
        branchArtifactId: "branch-1",
        organizationId: "org-1",
        headSha: "head-1",
        fetchProvenance: expect.objectContaining({
          credentialType: GitHubFetchCredentialType.GitHubApp,
          mechanism: GitHubFetchMechanism.Graphql,
          trigger: GitHubFetchTrigger.Webhook,
          observedAt: expect.any(Date),
          resultReason: GitHubSyncResultReason.Success,
        }),
      })
    );
    expect(mockClearCheckRunRetry).toHaveBeenCalledWith(
      { tx: true },
      retryClaim
    );
    expect(summary).toEqual({
      claimed: 1,
      deadLettered: 0,
      discarded: 0,
      missing: 0,
      rescheduled: 0,
      succeeded: 1,
    });
  });

  it("reschedules provider rate limits with canonical retry metadata", async () => {
    const now = new Date("2026-07-03T01:00:00Z");
    mockQueryStatusCheckRollupWithProviderResult.mockResolvedValue({
      retryAfterSeconds: 45,
      status: GitHubProviderResultStatus.ProviderRateLimit,
    });

    const summary = await drainDueCheckRunRetries(now, 10);

    expect(mockSettleRetryableCheckRunFailure).toHaveBeenCalledWith(
      { tx: true },
      retryClaim,
      StatusCheckRollupFailureReason.RateLimited,
      1,
      now,
      45
    );
    expect(summary.rescheduled).toBe(1);
  });

  it("settles a claim whose installation client mint fails and keeps draining the batch", async () => {
    const now = new Date("2026-07-03T01:00:00Z");
    const secondClaim = {
      ...retryClaim,
      branchArtifactId: "branch-2",
      headSha: "head-2",
      installationId: "installation-2",
      resourceId: "check-run-2",
    };
    mockClaimDueCheckRunRetries.mockResolvedValue([retryClaim, secondClaim]);
    mockGetInstallationOctokit.mockImplementationOnce(() =>
      Promise.reject(new Error("token exchange failed"))
    );
    mockQueryStatusCheckRollupWithProviderResult.mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: {
        checks: [],
        ok: true,
        state: "SUCCESS",
        totalCount: 0,
        truncated: false,
      },
    });

    const summary = await drainDueCheckRunRetries(now, 10);

    // The failed mint settles its own claim as a provider failure...
    expect(mockSettleRetryableCheckRunFailure).toHaveBeenCalledWith(
      { tx: true },
      retryClaim,
      StatusCheckRollupFailureReason.GraphqlError,
      1,
      now,
      null
    );
    // ...and the batch continues: the second claim still reads and clears.
    expect(mockQueryStatusCheckRollupWithProviderResult).toHaveBeenCalledWith(
      mockOctokit,
      "acme",
      "repo",
      "head-2"
    );
    expect(mockClearCheckRunRetry).toHaveBeenCalledWith(
      { tx: true },
      secondClaim
    );
    expect(summary).toEqual({
      claimed: 2,
      deadLettered: 0,
      discarded: 0,
      missing: 0,
      rescheduled: 1,
      succeeded: 1,
    });
  });

  it("discards exact retry metadata when the branch becomes stale before persistence", async () => {
    mockQueryStatusCheckRollupWithProviderResult.mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: {
        checks: [],
        ok: true,
        state: "SUCCESS",
        totalCount: 0,
        truncated: false,
      },
    });
    mockPersistBranchStatusChecksFromRollup.mockResolvedValue({
      reason: "missing_or_stale_branch",
      status: "skipped",
    });

    const summary = await drainDueCheckRunRetries();

    expect(mockDiscardCheckRunRetry).toHaveBeenCalledWith(
      { tx: true },
      retryClaim
    );
    expect(summary.discarded).toBe(1);
  });

  it("reports dead-letter settlements at the retry ceiling", async () => {
    mockQueryStatusCheckRollupWithProviderResult.mockResolvedValue({
      retryAfterSeconds: null,
      status: GitHubProviderResultStatus.ProviderRateLimit,
    });
    mockSettleRetryableCheckRunFailure.mockResolvedValue("dead_letter");

    const summary = await drainDueCheckRunRetries();

    expect(summary.deadLettered).toBe(1);
    expect(summary.rescheduled).toBe(0);
  });
});
