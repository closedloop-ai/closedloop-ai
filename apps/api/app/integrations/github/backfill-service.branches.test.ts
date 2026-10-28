import {
  GitHubBackfillStatus,
  GitHubCredentialKind,
} from "@repo/api/src/types/github";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
  GitHubProviderBudgetState,
} from "@repo/api/src/types/github-read-model";
import { RepositoryDefaultSource } from "@repo/api/src/types/repository-default-identity";
import type * as DatabaseModule from "@repo/database";
import { ArtifactType } from "@repo/database";
import type * as GitHubModule from "@repo/github";
import { GitHubProviderResultStatus } from "@repo/github/provider-result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  backfillBundledPullRequests,
  backfillIssueComments,
  backfillProjectionDiff,
  backfillReviewComments,
  backfillReviews,
  backfillStatusCheckRollup,
  bundledPullRequest,
  makeCanonicalDetailRow,
} from "@/__tests__/support/integrations/github/backfill-service.test-fixtures";
import { cloudBranchCanonicalPullRequestSelect } from "@/app/branches/branch-canonical-pull-request-cloud";
import type * as ReconcileModule from "@/app/comments/service/github/github-comment-reconcile";
import type * as CandidatesModule from "./backfill-candidates";
import type * as TrackedPullRequestsModule from "./tracked-pull-requests";

/**
 * ISS-11280: the sweep branches `backfill-service.test.ts` does not reach — a
 * failed bundled read (with and without owner approval), a pooled-token owner
 * on the provenance, a low provider budget, a rejected per-PR metadata task,
 * a PR with no head SHA, failed review/rollup reads, a branch artifact with no
 * branch detail, and a missing organization row on the status surface.
 *
 * Mocked one layer closer than the sibling suite — at the run gate, the
 * settings writer, the candidate reads, and the sync-client feedback — so each
 * case can assert the exact call the sweep makes to its collaborator.
 */

const claimOrganizationRunMock = vi.fn();
const releaseOrganizationRunMock = vi.fn();
const isOrganizationRunInFlightMock = vi.fn();
const writeOrganizationSettingsKeyMock = vi.fn();
const getBackfillCandidatesMock = vi.fn();
const readBackfillRepositoryListCountsMock = vi.fn();
const getGitHubSyncClientMock = vi.fn();
const recordRateLimitsMock = vi.fn();
const recordNoAccessMock = vi.fn();
const recordRepoReachedMock = vi.fn();
const writeReconciledFailuresMock = vi.fn();
const projectionDiffMock = vi.fn();
const projectionWriteMock = vi.fn();
const artifactFindManyMock = vi.fn();
const organizationFindUniqueMock = vi.fn();
const queryBundledPullRequestsMock = vi.fn();
const listIssueCommentsMock = vi.fn();
const listReviewCommentsMock = vi.fn();
const listReviewsMock = vi.fn();
const reconcilePullRequestCommentsMock = vi.fn();
const queryStatusCheckRollupMock = vi.fn();
const extractTrackedPullRequestNumbersMock = vi.fn();

const octokit = { kind: "sync-client-octokit" };

vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<typeof DatabaseModule>()),
  withDb: (callback: (db: unknown) => unknown) =>
    callback({
      artifact: { findMany: artifactFindManyMock },
      organization: { findUnique: organizationFindUniqueMock },
    }),
}));

vi.mock("@repo/github", async (importOriginal) => {
  const actual = await importOriginal<typeof GitHubModule>();
  return {
    GitHubProviderResultStatus: actual.GitHubProviderResultStatus,
    queryBundledPullRequestsWithProviderResult: queryBundledPullRequestsMock,
    queryStatusCheckRollupWithProviderResult: queryStatusCheckRollupMock,
  };
});

vi.mock("@/lib/organization-run-gate", () => ({
  claimOrganizationRun: claimOrganizationRunMock,
  isOrganizationRunInFlight: isOrganizationRunInFlightMock,
  releaseOrganizationRun: releaseOrganizationRunMock,
}));

vi.mock("@/lib/organization-settings-write", () => ({
  writeOrganizationSettingsKey: writeOrganizationSettingsKeyMock,
}));

vi.mock("./backfill-candidates", async (importOriginal) => ({
  ...(await importOriginal<typeof CandidatesModule>()),
  getBackfillCandidates: getBackfillCandidatesMock,
  readBackfillRepositoryListCounts: readBackfillRepositoryListCountsMock,
}));

// PLN-2122: the sweep reads complete comment and review lists.
vi.mock("@repo/github/pull-request-comment-lists", () => ({
  listAllPullRequestIssueComments: listIssueCommentsMock,
  listAllPullRequestReviewComments: listReviewCommentsMock,
  listAllPullRequestReviews: listReviewsMock,
}));

vi.mock(
  "@/app/comments/service/github/github-comment-reconcile",
  async (importOriginal) => ({
    ...(await importOriginal<typeof ReconcileModule>()),
    GitHubCommentReconcileTrigger: { Backfill: "backfill" },
    reconcilePullRequestComments: reconcilePullRequestCommentsMock,
  })
);

vi.mock("@/lib/github/github-sync-client-pool", () => ({
  getGitHubSyncClient: getGitHubSyncClientMock,
}));

vi.mock("@/lib/github/github-sync-client-feedback", () => ({
  recordSyncClientNoAccessIfRepoDenied: recordNoAccessMock,
  recordSyncClientRateLimits: recordRateLimitsMock,
  recordSyncClientRepoReached: recordRepoReachedMock,
}));

vi.mock(
  "@/app/cron/reconcile-pull-requests/reconcile-projection-write",
  () => ({
    writeReconciledPullRequestFailures: writeReconciledFailuresMock,
  })
);

vi.mock("./tracked-pull-requests", async (importOriginal) => ({
  ...(await importOriginal<typeof TrackedPullRequestsModule>()),
  extractTrackedPullRequestNumbers: extractTrackedPullRequestNumbersMock,
}));

vi.mock("./backfill-projection-writer", () => ({
  githubBackfillProjectionWriter: {
    diff: projectionDiffMock,
    write: projectionWriteMock,
  },
}));

const { BACKFILL_RUN_GATE_SETTINGS_KEY, githubBackfillService } = await import(
  "./backfill-service"
);
const { GitHubBackfillLane } = await import("./backfill-candidates");
const { GitHubCommentReconcileStatus } = await import(
  "@/app/comments/service/github/github-comment-reconcile"
);
const actualTrackedPullRequests = await vi.importActual<
  typeof TrackedPullRequestsModule
>("./tracked-pull-requests");

const ORGANIZATION_ID = "org-1";
const REPOSITORY_FULL_NAME = "closedloop-ai/closedloop-ai";
const FEEDBACK_CONTEXT = {
  logPrefix: "[github/backfill]",
  organizationId: ORGANIZATION_ID,
  repositoryFullName: REPOSITORY_FULL_NAME,
};

describe("githubBackfillService sweep branches", () => {
  beforeEach(() => {
    reconcilePullRequestCommentsMock.mockResolvedValue({
      status: GitHubCommentReconcileStatus.Reconciled,
    });
    claimOrganizationRunMock.mockResolvedValue({ claimed: true });
    releaseOrganizationRunMock.mockResolvedValue(undefined);
    writeOrganizationSettingsKeyMock.mockResolvedValue(undefined);
    getBackfillCandidatesMock.mockResolvedValue([
      {
        lane: GitHubBackfillLane.Installation,
        repositoryId: "repo-1",
        fullName: REPOSITORY_FULL_NAME,
        owner: "closedloop-ai",
        name: "closedloop-ai",
      },
    ]);
    readBackfillRepositoryListCountsMock.mockResolvedValue({
      branchCount: 3,
      pullRequestCount: 4,
      observations: [],
    });
    getGitHubSyncClientMock.mockResolvedValue({
      ok: true,
      value: syncClient(GitHubCredentialKind.Installation, null),
    });
    recordRateLimitsMock.mockResolvedValue(undefined);
    recordNoAccessMock.mockResolvedValue(undefined);
    recordRepoReachedMock.mockResolvedValue(undefined);
    writeReconciledFailuresMock.mockResolvedValue(0);
    artifactFindManyMock.mockResolvedValue([]);
    queryBundledPullRequestsMock.mockResolvedValue(
      backfillBundledPullRequests()
    );
    listIssueCommentsMock.mockResolvedValue(backfillIssueComments());
    listReviewCommentsMock.mockResolvedValue(backfillReviewComments());
    listReviewsMock.mockResolvedValue(backfillReviews());
    queryStatusCheckRollupMock.mockResolvedValue(backfillStatusCheckRollup());
    projectionDiffMock.mockResolvedValue(backfillProjectionDiff());
    projectionWriteMock.mockResolvedValue(backfillProjectionDiff());
    // Pass-through spy: the real extractor, observable only for its input.
    extractTrackedPullRequestNumbersMock.mockImplementation(
      actualTrackedPullRequests.extractTrackedPullRequestNumbers
    );
  });

  it("writes reconciled failures for an owner-approved sweep whose bundled read failed", async () => {
    const failedRead = { status: GitHubProviderResultStatus.ProviderRateLimit };
    queryBundledPullRequestsMock.mockResolvedValue(failedRead);

    const summary = await githubBackfillService.runPostConnectBackfill({
      organizationId: ORGANIZATION_ID,
      approvedForVisibleWrites: true,
    });

    expect(summary.failures).toEqual([
      `${REPOSITORY_FULL_NAME}:${GitHubProviderResultStatus.ProviderRateLimit}`,
    ]);
    expect(summary.status).toBe(GitHubBackfillStatus.Degraded);
    // The list counts still land; the projection never ran, so its counts stay 0.
    expect(summary.branchCount).toBe(3);
    expect(summary.pullRequestCount).toBe(4);
    expect(summary.pullRequestProjectionChangeCount).toBe(0);
    expect(writeReconciledFailuresMock).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      repositoryId: "repo-1",
      repositoryFullName: REPOSITORY_FULL_NAME,
      pullRequestNumbers: [],
      result: failedRead,
      // Exact: an installation client has no owner, so no credentialOwnerId key.
      provenance: {
        source: RepositoryDefaultSource.PullRequestGraphql,
        mechanism: GitHubFetchMechanism.Graphql,
        trigger: GitHubFetchTrigger.Backfill,
        credentialType: GitHubFetchCredentialType.GitHubApp,
        observationKey: expect.any(String),
        observedAt: expect.any(String),
      },
    });
    expect(recordNoAccessMock).toHaveBeenCalledWith(
      expect.objectContaining({ octokit }),
      GitHubProviderResultStatus.ProviderRateLimit,
      FEEDBACK_CONTEXT
    );
    expect(recordRepoReachedMock).not.toHaveBeenCalled();
    expect(listIssueCommentsMock).not.toHaveBeenCalled();
    expect(projectionWriteMock).not.toHaveBeenCalled();
  });

  it("records a failed bundled read without writing on a dry run", async () => {
    queryBundledPullRequestsMock.mockResolvedValue({
      status: GitHubProviderResultStatus.ProviderRepoNotFound,
    });

    const summary = await githubBackfillService.runPostConnectBackfill({
      organizationId: ORGANIZATION_ID,
    });

    expect(summary.failures).toEqual([
      `${REPOSITORY_FULL_NAME}:${GitHubProviderResultStatus.ProviderRepoNotFound}`,
    ]);
    expect(writeReconciledFailuresMock).not.toHaveBeenCalled();
    expect(recordNoAccessMock).toHaveBeenCalledWith(
      expect.objectContaining({ octokit }),
      GitHubProviderResultStatus.ProviderRepoNotFound,
      FEEDBACK_CONTEXT
    );
    expect(projectionDiffMock).not.toHaveBeenCalled();
  });

  it("stamps a pooled token's owner onto the read context and the write credential", async () => {
    getGitHubSyncClientMock.mockResolvedValue({
      ok: true,
      value: syncClient(GitHubCredentialKind.OauthUser, "user-9"),
    });

    await githubBackfillService.runPostConnectBackfill({
      organizationId: ORGANIZATION_ID,
      approvedForVisibleWrites: true,
    });

    expect(queryBundledPullRequestsMock).toHaveBeenCalledWith(
      octokit,
      "closedloop-ai",
      "closedloop-ai",
      [],
      { maxItems: undefined, maxPages: undefined, targetNumbers: [] },
      expect.any(Function),
      {
        mechanism: GitHubFetchMechanism.Graphql,
        trigger: GitHubFetchTrigger.Backfill,
        credentialType: GitHubFetchCredentialType.UserOAuth,
        credentialOwnerId: "user-9",
        observationKey: expect.any(String),
        observedAt: expect.any(String),
      }
    );
    expect(projectionWriteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        credential: {
          type: GitHubFetchCredentialType.UserOAuth,
          ownerId: "user-9",
        },
      })
    );
  });

  it("degrades the run when the provider budget is low but still applies the diff", async () => {
    const bundled = backfillBundledPullRequests();
    queryBundledPullRequestsMock.mockResolvedValue({
      ...bundled,
      value: {
        ...bundled.value,
        rateLimit: {
          ...bundled.value.rateLimit,
          state: GitHubProviderBudgetState.Low,
        },
      },
    });

    const summary = await githubBackfillService.runPostConnectBackfill({
      organizationId: ORGANIZATION_ID,
    });

    expect(summary.failures).toEqual([
      `${REPOSITORY_FULL_NAME}:provider_budget_low`,
    ]);
    expect(summary.status).toBe(GitHubBackfillStatus.Degraded);
    expect(summary.pullRequestProjectionChangeCount).toBe(1);
  });

  it("records a rejected metadata task and still projects the other PRs", async () => {
    queryBundledPullRequestsMock.mockResolvedValue(
      bundledWith([bundledPullRequest(1), bundledPullRequest(2)])
    );
    listIssueCommentsMock.mockImplementation(
      (_octokit: unknown, _owner: string, _repo: string, number: number) =>
        number === 2
          ? Promise.reject(new Error("socket hang up"))
          : Promise.resolve(backfillIssueComments())
    );

    const summary = await githubBackfillService.runPostConnectBackfill({
      organizationId: ORGANIZATION_ID,
    });

    expect(summary.failures).toEqual([
      `${REPOSITORY_FULL_NAME}#2:metadata:rejected`,
    ]);
    expect(projectionDiffMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pullRequestMetadata: [expect.objectContaining({ number: 1 })],
      })
    );
  });

  it("skips the status-check read for a PR with no head SHA without reporting a failure", async () => {
    queryBundledPullRequestsMock.mockResolvedValue(
      bundledWith([{ ...bundledPullRequest(5), headSha: null }])
    );

    const summary = await githubBackfillService.runPostConnectBackfill({
      organizationId: ORGANIZATION_ID,
    });

    expect(queryStatusCheckRollupMock).not.toHaveBeenCalled();
    expect(summary.failures).toEqual([]);
    expect(summary.status).toBe(GitHubBackfillStatus.OwnerApprovalRequired);
    expect(projectionDiffMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pullRequestMetadata: [
          expect.objectContaining({ number: 5, statusCheckRollup: null }),
        ],
      })
    );
  });

  it("empties failed review and rollup reads and names each failure", async () => {
    listReviewsMock.mockResolvedValue({
      status: GitHubProviderResultStatus.ProviderUnavailable,
    });
    queryStatusCheckRollupMock.mockResolvedValue({
      status: GitHubProviderResultStatus.ProviderRateLimit,
    });

    const summary = await githubBackfillService.runPostConnectBackfill({
      organizationId: ORGANIZATION_ID,
    });

    expect(summary.failures).toEqual([
      `${REPOSITORY_FULL_NAME}#1:reviews:${GitHubProviderResultStatus.ProviderUnavailable}`,
      `${REPOSITORY_FULL_NAME}#1:statusCheckRollup:${GitHubProviderResultStatus.ProviderRateLimit}`,
    ]);
    expect(projectionDiffMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pullRequestMetadata: [
          expect.objectContaining({ reviews: [], statusCheckRollup: null }),
        ],
      })
    );
  });

  it("skips a branch artifact with no branch detail when collecting PR targets", async () => {
    artifactFindManyMock.mockResolvedValue([
      {
        id: "orphan-artifact",
        branch: null,
        pullRequestDetails: [
          makeCanonicalDetailRow({
            id: "pr-orphan",
            number: 77,
            htmlUrl: "https://github.com/closedloop-ai/closedloop-ai/pull/77",
          }),
        ],
      },
      {
        id: "branch-1",
        branch: {
          currentPullRequestDetailId: "pr-live",
          repositoryId: "repo-1",
          repositoryFullName: REPOSITORY_FULL_NAME,
          repository: { fullName: REPOSITORY_FULL_NAME },
        },
        pullRequestDetails: [makeCanonicalDetailRow()],
      },
    ]);

    const summary = await githubBackfillService.runPostConnectBackfill({
      organizationId: ORGANIZATION_ID,
    });

    expect(summary.failures).toEqual([]);
    // The orphan contributes nothing to the URL list — not even an entry the
    // extractor would later discard.
    expect(extractTrackedPullRequestNumbersMock).toHaveBeenCalledWith(
      REPOSITORY_FULL_NAME,
      ["https://github.com/closedloop-ai/closedloop-ai/pull/150"]
    );
    // The installation lane selects by repository id on BOTH the branch and its
    // PR candidates, always inside the organization.
    expect(artifactFindManyMock).toHaveBeenCalledWith({
      where: {
        organizationId: ORGANIZATION_ID,
        type: ArtifactType.BRANCH,
        branch: { repositoryId: "repo-1" },
      },
      select: {
        id: true,
        branch: {
          select: {
            currentPullRequestDetailId: true,
            repositoryId: true,
            repositoryFullName: true,
            repository: { select: { fullName: true } },
          },
        },
        pullRequestDetails: {
          where: { repositoryId: "repo-1" },
          select: cloudBranchCanonicalPullRequestSelect,
        },
      },
    });
    expect(queryBundledPullRequestsMock).toHaveBeenCalledWith(
      octokit,
      "closedloop-ai",
      "closedloop-ai",
      [150],
      expect.objectContaining({ targetNumbers: [150] }),
      expect.any(Function),
      expect.anything()
    );
  });

  it("reconciles each projected pull request's comments from the lists the sweep read (PLN-2122 Step 4)", async () => {
    projectionWriteMock.mockImplementation(
      (input: {
        onPullRequestProjected?: (pullRequest: {
          number: number;
          pullRequestDetailId: string;
        }) => void;
      }) => {
        input.onPullRequestProjected?.({
          number: bundledPullRequest(1).number,
          pullRequestDetailId: "pr-detail-1",
        });
        return Promise.resolve(backfillProjectionDiff());
      }
    );

    await githubBackfillService.runPostConnectBackfill({
      organizationId: ORGANIZATION_ID,
      approvedForVisibleWrites: true,
    });

    expect(reconcilePullRequestCommentsMock).toHaveBeenCalledTimes(1);
    expect(reconcilePullRequestCommentsMock).toHaveBeenCalledWith({
      pullRequestDetailId: "pr-detail-1",
      prefetched: {
        issueComments: backfillIssueComments(),
        reviewComments: backfillReviewComments(),
        reviews: backfillReviews(),
        listedAt: expect.any(Date),
        fetchProvenance: expect.objectContaining({
          mechanism: GitHubFetchMechanism.Backfill,
          trigger: GitHubFetchTrigger.Backfill,
        }),
      },
    });
  });

  it("reconciles no comments on a dry run", async () => {
    await githubBackfillService.runPostConnectBackfill({
      organizationId: ORGANIZATION_ID,
    });

    expect(projectionDiffMock).toHaveBeenCalled();
    expect(reconcilePullRequestCommentsMock).not.toHaveBeenCalled();
  });
});

describe("githubBackfillService.getLatestBackfillSummary", () => {
  it("reports not_started when the organization row is missing", async () => {
    organizationFindUniqueMock.mockResolvedValue(null);
    isOrganizationRunInFlightMock.mockReturnValue(false);

    const summary =
      await githubBackfillService.getLatestBackfillSummary(ORGANIZATION_ID);

    expect(summary.status).toBe(GitHubBackfillStatus.NotStarted);
    expect(summary.repositoryCount).toBe(0);
    expect(organizationFindUniqueMock).toHaveBeenCalledWith({
      where: { id: ORGANIZATION_ID },
      select: { settings: true },
    });
    expect(isOrganizationRunInFlightMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ settingsKey: BACKFILL_RUN_GATE_SETTINGS_KEY })
    );
  });
});

function syncClient(
  kind: GitHubCredentialKind,
  credentialOwnerId: string | null
) {
  return {
    octokit,
    kind,
    actingAs: { installationId: "123" },
    credentialOwnerId,
    rateLimitTier: null,
    recordRateLimit: vi.fn(),
    recordRepoAccess: vi.fn(),
  };
}

function bundledWith(pullRequests: BundledPullRequestRow[]) {
  const bundled = backfillBundledPullRequests();
  return { ...bundled, value: { ...bundled.value, pullRequests } };
}

type BundledPullRequestRow = Omit<
  ReturnType<typeof bundledPullRequest>,
  "headSha"
> & { headSha: string | null };
