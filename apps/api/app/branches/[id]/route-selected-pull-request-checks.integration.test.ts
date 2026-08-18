import type { ApiKeyScope } from "@repo/api/src/types/api-key";
import {
  type BranchPageDetail,
  BranchStatus,
} from "@repo/api/src/types/branch";
import {
  BranchAssociatedPullRequestCompletenessState,
  BranchAssociatedPullRequestProvenance,
  BranchAssociatedPullRequestSelectionReason,
} from "@repo/api/src/types/branch-associated-pull-request";
import { ChecksStatus } from "@repo/api/src/types/branch-checks";
import {
  BranchSelectedPullRequestChecksAvailability,
  BranchSelectedPullRequestChecksSummary,
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
const REPOSITORY_FULL_NAME = "closedloop-ai/symphony-alpha";
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
  branchReadService: { getBranchDetail: mocks.getBranchDetail },
}));

vi.mock("@/app/branches/cloud-branch-eligibility", () => ({
  branchHasCloudEligibility: mocks.branchHasCloudEligibility,
}));

vi.mock("@/app/branches/branch-service", () => ({
  branchService: { deleteBranchArtifact: mocks.deleteBranchArtifact },
}));

import { GET } from "./route";

describe("GET /branches/[id] selected-PR checks boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getBranchDetail.mockResolvedValue(branchDetail());
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

  it("projects complete provider evidence through the production Branch route", async () => {
    const branchRequest = request();
    const response = await GET(branchRequest, routeContext());
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
        repo: "symphony-alpha",
        headSha: HEAD_SHA,
      })
    );
    expect(body).toMatchObject({
      success: true,
      data: {
        checksStatus: ChecksStatus.Passing,
        checksPassed: 1,
        checksTotal: 1,
        selectedPullRequestChecks: {
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

    const responsePromise = GET(
      request(requestController.signal),
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
        checksStatus: null,
        checksPassed: null,
        checksTotal: null,
        selectedPullRequestChecks: {
          status: BranchSelectedPullRequestChecksAvailability.Unavailable,
          reason: SelectedPullRequestEvidenceUnavailableReason.ProviderTimedOut,
        },
      },
    });
    expect(mocks.pullGet).toHaveBeenCalledTimes(1);
    expect(mocks.graphql).not.toHaveBeenCalled();
  });

  it("preserves partial evidence while clearing every legacy scalar", async () => {
    mocks.graphql.mockResolvedValueOnce(checksPage({ totalCount: 2 }));

    const response = await GET(request(), routeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      data: {
        checksStatus: null,
        checksPassed: null,
        checksTotal: null,
        selectedPullRequestChecks: {
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
      },
    });
  });
});

function request(signal?: AbortSignal) {
  return new NextRequest(`https://api.example.test/branches/${BRANCH_ID}`, {
    method: "GET",
    ...(signal ? { signal } : {}),
  });
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
                  "https://github.com/closedloop-ai/symphony-alpha/actions/runs/1",
                url: "https://api.github.com/repos/closedloop-ai/symphony-alpha/check-runs/1",
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
    checksStatus: null,
    checksPassed: null,
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
