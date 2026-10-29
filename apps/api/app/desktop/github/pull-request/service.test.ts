import {
  DesktopGithubPullRequestContractVersion,
  DesktopGithubPullRequestErrorCode,
  DesktopGithubPullRequestMode,
  DesktopGithubPullRequestReason,
  type DesktopGithubPullRequestRequest,
  DesktopGithubPullRequestStage,
  DesktopGithubPullRequestStatus,
  DesktopGithubPullRequestSuccessMode,
} from "@repo/api/src/types/desktop-github-pull-request";
import { GitHubAccessDenialReason } from "@repo/api/src/types/github";
import type { PullRequestLabelSpec } from "@repo/api/src/types/pull-request-label";
import { PullRequestLabelSyncStatus } from "@repo/api/src/types/pull-request-label-sync-status";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveCredential: vi.fn(),
  getUserTokenOctokit: vi.fn(),
  getRepositoryDefaultBranch: vi.fn(),
  findOpenPullRequestForHeadBranch: vi.fn(),
  getPullRequest: vi.fn(),
  verifyRepositoryBranchExists: vi.fn(),
  createPullRequest: vi.fn(),
  updatePullRequest: vi.fn(),
  reconcilePullRequestLabels: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/github/github-user-credential", () => ({
  resolveGitHubUserCredential: mocks.resolveCredential,
}));

vi.mock("@repo/github/user-token-auth", () => ({
  getUserTokenOctokit: mocks.getUserTokenOctokit,
}));

vi.mock("@repo/github/pull-request-write", () => ({
  getRepositoryDefaultBranch: mocks.getRepositoryDefaultBranch,
  findOpenPullRequestForHeadBranch: mocks.findOpenPullRequestForHeadBranch,
  getPullRequest: mocks.getPullRequest,
  verifyRepositoryBranchExists: mocks.verifyRepositoryBranchExists,
  createPullRequest: mocks.createPullRequest,
  updatePullRequest: mocks.updatePullRequest,
}));

vi.mock("@repo/github/pull-request-labels", () => ({
  reconcilePullRequestLabels: mocks.reconcilePullRequestLabels,
}));

import { desktopGithubPullRequestService } from "./service";

const NOW = new Date("2026-09-10T12:00:00.000Z");
const OCTOKIT = { marker: "octokit" };

describe("desktopGithubPullRequestService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveCredential.mockResolvedValue({
      ok: true,
      credential: {
        token: "github-user-token",
        login: "daveth",
        githubUserId: "gh-user-1",
        organizationId: "org-1",
        userId: "user-1",
        scopes: ["repo"],
        connectionId: "conn-1",
        rateLimitTier: null,
        capabilities: [],
      },
    });
    mocks.getUserTokenOctokit.mockReturnValue(OCTOKIT);
    mocks.getRepositoryDefaultBranch.mockResolvedValue("main");
    mocks.findOpenPullRequestForHeadBranch.mockResolvedValue(null);
    mocks.verifyRepositoryBranchExists.mockResolvedValue(true);
    mocks.createPullRequest.mockResolvedValue({
      number: 42,
      url: "https://github.com/closedloop-ai/closedloop-ai/pull/42",
    });
    mocks.getPullRequest.mockResolvedValue({
      number: 42,
      url: "https://github.com/closedloop-ai/closedloop-ai/pull/42",
      headBranch: "feature/no-gh",
      baseBranch: "main",
    });
    mocks.updatePullRequest.mockResolvedValue({
      number: 42,
      url: "https://github.com/closedloop-ai/closedloop-ai/pull/42",
    });
    mocks.reconcilePullRequestLabels.mockResolvedValue({
      status: PullRequestLabelSyncStatus.Applied,
      createdLabels: [],
      addedLabels: ["ISS-8637"],
      droppedLabels: [],
    });
  });

  it("runs preflight with user credentials and repository access", async () => {
    const result = await desktopGithubPullRequestService.handle({
      organizationId: "org-1",
      userId: "user-1",
      now: NOW,
      request: preflightRequest(),
    });

    expect(result).toEqual({
      ok: true,
      value: {
        success: true,
        contractVersion: DesktopGithubPullRequestContractVersion,
        mode: DesktopGithubPullRequestSuccessMode.Preflight,
        status: DesktopGithubPullRequestStatus.Available,
        repository: {
          fullName: "closedloop-ai/closedloop-ai",
          defaultBranch: "main",
        },
        identity: { login: "daveth" },
      },
    });
    expect(mocks.resolveCredential).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "user-1",
      now: NOW,
      capabilityScope: {
        normalizedTargetOwner: "closedloop-ai",
        normalizedTargetRepo: "closedloop-ai",
      },
    });
    expect(mocks.getUserTokenOctokit).toHaveBeenCalledWith(
      "github-user-token",
      {}
    );
    expect(mocks.getRepositoryDefaultBranch).toHaveBeenCalledWith(OCTOKIT, {
      owner: "closedloop-ai",
      repo: "closedloop-ai",
    });
    expect(mocks.findOpenPullRequestForHeadBranch).not.toHaveBeenCalled();
  });

  it("maps missing credentials to non-retryable authentication failure", async () => {
    mocks.resolveCredential.mockResolvedValueOnce({
      ok: false,
      denial: GitHubAccessDenialReason.NotConnected,
    });

    const result = await desktopGithubPullRequestService.handle({
      organizationId: "org-1",
      userId: "user-1",
      now: NOW,
      request: preflightRequest(),
    });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        status: 401,
        code: DesktopGithubPullRequestErrorCode.AuthenticationRequired,
        reason: DesktopGithubPullRequestReason.AuthenticationRequired,
        denial: GitHubAccessDenialReason.NotConnected,
        retryable: false,
        burnRetryBudget: false,
      }),
    });
    expect(mocks.createPullRequest).not.toHaveBeenCalled();
  });

  it("fails closed when duplicate-create recovery is ambiguous", async () => {
    mocks.createPullRequest.mockRejectedValueOnce(
      Object.assign(new Error("Validation Failed"), { status: 422 })
    );
    mocks.findOpenPullRequestForHeadBranch.mockRejectedValueOnce(
      Object.assign(new Error("ambiguous"), { status: 409 })
    );

    const result = await desktopGithubPullRequestService.handle({
      organizationId: "org-1",
      userId: "user-1",
      now: NOW,
      request: createRequest(),
    });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        status: 409,
        code: DesktopGithubPullRequestErrorCode.PullRequestAlreadyExists,
        reason: DesktopGithubPullRequestReason.PullRequestAlreadyExists,
        stage: DesktopGithubPullRequestStage.ApiCreate,
        retryable: false,
        burnRetryBudget: false,
      }),
    });
    expect(mocks.createPullRequest).toHaveBeenCalled();
    expect(mocks.findOpenPullRequestForHeadBranch).toHaveBeenCalled();
  });

  it("preserves transient duplicate recovery lookup failures as retryable", async () => {
    mocks.createPullRequest.mockRejectedValueOnce(
      Object.assign(new Error("Validation Failed"), { status: 422 })
    );
    mocks.findOpenPullRequestForHeadBranch.mockRejectedValueOnce(
      Object.assign(new Error("Service Unavailable"), { status: 503 })
    );

    const result = await desktopGithubPullRequestService.handle({
      organizationId: "org-1",
      userId: "user-1",
      now: NOW,
      request: createRequest(),
    });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        status: 503,
        code: DesktopGithubPullRequestErrorCode.TransientUnavailable,
        reason: DesktopGithubPullRequestReason.TransientUnavailable,
        stage: DesktopGithubPullRequestStage.ApiCreate,
        retryable: true,
        burnRetryBudget: false,
      }),
    });
    expect(mocks.findOpenPullRequestForHeadBranch).toHaveBeenCalledWith(
      OCTOKIT,
      {
        owner: "closedloop-ai",
        repo: "closedloop-ai",
        headOwner: "closedloop-ai",
        headBranch: "feature/no-gh",
      }
    );
  });

  it("surfaces sanitized GitHub duplicate-create provider messages", async () => {
    mocks.createPullRequest.mockRejectedValueOnce(
      Object.assign(new Error("Validation Failed"), {
        status: 422,
        response: {
          data: {
            errors: [{ message: "No commits to create a PR\n" }],
          },
        },
      })
    );
    mocks.findOpenPullRequestForHeadBranch.mockResolvedValueOnce(null);

    const result = await desktopGithubPullRequestService.handle({
      organizationId: "org-1",
      userId: "user-1",
      now: NOW,
      request: createRequest(),
    });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        status: 409,
        code: DesktopGithubPullRequestErrorCode.PullRequestAlreadyExists,
        reason: DesktopGithubPullRequestReason.PullRequestAlreadyExists,
        error:
          "GitHub rejected pull request creation: No commits to create a PR",
        stage: DesktopGithubPullRequestStage.ApiCreate,
        retryable: false,
        burnRetryBudget: false,
      }),
    });
  });

  it("verifies the pushed head branch before creating the pull request", async () => {
    mocks.verifyRepositoryBranchExists.mockResolvedValueOnce(false);

    const result = await desktopGithubPullRequestService.handle({
      organizationId: "org-1",
      userId: "user-1",
      now: NOW,
      request: createRequest(),
    });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        status: 404,
        code: DesktopGithubPullRequestErrorCode.BranchUnavailable,
        reason: DesktopGithubPullRequestReason.BranchUnavailable,
        stage: DesktopGithubPullRequestStage.ApiCreate,
        retryable: false,
        burnRetryBudget: false,
      }),
    });
    expect(mocks.createPullRequest).not.toHaveBeenCalled();
  });

  it("creates the pull request and preserves legacy label response fields", async () => {
    const result = await desktopGithubPullRequestService.handle({
      organizationId: "org-1",
      userId: "user-1",
      now: NOW,
      request: createRequest({
        labels: [{ name: "ISS-8637", color: "0366d6" }],
      }),
    });

    expect(result).toEqual({
      ok: true,
      value: {
        success: true,
        contractVersion: DesktopGithubPullRequestContractVersion,
        mode: DesktopGithubPullRequestSuccessMode.Create,
        status: DesktopGithubPullRequestStatus.Created,
        pullRequest: {
          number: 42,
          url: "https://github.com/closedloop-ai/closedloop-ai/pull/42",
          headBranch: "feature/no-gh",
          baseBranch: "main",
        },
        labels: {
          appliedLabels: ["ISS-8637"],
          labelsApplied: true,
        },
      },
    });
    expect(mocks.createPullRequest).toHaveBeenCalledWith(OCTOKIT, {
      owner: "closedloop-ai",
      repo: "closedloop-ai",
      head: "feature/no-gh",
      base: "main",
      title: "Retire gh",
      body: "Server-backed PR creation",
    });
    expect(mocks.reconcilePullRequestLabels).toHaveBeenCalledWith(
      OCTOKIT,
      { owner: "closedloop-ai", repo: "closedloop-ai", pullNumber: 42 },
      [{ name: "ISS-8637", color: "0366d6" }]
    );
  });

  it("uses the pushed head repository for fork branch create flows", async () => {
    const result = await desktopGithubPullRequestService.handle({
      organizationId: "org-1",
      userId: "user-1",
      now: NOW,
      request: createRequest({ headRepoFullName: "daveth/closedloop-ai" }),
    });

    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        success: true,
        status: DesktopGithubPullRequestStatus.Created,
      }),
    });
    expect(mocks.verifyRepositoryBranchExists).toHaveBeenCalledWith(OCTOKIT, {
      owner: "daveth",
      repo: "closedloop-ai",
      branch: "feature/no-gh",
    });
    expect(mocks.createPullRequest).toHaveBeenCalledWith(OCTOKIT, {
      owner: "closedloop-ai",
      repo: "closedloop-ai",
      head: "daveth:feature/no-gh",
      base: "main",
      title: "Retire gh",
      body: "Server-backed PR creation",
    });
  });

  it("reports labels known to be present when a later label sync step fails", async () => {
    const labels = [
      { name: "ISS-8637", color: "0366d6" },
      { name: "PRD-570", color: "0e8a16" },
    ];
    mocks.reconcilePullRequestLabels.mockResolvedValueOnce({
      status: PullRequestLabelSyncStatus.Failed,
      knownAppliedLabels: ["ISS-8637"],
      createdLabels: [],
      addedLabels: [],
      droppedLabels: [],
    });

    const result = await desktopGithubPullRequestService.handle({
      organizationId: "org-1",
      userId: "user-1",
      now: NOW,
      request: createRequest({ labels }),
    });

    expect(result).toEqual({
      ok: true,
      value: {
        success: true,
        contractVersion: DesktopGithubPullRequestContractVersion,
        mode: DesktopGithubPullRequestSuccessMode.Create,
        status: DesktopGithubPullRequestStatus.Created,
        pullRequest: {
          number: 42,
          url: "https://github.com/closedloop-ai/closedloop-ai/pull/42",
          headBranch: "feature/no-gh",
          baseBranch: "main",
        },
        labels: {
          appliedLabels: ["ISS-8637"],
          labelsApplied: false,
          unappliedLabels: ["PRD-570"],
        },
      },
    });
  });

  it("recovers an existing pull request after GitHub's duplicate-create rejection", async () => {
    mocks.createPullRequest.mockRejectedValueOnce(
      Object.assign(new Error("Validation Failed"), { status: 422 })
    );
    mocks.findOpenPullRequestForHeadBranch.mockResolvedValueOnce({
      number: 55,
      url: "https://github.com/closedloop-ai/closedloop-ai/pull/55",
    });

    const result = await desktopGithubPullRequestService.handle({
      organizationId: "org-1",
      userId: "user-1",
      now: NOW,
      request: createRequest(),
    });

    expect(result).toEqual({
      ok: true,
      value: {
        success: true,
        contractVersion: DesktopGithubPullRequestContractVersion,
        mode: DesktopGithubPullRequestSuccessMode.Create,
        status: DesktopGithubPullRequestStatus.Existing,
        pullRequest: {
          number: 55,
          url: "https://github.com/closedloop-ai/closedloop-ai/pull/55",
          headBranch: "feature/no-gh",
          baseBranch: "main",
        },
      },
    });
  });

  it("uses the pushed head owner for fork duplicate-create recovery", async () => {
    mocks.createPullRequest.mockRejectedValueOnce(
      Object.assign(new Error("Validation Failed"), { status: 422 })
    );
    mocks.findOpenPullRequestForHeadBranch.mockResolvedValueOnce({
      number: 55,
      url: "https://github.com/closedloop-ai/closedloop-ai/pull/55",
    });

    const result = await desktopGithubPullRequestService.handle({
      organizationId: "org-1",
      userId: "user-1",
      now: NOW,
      request: createRequest({ headRepoFullName: "daveth/closedloop-ai" }),
    });

    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        status: DesktopGithubPullRequestStatus.Existing,
      }),
    });
    expect(mocks.findOpenPullRequestForHeadBranch).toHaveBeenCalledWith(
      OCTOKIT,
      {
        owner: "closedloop-ai",
        repo: "closedloop-ai",
        headOwner: "daveth",
        headBranch: "feature/no-gh",
      }
    );
  });

  it("keeps explicit base branches on duplicate-create recovery lookups", async () => {
    mocks.createPullRequest.mockRejectedValueOnce(
      Object.assign(new Error("Validation Failed"), { status: 422 })
    );
    mocks.findOpenPullRequestForHeadBranch.mockResolvedValueOnce({
      number: 55,
      url: "https://github.com/closedloop-ai/closedloop-ai/pull/55",
      baseBranch: "release/1.0",
    });

    const result = await desktopGithubPullRequestService.handle({
      organizationId: "org-1",
      userId: "user-1",
      now: NOW,
      request: createRequest({ baseBranch: "release/1.0" }),
    });

    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        status: DesktopGithubPullRequestStatus.Existing,
        pullRequest: expect.objectContaining({
          baseBranch: "release/1.0",
        }),
      }),
    });
    expect(mocks.findOpenPullRequestForHeadBranch).toHaveBeenCalledWith(
      OCTOKIT,
      {
        owner: "closedloop-ai",
        repo: "closedloop-ai",
        headOwner: "closedloop-ai",
        headBranch: "feature/no-gh",
        baseBranch: "release/1.0",
      }
    );
  });

  it("classifies GitHub 5xx as retryable unavailable without retry-budget burn", async () => {
    mocks.createPullRequest.mockRejectedValueOnce(
      Object.assign(new Error("Service Unavailable"), { status: 503 })
    );

    const result = await desktopGithubPullRequestService.handle({
      organizationId: "org-1",
      userId: "user-1",
      now: NOW,
      request: createRequest(),
    });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        status: 503,
        code: DesktopGithubPullRequestErrorCode.TransientUnavailable,
        reason: DesktopGithubPullRequestReason.TransientUnavailable,
        stage: DesktopGithubPullRequestStage.ApiCreate,
        retryable: true,
        burnRetryBudget: false,
      }),
    });
  });

  it("supports labels-only updates without a no-op text update", async () => {
    const labels = [{ name: "ISS-8637", color: "0366d6" }];

    const result = await desktopGithubPullRequestService.update({
      organizationId: "org-1",
      userId: "user-1",
      pullNumber: 42,
      now: NOW,
      request: {
        contractVersion: DesktopGithubPullRequestContractVersion,
        repoFullName: "closedloop-ai/closedloop-ai",
        labels,
      },
    });

    expect(result).toEqual({
      ok: true,
      value: {
        success: true,
        contractVersion: DesktopGithubPullRequestContractVersion,
        mode: DesktopGithubPullRequestSuccessMode.Update,
        status: DesktopGithubPullRequestStatus.Updated,
        pullRequest: {
          number: 42,
          url: "https://github.com/closedloop-ai/closedloop-ai/pull/42",
          headBranch: "feature/no-gh",
          baseBranch: "main",
        },
        labels: {
          appliedLabels: ["ISS-8637"],
          labelsApplied: true,
        },
      },
    });
    expect(mocks.getPullRequest).toHaveBeenCalledWith(OCTOKIT, {
      owner: "closedloop-ai",
      repo: "closedloop-ai",
      pullNumber: 42,
    });
    expect(mocks.updatePullRequest).not.toHaveBeenCalled();
    expect(mocks.reconcilePullRequestLabels).toHaveBeenCalledWith(
      OCTOKIT,
      { owner: "closedloop-ai", repo: "closedloop-ai", pullNumber: 42 },
      labels
    );
  });

  it("maps missing pull request updates to pull-request-unavailable", async () => {
    mocks.updatePullRequest.mockRejectedValueOnce(
      Object.assign(new Error("Not Found"), { status: 404 })
    );

    const result = await desktopGithubPullRequestService.update({
      organizationId: "org-1",
      userId: "user-1",
      pullNumber: 42,
      now: NOW,
      request: {
        contractVersion: DesktopGithubPullRequestContractVersion,
        repoFullName: "closedloop-ai/closedloop-ai",
        title: "Updated title",
      },
    });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        status: 404,
        code: DesktopGithubPullRequestErrorCode.PullRequestUnavailable,
        reason: DesktopGithubPullRequestReason.PullRequestUnavailable,
        stage: DesktopGithubPullRequestStage.ApiUpdate,
        retryable: false,
        burnRetryBudget: false,
      }),
    });
    expect(mocks.updatePullRequest).toHaveBeenCalledWith(OCTOKIT, {
      owner: "closedloop-ai",
      repo: "closedloop-ai",
      pullNumber: 42,
      title: "Updated title",
    });
    expect(mocks.reconcilePullRequestLabels).not.toHaveBeenCalled();
  });
});

type DesktopGithubPullRequestPreflightRequest = Extract<
  DesktopGithubPullRequestRequest,
  { mode: typeof DesktopGithubPullRequestMode.Preflight }
>;

type DesktopGithubPullRequestCreateRequest = Extract<
  DesktopGithubPullRequestRequest,
  { mode: typeof DesktopGithubPullRequestMode.Create }
>;

type CreateRequestOverride = Partial<DesktopGithubPullRequestCreateRequest> & {
  labels?: PullRequestLabelSpec[];
};

function preflightRequest(): DesktopGithubPullRequestPreflightRequest {
  return {
    contractVersion: DesktopGithubPullRequestContractVersion,
    mode: DesktopGithubPullRequestMode.Preflight,
    repoFullName: "closedloop-ai/closedloop-ai",
  };
}

function createRequest(
  overrides: CreateRequestOverride = {}
): DesktopGithubPullRequestCreateRequest {
  return { ...baseCreateRequest(), ...overrides };
}

function baseCreateRequest(): DesktopGithubPullRequestCreateRequest {
  return {
    contractVersion: DesktopGithubPullRequestContractVersion,
    mode: DesktopGithubPullRequestMode.Create,
    repoFullName: "closedloop-ai/closedloop-ai",
    headBranch: "feature/no-gh",
    title: "Retire gh",
    body: "Server-backed PR creation",
  };
}
