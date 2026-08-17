import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule({
    ChecksStatus: { UNKNOWN: "UNKNOWN" },
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

const installationAuthMocks = vi.hoisted(() => ({
  getInstallationOctokit: vi.fn(),
}));

vi.mock("@repo/github/installation-auth", () => ({
  getInstallationOctokit: installationAuthMocks.getInstallationOctokit,
}));

const INSTALLATION_OCTOKIT = { marker: "installation-octokit" };

vi.mock("@/app/integrations/github/sync-service", () => ({
  GitHubServerSyncReason: {
    AlreadyRefreshing: "already_refreshing",
    CredentialDecryptionFailed: "credential_decryption_failed",
    CredentialExpired: "credential_expired",
    CredentialInsufficientScope: "credential_insufficient_scope",
    CredentialRevoked: "credential_revoked",
    CrossUserDenied: "cross_user_denied",
    GuardedWriteFailed: "guarded_write_failed",
    InvalidRepositoryFullName: "invalid_repository_full_name",
    NoActiveRepository: "no_active_repository",
    NoCredential: "no_credential",
    NoCurrentPullRequest: "no_current_pull_request",
    NoEligibleSessionReference: "no_eligible_session_reference",
    NoTombstonedRepository: "no_tombstoned_repository",
    ProviderRateLimited: "provider_rate_limited",
    ProviderUnavailable: "provider_unavailable",
    Success: "success",
    Unsupported: "unsupported",
    Unknown: "unknown",
  },
  GitHubServerSyncStatus: {
    Failed: "failed",
    NotApplicable: "not_applicable",
    Refreshed: "refreshed",
    Retryable: "retryable",
  },
  githubServerSyncService: {
    refreshTombstonedBranchPullRequest: vi.fn(),
  },
}));

vi.mock("@/app/agent-sessions/service", () => ({
  agentSessionsService: {
    findSessionDetail: vi.fn(),
  },
}));

import {
  BranchRefreshReason,
  BranchRefreshStatus,
} from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github";
import {
  GitHubProviderResultStatus,
  GitHubUserTokenProviderResultStatus,
  getSinglePullRequestWithProviderResult,
} from "@repo/github";
import {
  branchId,
  createMockDb,
  makeBranchRow,
  mockBranchCandidateIds,
  now,
  organizationId,
} from "@/__tests__/support/branches/branch-read-service.test-helpers";
import { mockWithDbCall, mockWithDbTx } from "../../__tests__/utils/db-helpers";
import { branchReadService } from "./branch-read-service";

describe("branchReadService refresh eligibility", () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mockDb = createMockDb();
    mockWithDbCall(mockDb);
    mockWithDbTx(mockDb);
    mockDb.commitDetail.findMany.mockResolvedValue([]);
    installationAuthMocks.getInstallationOctokit.mockResolvedValue(
      INSTALLATION_OCTOKIT
    );
  });

  it("returns provider rate-limit as retryable without exposing a newly ineligible DTO", async () => {
    mockBranchCandidateIds(mockDb, [branchId]);
    mockDb.$queryRaw.mockResolvedValueOnce([]);
    mockDb.artifact.findFirst.mockResolvedValue(makeBranchRow());
    mockDb.oAuthRateLimit.findUnique.mockResolvedValue(null);
    mockDb.oAuthRateLimit.create.mockResolvedValue({});
    mockDb.pullRequestDetail.updateMany.mockResolvedValueOnce({ count: 1 });
    vi.mocked(getSinglePullRequestWithProviderResult).mockResolvedValue({
      status: GitHubProviderResultStatus.ProviderRateLimit,
      retryAfterSeconds: 45,
    });

    const response = await branchReadService.refreshBranch(
      organizationId,
      branchId,
      { userId: "user-1", authMethod: "session" }
    );

    expect(response).toMatchObject({
      status: BranchRefreshStatus.Retryable,
      reason: BranchRefreshReason.ProviderRateLimited,
      retryAfterSeconds: 45,
      branch: null,
    });
    expect(mockDb.pullRequestDetail.updateMany).toHaveBeenCalledTimes(1);
    expect(mockDb.artifact.updateMany).not.toHaveBeenCalled();
    expect(mockDb.branchDetail.updateMany).not.toHaveBeenCalled();
    expect(mockDb.$queryRaw).toHaveBeenCalledTimes(2);
    expect(mockDb.branchStatusCheck.deleteMany).not.toHaveBeenCalled();
  });

  it("returns provider unavailable as retryable without exposing a newly ineligible DTO", async () => {
    mockBranchCandidateIds(mockDb, [branchId]);
    mockDb.$queryRaw.mockResolvedValueOnce([]);
    mockDb.artifact.findFirst.mockResolvedValue(makeBranchRow());
    mockDb.oAuthRateLimit.findUnique.mockResolvedValue(null);
    mockDb.oAuthRateLimit.create.mockResolvedValue({});
    mockDb.pullRequestDetail.updateMany.mockResolvedValueOnce({ count: 1 });
    vi.mocked(getSinglePullRequestWithProviderResult).mockResolvedValue({
      status: GitHubProviderResultStatus.ProviderUnavailable,
    });

    const response = await branchReadService.refreshBranch(
      organizationId,
      branchId,
      { userId: "user-1", authMethod: "session" }
    );

    expect(response).toMatchObject({
      status: BranchRefreshStatus.Retryable,
      reason: BranchRefreshReason.ProviderUnavailable,
      branch: null,
    });
    expect(mockDb.pullRequestDetail.updateMany).toHaveBeenCalledTimes(1);
    expect(mockDb.artifact.updateMany).not.toHaveBeenCalled();
    expect(mockDb.branchDetail.updateMany).not.toHaveBeenCalled();
    expect(mockDb.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it("reports a credential fault on the installation lane as retryable provider unavailable, never a reconnect prompt", async () => {
    // refreshBranch reads through the GitHub App's own installation
    // credential, so a credential-scope fault is not something the viewer can
    // fix by reconnecting their account. The user-token credential statuses
    // must stay folded into the generic provider-unavailable outcome here.
    mockBranchCandidateIds(mockDb, [branchId]);
    mockDb.$queryRaw.mockResolvedValueOnce([]);
    mockDb.artifact.findFirst.mockResolvedValue(makeBranchRow());
    mockDb.oAuthRateLimit.findUnique.mockResolvedValue(null);
    mockDb.oAuthRateLimit.create.mockResolvedValue({});
    mockDb.pullRequestDetail.updateMany.mockResolvedValueOnce({ count: 1 });
    vi.mocked(getSinglePullRequestWithProviderResult).mockResolvedValue({
      status: GitHubUserTokenProviderResultStatus.CredentialInsufficientScope,
    });

    const response = await branchReadService.refreshBranch(
      organizationId,
      branchId,
      { userId: "user-1", authMethod: "session" }
    );

    expect(response).toMatchObject({
      status: BranchRefreshStatus.Retryable,
      reason: BranchRefreshReason.ProviderUnavailable,
      branch: null,
    });
    expect(response.reason).not.toBe(
      BranchRefreshReason.GitHubIdentityInsufficientScope
    );
    expect(mockDb.artifact.updateMany).not.toHaveBeenCalled();
    expect(mockDb.branchDetail.updateMany).not.toHaveBeenCalled();
    expect(mockDb.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it("returns null when refreshed authority makes the branch the repository default", async () => {
    mockBranchCandidateIds(mockDb, [branchId]);
    mockDb.$queryRaw.mockResolvedValueOnce([]);
    mockDb.artifact.findFirst.mockResolvedValue(makeBranchRow());
    mockDb.oAuthRateLimit.findUnique.mockResolvedValue(null);
    mockDb.oAuthRateLimit.create.mockResolvedValue({});
    mockDb.pullRequestDetail.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    vi.mocked(getSinglePullRequestWithProviderResult).mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: {
        githubId: "pr-gh-1",
        number: 7,
        title: "Refresh me",
        htmlUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/7",
        headBranch: "main",
        baseBranch: "main",
        state: GitHubPRState.Open,
        createdAt: "2026-07-03T04:00:00.000Z",
        mergedAt: null,
        closedAt: null,
        authorLogin: "octocat",
        isDraft: false,
        headSha: "def",
        baseSha: "abc",
        mergeCommitSha: null,
      },
    });

    const response = await branchReadService.refreshBranch(
      organizationId,
      branchId,
      { userId: "user-1", authMethod: "session" }
    );

    expect(response).toMatchObject({
      status: BranchRefreshStatus.Refreshed,
      branch: null,
    });
    expect(mockDb.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it("does no provider work when the initial canonical eligibility gate fails", async () => {
    mockDb.$queryRaw.mockResolvedValueOnce([]);

    const response = await branchReadService.refreshBranch(
      organizationId,
      branchId,
      { userId: "user-1", authMethod: "session" }
    );

    expect(response).toMatchObject({
      status: BranchRefreshStatus.Failed,
      reason: BranchRefreshReason.NotFound,
      branch: null,
    });
    expect(mockDb.artifact.findFirst).not.toHaveBeenCalled();
    expect(mockDb.oAuthRateLimit.findUnique).not.toHaveBeenCalled();
    expect(installationAuthMocks.getInstallationOctokit).not.toHaveBeenCalled();
    expect(getSinglePullRequestWithProviderResult).not.toHaveBeenCalled();
  });
});
