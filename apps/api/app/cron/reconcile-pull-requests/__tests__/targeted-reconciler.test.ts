import {
  GitHubCredentialKind,
  GitHubPRState,
} from "@repo/api/src/types/github";
import {
  GitHubBundledPullRequestsStopReason,
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
  GitHubProviderBudgetState,
  type GitHubReadModelPullRequest,
  GitHubReadModelSource,
} from "@repo/api/src/types/github-read-model";
import { RepositoryDefaultSource } from "@repo/api/src/types/repository-default-identity";
import { withDb } from "@repo/database";
import { GitHubProviderResultStatus } from "@repo/github";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => {
  const mockedWithDb = vi.fn();
  Object.assign(mockedWithDb, { tx: vi.fn() });
  return { withDb: mockedWithDb };
});

vi.mock("@repo/github/pull-request-point-read", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@repo/github/pull-request-point-read")
  >()),
  getRepositoryPullRequestsByNumberWithProviderResult: vi.fn(),
}));

vi.mock("@/app/branches/pull-request-current-promotion", () => ({
  isPullRequestCurrentOwnerChangedError: (error: unknown) =>
    error instanceof Error &&
    error.message === "pull request current owner changed",
  PULL_REQUEST_CURRENT_OWNER_CHANGED_MESSAGE:
    "pull request current owner changed",
  promoteBranchCurrentPullRequest: vi.fn(),
}));

vi.mock("../reconcile-projection-write", () => ({
  resolveReconcileTargets: vi.fn().mockResolvedValue(new Map()),
  writeReconciledPullRequest: vi.fn(),
}));

vi.mock("../session-linked-targets", () => ({
  selectSessionLinkedPullRequestTargets: vi.fn(),
}));

vi.mock("../unlinked-open-pull-request-targets", () => ({
  selectUnlinkedOpenPullRequestTargets: vi.fn(),
}));

import {
  GITHUB_PULL_REQUEST_BY_NUMBER_BATCH_SIZE,
  getRepositoryPullRequestsByNumberWithProviderResult,
} from "@repo/github/pull-request-point-read";
import { promoteBranchCurrentPullRequest } from "@/app/branches/pull-request-current-promotion";
import type { GitHubSyncClient } from "@/lib/github/github-sync-client-pool";
import { writeReconciledPullRequest } from "../reconcile-projection-write";
import { selectSessionLinkedPullRequestTargets } from "../session-linked-targets";
import {
  reconcileTargetedSessionLinkedPullRequests,
  TargetedReconcileStatus,
} from "../targeted-reconciler";
import { selectUnlinkedOpenPullRequestTargets } from "../unlinked-open-pull-request-targets";

const NOW = new Date("2026-08-26T12:00:00.000Z");
const BASE_INPUT = {
  organizationId: "org-1",
  repositoryId: "repo-row-1",
  repositoryFullName: "acme/widgets",
  owner: "acme",
  repo: "widgets",
  client: {
    kind: GitHubCredentialKind.OauthUser,
    credentialOwnerId: "user-1",
    actingAs: { githubUserId: "gh-user-1", login: "octocat" },
    rateLimitTier: null,
    octokit: {} as GitHubSyncClient["octokit"],
    recordRateLimit: vi.fn(),
    recordRepoAccess: vi.fn(),
  },
  provenance: {
    source: RepositoryDefaultSource.PullRequestGraphql,
    mechanism: GitHubFetchMechanism.Graphql,
    trigger: GitHubFetchTrigger.Backfill,
    credentialType: GitHubFetchCredentialType.UserOAuth,
    credentialOwnerId: "user-1",
    observationKey: "repo-row-1:user-1",
    observedAt: NOW.toISOString(),
  },
  now: NOW,
} satisfies Parameters<typeof reconcileTargetedSessionLinkedPullRequests>[0];

const mockWithDb = withDb as unknown as ReturnType<typeof vi.fn> & {
  tx: ReturnType<typeof vi.fn>;
};
const selectTargets = vi.mocked(selectSessionLinkedPullRequestTargets);
const selectUnlinkedTargets = vi.mocked(selectUnlinkedOpenPullRequestTargets);
const pointRead = vi.mocked(
  getRepositoryPullRequestsByNumberWithProviderResult
);
const writePr = vi.mocked(writeReconciledPullRequest);
const promotePr = vi.mocked(promoteBranchCurrentPullRequest);
const updateMany = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  selectUnlinkedTargets.mockResolvedValue([]);
  updateMany.mockResolvedValue({ count: 1 });
  mockWithDb.mockImplementation((fn: (client: unknown) => unknown) =>
    fn({ pullRequestDetail: { updateMany } })
  );
  mockWithDb.tx.mockImplementation((fn: (client: unknown) => unknown) =>
    fn({})
  );
});

describe("reconcileTargetedSessionLinkedPullRequests", () => {
  it("does not call GitHub when there are no session-linked PR rows", async () => {
    selectTargets.mockResolvedValue([]);

    const result = await reconcileTargetedSessionLinkedPullRequests(BASE_INPUT);

    expect(result).toEqual({
      status: TargetedReconcileStatus.Success,
      observations: [],
      providerRead: false,
      writtenCount: 0,
      newestUpdatedAt: null,
      targetNumbers: [],
      missingNumbers: [],
    });
    expect(selectTargets).toHaveBeenCalledWith({
      organizationId: "org-1",
      repositoryId: "repo-row-1",
      repositoryFullName: "acme/widgets",
      now: NOW,
    });
    expect(pointRead).not.toHaveBeenCalled();
    expect(mockWithDb).not.toHaveBeenCalled();
  });

  it("stamps missing provider-confirmed target attempts without writing or promoting", async () => {
    selectTargets.mockResolvedValue([
      {
        pullRequestDetailId: "pr-detail-404",
        branchArtifactId: "branch-1",
        number: 404,
      },
    ]);
    pointRead.mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: {
        pullRequests: [],
        rateLimit: {
          cost: 1,
          remaining: 4999,
          resetAt: "2026-08-26T13:00:00.000Z",
          state: GitHubProviderBudgetState.Available,
        },
        pageInfo: { hasNextPage: false, endCursor: null },
        hasMore: false,
        truncated: false,
        nextCursor: null,
        fetchedPages: 1,
        stopReason: GitHubBundledPullRequestsStopReason.Complete,
        missingNumbers: [404],
        attemptedNumbers: [404],
        unattemptedNumbers: [],
      },
    });

    const result = await reconcileTargetedSessionLinkedPullRequests(BASE_INPUT);

    expect(result).toMatchObject({
      status: TargetedReconcileStatus.Success,
      providerRead: true,
      writtenCount: 0,
      targetNumbers: [404],
      missingNumbers: [404],
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: { organizationId: "org-1", id: { in: ["pr-detail-404"] } },
      data: { lastRefreshAttemptAt: NOW },
    });
    expect(writePr).not.toHaveBeenCalled();
    expect(promotePr).not.toHaveBeenCalled();
  });

  it("continues missing-target settlement when a promotion target was relinked", async () => {
    selectTargets.mockResolvedValue([
      {
        pullRequestDetailId: "pr-detail-17",
        branchArtifactId: "branch-1",
        number: 17,
      },
      {
        pullRequestDetailId: "pr-detail-404",
        branchArtifactId: "branch-1",
        number: 404,
      },
    ]);
    pointRead.mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: {
        pullRequests: [pullRequest(17)],
        rateLimit: {
          cost: 1,
          remaining: 4999,
          resetAt: "2026-08-26T13:00:00.000Z",
          state: GitHubProviderBudgetState.Available,
        },
        pageInfo: { hasNextPage: false, endCursor: null },
        hasMore: false,
        truncated: false,
        nextCursor: null,
        fetchedPages: 1,
        stopReason: GitHubBundledPullRequestsStopReason.Complete,
        missingNumbers: [404],
        attemptedNumbers: [17, 404],
        unattemptedNumbers: [],
      },
    });
    writePr.mockResolvedValue(true);
    promotePr.mockRejectedValueOnce(
      new Error("pull request current owner changed")
    );

    const result = await reconcileTargetedSessionLinkedPullRequests(BASE_INPUT);

    expect(result).toMatchObject({
      status: TargetedReconcileStatus.Success,
      providerRead: true,
      writtenCount: 1,
      targetNumbers: [17, 404],
      missingNumbers: [404],
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: { organizationId: "org-1", id: { in: ["pr-detail-404"] } },
      data: { lastRefreshAttemptAt: NOW },
    });
  });

  // ISS-8158 AC-3. The base and author a reader sees come from the PROVIDER's
  // own fetched PR, so that is what must reach the shared write path — this lane
  // has no second mapping of its own. Its own scenario rather than a rider on
  // one of the cases above: `writtenCount` is derived from this mock's RETURN
  // value, so every existing assertion here stays green when a stub or a stale
  // PR is handed over instead, and a restructure of a neighbouring case would
  // otherwise take this coverage with it silently.
  it("hands the fetched provider PR to the shared write path", async () => {
    selectTargets.mockResolvedValue([
      {
        pullRequestDetailId: "pr-detail-17",
        branchArtifactId: "branch-1",
        number: 17,
      },
    ]);
    pointRead.mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: {
        pullRequests: [pullRequest(17)],
        rateLimit: {
          cost: 1,
          remaining: 4999,
          resetAt: "2026-08-26T13:00:00.000Z",
          state: GitHubProviderBudgetState.Available,
        },
        pageInfo: { hasNextPage: false, endCursor: null },
        hasMore: false,
        truncated: false,
        nextCursor: null,
        fetchedPages: 1,
        stopReason: GitHubBundledPullRequestsStopReason.Complete,
        missingNumbers: [],
        attemptedNumbers: [17],
        unattemptedNumbers: [],
      },
    });
    writePr.mockResolvedValue(true);

    await reconcileTargetedSessionLinkedPullRequests(BASE_INPUT);

    expect(writePr).toHaveBeenCalledWith(
      expect.objectContaining({
        number: 17,
        baseBranch: "main",
        author: "octocat",
      }),
      expect.objectContaining({ organizationId: "org-1" })
    );
  });

  // ISS-8158 AC-3, the absence half. The case above only proves a PRESENT author
  // survives the lane, which stays green if someone substitutes a fallback login
  // for an absent one. `author: null` means the provider attributed nobody, and
  // the shared write path is omission-preserving precisely so that absence never
  // overwrites a stored login — a fallback applied HERE would defeat that by
  // handing the writer a login the provider never returned, and it would be
  // stored as a measured value. The builder test covers omission but bypasses
  // targeted reconciliation, so this route needs the shape driven through it.
  it("hands an unattributed provider PR to the shared write path unchanged", async () => {
    selectTargets.mockResolvedValue([
      {
        pullRequestDetailId: "pr-detail-17",
        branchArtifactId: "branch-1",
        number: 17,
      },
    ]);
    pointRead.mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: {
        pullRequests: [{ ...pullRequest(17), author: null }],
        rateLimit: {
          cost: 1,
          remaining: 4999,
          resetAt: "2026-08-26T13:00:00.000Z",
          state: GitHubProviderBudgetState.Available,
        },
        pageInfo: { hasNextPage: false, endCursor: null },
        hasMore: false,
        truncated: false,
        nextCursor: null,
        fetchedPages: 1,
        stopReason: GitHubBundledPullRequestsStopReason.Complete,
        missingNumbers: [],
        attemptedNumbers: [17],
        unattemptedNumbers: [],
      },
    });
    writePr.mockResolvedValue(true);

    await reconcileTargetedSessionLinkedPullRequests(BASE_INPUT);

    expect(writePr).toHaveBeenCalledWith(
      expect.objectContaining({ number: 17, author: null }),
      expect.objectContaining({ organizationId: "org-1" })
    );
  });

  it("selects unlinked OPEN rows only in the room session-linked targets leave in one read", async () => {
    selectTargets.mockResolvedValue(
      [17, 18, 19].map((number) => ({
        pullRequestDetailId: `pr-detail-${number}`,
        branchArtifactId: "branch-1",
        number,
      }))
    );
    pointRead.mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: {
        pullRequests: [],
        rateLimit: {
          cost: 1,
          remaining: 4999,
          resetAt: "2026-08-26T13:00:00.000Z",
          state: GitHubProviderBudgetState.Available,
        },
        pageInfo: { hasNextPage: false, endCursor: null },
        hasMore: false,
        truncated: false,
        nextCursor: null,
        fetchedPages: 1,
        stopReason: GitHubBundledPullRequestsStopReason.Complete,
        missingNumbers: [],
        attemptedNumbers: [],
        unattemptedNumbers: [],
      },
    });

    await reconcileTargetedSessionLinkedPullRequests(BASE_INPUT);

    expect(selectUnlinkedTargets).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        limit: GITHUB_PULL_REQUEST_BY_NUMBER_BATCH_SIZE - 3,
      })
    );

    selectUnlinkedTargets.mockClear();
    selectTargets.mockResolvedValue(
      Array.from(
        { length: GITHUB_PULL_REQUEST_BY_NUMBER_BATCH_SIZE },
        (_, i) => ({
          pullRequestDetailId: `pr-detail-${i + 1}`,
          branchArtifactId: "branch-1",
          number: i + 1,
        })
      )
    );

    await reconcileTargetedSessionLinkedPullRequests(BASE_INPUT);

    expect(selectUnlinkedTargets).not.toHaveBeenCalled();
  });

  it("writes an unlinked OPEN row without promoting it and stamps a missing one", async () => {
    selectTargets.mockResolvedValue([]);
    selectUnlinkedTargets.mockResolvedValue([
      { pullRequestDetailId: "pr-detail-17", number: 17 },
      { pullRequestDetailId: "pr-detail-404", number: 404 },
    ]);
    pointRead.mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: {
        pullRequests: [pullRequest(17)],
        rateLimit: {
          cost: 1,
          remaining: 4999,
          resetAt: "2026-08-26T13:00:00.000Z",
          state: GitHubProviderBudgetState.Available,
        },
        pageInfo: { hasNextPage: false, endCursor: null },
        hasMore: false,
        truncated: false,
        nextCursor: null,
        fetchedPages: 1,
        stopReason: GitHubBundledPullRequestsStopReason.Complete,
        missingNumbers: [404],
        attemptedNumbers: [17, 404],
        unattemptedNumbers: [],
      },
    });
    writePr.mockResolvedValue(true);

    const result = await reconcileTargetedSessionLinkedPullRequests(BASE_INPUT);

    expect(result).toMatchObject({
      status: TargetedReconcileStatus.Success,
      writtenCount: 1,
      targetNumbers: [17, 404],
    });
    expect(writePr).toHaveBeenCalledWith(
      expect.objectContaining({ number: 17 }),
      expect.objectContaining({ organizationId: "org-1" })
    );
    expect(promotePr).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith({
      where: { organizationId: "org-1", id: { in: ["pr-detail-404"] } },
      data: { lastRefreshAttemptAt: NOW },
    });
  });
});

function pullRequest(number: number): GitHubReadModelPullRequest {
  return {
    githubId: `PR_node_${number}`,
    number,
    title: `PR ${number}`,
    htmlUrl: `https://github.com/acme/widgets/pull/${number}`,
    headBranch: `feature-${number}`,
    baseBranch: "main",
    headSha: "abc123",
    state: GitHubPRState.Open,
    isDraft: false,
    additions: 2,
    deletions: 1,
    changedFiles: 1,
    reviewDecision: null,
    checksStatus: null,
    statusCheckRollup: null,
    openedAt: "2026-08-26T11:00:00.000Z",
    closedAt: null,
    mergedAt: null,
    mergeCommitSha: null,
    updatedAt: "2026-08-26T12:05:00.000Z",
    author: "octocat",
    source: GitHubReadModelSource.Provider,
  };
}
