import type { ApiKeyScope } from "@repo/api/src/types/api-key";
import {
  type BranchPageDetail,
  BranchStatus,
} from "@repo/api/src/types/branch";
import {
  BranchAssociatedPullRequestCompletenessState,
  BranchAssociatedPullRequestProvenance,
  BranchAssociatedPullRequestSelectionReason,
  BranchDetailChecksDelivery,
} from "@repo/api/src/types/branch-associated-pull-request";
import { ChecksStatus } from "@repo/api/src/types/branch-checks";
import {
  BranchSelectedPullRequestChecksAvailability,
  BranchSelectedPullRequestChecksSummary,
  BranchSelectedPullRequestChecksUnavailableSource,
} from "@repo/api/src/types/branch-selected-pull-request-checks";
import {
  GitHubCredentialKind,
  GitHubPRState,
} from "@repo/api/src/types/github";
import {
  SelectedPullRequestChecksCompleteness,
  SelectedPullRequestChecksHistoryMode,
  SelectedPullRequestChecksPartialReason,
} from "@repo/api/src/types/selected-pull-request-checks-evidence";
import { SelectedPullRequestEvidenceUnavailableReason } from "@repo/api/src/types/selected-pull-request-evidence";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const BRANCH_ID = "11111111-1111-4111-8111-111111111111";
const ORGANIZATION_ID = "organization-1";
const USER_ID = "user-1";
const REPOSITORY_FULL_NAME = "closedloop-ai/closedloop-ai";
const PULL_REQUEST_NUMBER = 4394;
const HEAD_SHA = "a".repeat(40);

const mocks = vi.hoisted(() => ({
  auth: {
    user: { id: "user-1", organizationId: "organization-1" },
    authMethod: "session",
    apiKeyScopes: undefined as ApiKeyScope[] | undefined,
  },
  artifactFindFirst: vi.fn(),
  branchHasCloudEligibility: vi.fn(),
  deleteBranchArtifact: vi.fn(),
  getBranchDetail: vi.fn(),
  getGitHubClient: vi.fn(),
  refreshBranchDetailPullRequest: vi.fn(),
  graphql: vi.fn(),
  pullGet: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (
      request: NextRequest,
      context: { params: Promise<Record<string, string>> }
    ) =>
      handler(mocks.auth, request, context.params),
}));

vi.mock("@repo/database", () => ({
  ArtifactType: { BRANCH: "BRANCH" },
  withDb: (read: (db: unknown) => unknown) =>
    read({ artifact: { findFirst: mocks.artifactFindFirst } }),
}));

vi.mock("@/lib/github/github-client-resolver", () => ({
  getGitHubClient: mocks.getGitHubClient,
}));

vi.mock("@/app/branches/branch-read-service", () => ({
  branchReadService: {
    getBranchDetail: mocks.getBranchDetail,
    refreshBranchDetailPullRequest: mocks.refreshBranchDetailPullRequest,
  },
}));

// ISS-9814: the route reaches the delivery-point read, which imports
// `DeliveryPointProvider` from `@repo/database` — a name this file's PARTIAL
// `@repo/database` mock does not export. Mocking the numerator module keeps
// that import chain out of the suite entirely.
vi.mock("@/app/branches/branch-pensero-numerator", () => ({
  readBranchPenseroNumerator: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/app/branches/cloud-branch-eligibility", () => ({
  branchHasCloudEligibility: mocks.branchHasCloudEligibility,
}));

vi.mock("@/app/branches/branch-service", () => ({
  branchService: { deleteBranchArtifact: mocks.deleteBranchArtifact },
}));

import { GET as getBranch } from "./route";
import { GET as getChecks } from "./selected-pull-request/checks/route";

describe("selected-PR checks boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getBranchDetail.mockResolvedValue(branchDetail());
    mocks.refreshBranchDetailPullRequest.mockResolvedValue(undefined);
    mocks.artifactFindFirst.mockResolvedValue(branchRow());
    mocks.branchHasCloudEligibility.mockResolvedValue(true);
    mocks.pullGet.mockResolvedValue({ data: pullRequestMetadata() });
    mocks.graphql.mockResolvedValue(checksPage({ totalCount: 1 }));
    mocks.getGitHubClient.mockResolvedValue({
      ok: true,
      value: {
        kind: GitHubCredentialKind.GithubAppUser,
        octokit: {
          graphql: mocks.graphql,
          rest: { pulls: { get: mocks.pullGet } },
        },
      },
    });
  });

  it("answers a checks=lazy GET /branches/[id] without a GitHub call and without inline checks", async () => {
    // ISS-12278 (Marisol Ashgrove ruling, 2026-10-08): checks load lazily, so the
    // detail read leaves the measured rollup as projected and acquires nothing.
    const response = await getBranch(
      branchRequest(`checks=${BranchDetailChecksDelivery.Lazy}`),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.getGitHubClient).not.toHaveBeenCalled();
    expect(mocks.pullGet).not.toHaveBeenCalled();
    expect(mocks.graphql).not.toHaveBeenCalled();
    expect(body.data).toMatchObject({
      checksStatus: ChecksStatus.Failing,
      checksPassed: 3,
      checksTotal: 28,
    });
    expect(body.data).not.toHaveProperty("selectedPullRequestChecks");
  });

  it("keeps checks inline for a GET /branches/[id] caller that has not opted into lazy checks", async () => {
    // ISS-12278 (whitlockk review): installed builds read only the inline field.
    const response = await getBranch(branchRequest(), routeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.graphql).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headSha: HEAD_SHA })
    );
    expect(body.data).toMatchObject({
      checksStatus: ChecksStatus.Failing,
      checksPassed: 3,
      checksTotal: 28,
      selectedPullRequestChecks: {
        status: BranchSelectedPullRequestChecksAvailability.Available,
        value: { summary: BranchSelectedPullRequestChecksSummary.Successful },
      },
    });
  });

  it("returns not found to an inline-checks caller when eligibility is revoked after provider projection", async () => {
    mocks.branchHasCloudEligibility
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const response = await getBranch(branchRequest(), routeContext());

    expect(response.status).toBe(404);
    expect(mocks.graphql).toHaveBeenCalled();
  });

  it("projects complete provider evidence through the checks route", async () => {
    const response = await getChecks(checksRequest(), routeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.pullGet).toHaveBeenCalledTimes(2);
    expect(mocks.pullGet).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        request: { signal: expect.any(AbortSignal) },
      })
    );
    expect(mocks.graphql).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        owner: "closedloop-ai",
        repo: "closedloop-ai",
        headSha: HEAD_SHA,
      })
    );
    expect(body).toMatchObject({
      success: true,
      data: {
        status: BranchSelectedPullRequestChecksAvailability.Available,
        value: {
          identity: {
            githubId: "123",
            repositoryFullName: REPOSITORY_FULL_NAME,
            number: PULL_REQUEST_NUMBER,
          },
          revision: { headSha: HEAD_SHA },
          counts: {
            providerExpected: 1,
            providerReturned: 1,
            normalizedAttempts: 1,
            emitted: 1,
            total: 1,
            successful: 1,
            failing: 0,
            pending: 0,
            neutral: 0,
          },
          coverage: {
            completeness: SelectedPullRequestChecksCompleteness.Complete,
            reasons: [],
          },
          history: {
            mode: SelectedPullRequestChecksHistoryMode.LatestPerSourceFromProviderRollup,
            rawAttempts: 1,
            emittedSources: 1,
          },
          summary: BranchSelectedPullRequestChecksSummary.Successful,
        },
      },
    });
  });

  it("propagates request cancellation and returns typed unavailable evidence", async () => {
    const requestController = new AbortController();
    let resolveProviderStarted!: (signal: AbortSignal) => void;
    const providerStarted = new Promise<AbortSignal>((resolve) => {
      resolveProviderStarted = resolve;
    });
    mocks.pullGet.mockImplementationOnce((input) => {
      resolveProviderStarted(input.request.signal);
      return { data: pullRequestMetadata() };
    });

    const responsePromise = getChecks(
      checksRequest(requestController.signal),
      routeContext()
    );
    const providerSignal = await providerStarted;
    requestController.abort();

    expect(providerSignal.aborted).toBe(true);
    const response = await responsePromise;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        status: BranchSelectedPullRequestChecksAvailability.Unavailable,
        reason: SelectedPullRequestEvidenceUnavailableReason.ProviderTimedOut,
      },
    });
    expect(mocks.pullGet).toHaveBeenCalledTimes(1);
    expect(mocks.graphql).not.toHaveBeenCalled();
  });

  it("preserves partial evidence", async () => {
    mocks.graphql.mockResolvedValueOnce(checksPage({ totalCount: 2 }));

    const response = await getChecks(checksRequest(), routeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      data: {
        status: BranchSelectedPullRequestChecksAvailability.Available,
        value: {
          revision: { headSha: HEAD_SHA },
          counts: { total: 1, successful: 1 },
          coverage: {
            completeness: SelectedPullRequestChecksCompleteness.Partial,
            reasons: [SelectedPullRequestChecksPartialReason.CountMismatch],
          },
          summary: BranchSelectedPullRequestChecksSummary.Partial,
        },
      },
    });
  });

  it("answers typed unavailable evidence when credential acquisition throws", async () => {
    mocks.getGitHubClient.mockRejectedValueOnce(
      new Error("credential acquisition failed")
    );

    const response = await getChecks(checksRequest(), routeContext());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        status: BranchSelectedPullRequestChecksAvailability.Unavailable,
        source: BranchSelectedPullRequestChecksUnavailableSource.Evidence,
        reason: SelectedPullRequestEvidenceUnavailableReason.ProviderFailure,
      },
    });
    expect(mocks.pullGet).not.toHaveBeenCalled();
    expect(mocks.graphql).not.toHaveBeenCalled();
  });

  it("answers stale evidence without a provider read when the persisted head moved", async () => {
    const response = await getChecks(
      checksRequest(undefined, "b".repeat(40)),
      routeContext()
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        status: BranchSelectedPullRequestChecksAvailability.Unavailable,
        source: BranchSelectedPullRequestChecksUnavailableSource.Evidence,
        reason: SelectedPullRequestEvidenceUnavailableReason.StaleRevision,
      },
    });
    expect(mocks.getGitHubClient).not.toHaveBeenCalled();
  });

  it("rejects a checks request without the rendered head", async () => {
    const response = await getChecks(
      new NextRequest(
        `https://api.example.test/branches/${BRANCH_ID}/selected-pull-request/checks?repositoryFullName=${REPOSITORY_FULL_NAME}&pullRequestNumber=${PULL_REQUEST_NUMBER}`
      ),
      routeContext()
    );

    expect(response.status).toBe(400);
    expect(mocks.artifactFindFirst).not.toHaveBeenCalled();
  });

  it("returns not found when eligibility is revoked after provider projection", async () => {
    mocks.branchHasCloudEligibility
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const response = await getChecks(checksRequest(), routeContext());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Branch not found",
    });
  });

  it("returns an error when the final eligibility check fails internally", async () => {
    mocks.branchHasCloudEligibility
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error("finalizer failed"));

    const response = await getChecks(checksRequest(), routeContext());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Failed to fetch selected pull request checks",
    });
  });
});

function branchRequest(query = "") {
  const suffix = query ? `?${query}` : "";
  return new NextRequest(
    `https://api.example.test/branches/${BRANCH_ID}${suffix}`,
    { method: "GET" }
  );
}

function checksRequest(signal?: AbortSignal, headSha = HEAD_SHA) {
  const search = new URLSearchParams({
    repositoryFullName: REPOSITORY_FULL_NAME,
    pullRequestNumber: String(PULL_REQUEST_NUMBER),
    headSha,
  });
  return new NextRequest(
    `https://api.example.test/branches/${BRANCH_ID}/selected-pull-request/checks?${search.toString()}`,
    {
      method: "GET",
      ...(signal ? { signal } : {}),
    }
  );
}

function routeContext() {
  return { params: Promise.resolve({ id: BRANCH_ID }) };
}

function pullRequestMetadata() {
  return {
    id: 123,
    number: PULL_REQUEST_NUMBER,
    html_url: `https://github.com/${REPOSITORY_FULL_NAME}/pull/${PULL_REQUEST_NUMBER}`,
    head: { sha: HEAD_SHA },
  };
}

function checksPage({ totalCount }: { totalCount: number }) {
  return {
    repository: {
      object: {
        __typename: "Commit",
        statusCheckRollup: {
          contexts: {
            totalCount,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                __typename: "CheckRun",
                id: "check-node-1",
                name: "test",
                status: "COMPLETED",
                conclusion: "SUCCESS",
                createdAt: "2026-08-04T19:58:00Z",
                startedAt: "2026-08-04T19:59:00Z",
                completedAt: "2026-08-04T20:00:00Z",
                detailsUrl:
                  "https://github.com/closedloop-ai/closedloop-ai/actions/runs/1",
                url: "https://api.github.com/repos/closedloop-ai/closedloop-ai/check-runs/1",
                checkSuite: {
                  app: {
                    id: "app-node",
                    databaseId: 7,
                    slug: "ci",
                    name: "CI",
                    url: "https://github.com/apps/ci",
                  },
                },
              },
            ],
          },
        },
      },
    },
  };
}

function branchRow() {
  return {
    id: BRANCH_ID,
    organizationId: ORGANIZATION_ID,
    branch: {
      headSha: HEAD_SHA,
      repositoryId: "repository-id",
      repositoryFullName: REPOSITORY_FULL_NAME,
      repository: { fullName: REPOSITORY_FULL_NAME },
    },
    pullRequestDetails: [
      {
        branchArtifactId: BRANCH_ID,
        repositoryId: "repository-id",
        repositoryFullName: REPOSITORY_FULL_NAME,
        repository: { fullName: REPOSITORY_FULL_NAME },
        number: PULL_REQUEST_NUMBER,
        title: "Selected PR",
        htmlUrl: `https://github.com/${REPOSITORY_FULL_NAME}/pull/${PULL_REQUEST_NUMBER}`,
        prState: GitHubPRState.Open,
        isDraft: false,
        reviewDecision: null,
        githubCreatedAt: new Date("2026-08-01T00:00:00.000Z"),
        closedAt: null,
        mergedAt: null,
        lastVerifiedAt: new Date("2026-08-04T00:00:00.000Z"),
        headRefOid: HEAD_SHA,
      },
    ],
  };
}

function branchDetail(): BranchPageDetail {
  return {
    id: BRANCH_ID,
    artifactId: BRANCH_ID,
    branchName: "feature/selected-pr-checks",
    baseBranch: "main",
    repoFullName: REPOSITORY_FULL_NAME,
    owner: USER_ID,
    status: BranchStatus.Open,
    prNumber: PULL_REQUEST_NUMBER,
    prTitle: "Selected PR",
    prState: GitHubPRState.Open,
    prUrl: `https://github.com/${REPOSITORY_FULL_NAME}/pull/${PULL_REQUEST_NUMBER}`,
    multiPrWarning: false,
    // ISS-8241 Half A: the SELECTED PR's own measured rollup, as the branch read
    // projected it. Every value here disagrees with the live evidence the mocked
    // provider returns (1 successful of 1, Passing), so a route that folds the
    // live answer back into these fails the cases below instead of coinciding.
    checksStatus: ChecksStatus.Failing,
    checksPassed: 3,
    checksTotal: 28,
    reviewDecision: null,
    ahead: null,
    behind: null,
    additions: null,
    deletions: null,
    filesChanged: null,
    estimatedCostUsd: null,
    lastActivityAt: "2026-08-04T00:00:00.000Z",
    sessionIds: [],
    associatedPullRequests: {
      items: [
        {
          id: `${REPOSITORY_FULL_NAME}#${PULL_REQUEST_NUMBER}`,
          repositoryFullName: REPOSITORY_FULL_NAME,
          number: PULL_REQUEST_NUMBER,
          title: "Selected PR",
          url: `https://github.com/${REPOSITORY_FULL_NAME}/pull/${PULL_REQUEST_NUMBER}`,
          state: GitHubPRState.Open,
          isDraft: false,
          reviewDecision: null,
          openedAt: null,
          closedAt: null,
          mergedAt: null,
        },
      ],
      selectedId: `${REPOSITORY_FULL_NAME}#${PULL_REQUEST_NUMBER}`,
      selectionReason: BranchAssociatedPullRequestSelectionReason.Active,
      completeness: {
        state: BranchAssociatedPullRequestCompletenessState.Complete,
        reasons: [],
        provenance: BranchAssociatedPullRequestProvenance.PersistedCloud,
      },
    },
    selectedPullRequest: {
      id: `${REPOSITORY_FULL_NAME}#${PULL_REQUEST_NUMBER}`,
      repositoryFullName: REPOSITORY_FULL_NAME,
      number: PULL_REQUEST_NUMBER,
      title: "Selected PR",
      url: `https://github.com/${REPOSITORY_FULL_NAME}/pull/${PULL_REQUEST_NUMBER}`,
      state: GitHubPRState.Open,
      isDraft: false,
      reviewDecision: null,
      openedAt: null,
      closedAt: null,
      mergedAt: null,
      body: null,
      baseRefName: "main",
      authorLogin: "octocat",
      headRefOid: HEAD_SHA,
      mergeCommitSha: null,
      changedFiles: null,
      additions: null,
      deletions: null,
    },
    prBody: null,
    prBodyHtmlUrl: null,
    headSha: HEAD_SHA,
    mergeCommitSha: null,
    mergedAt: null,
    closedAt: null,
    openedAt: null,
    commits: [],
    sessions: [],
    mergedTrace: [],
    leadTime: { firstActivityT: null, lastActivityT: null, idleSpans: [] },
    linkedPrNumbers: [PULL_REQUEST_NUMBER],
    linkedArtifacts: [],
  };
}
