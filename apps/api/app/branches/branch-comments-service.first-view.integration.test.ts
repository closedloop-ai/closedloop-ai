/**
 * ISS-11212 (PLN-2122 Step 6): the Branch PR comments read serves stored rows
 * only. A pull request no complete reconcile covered is reconciled on first
 * view through the stored path, and freshness follows Kerensa's 2026-10-05
 * ruling. GitHub is reached only through the mocked sync client and listers.
 */
import {
  BranchCommentsFailureReason,
  BranchCommentsState,
} from "@repo/api/src/types/branch";
import {
  CommentSyncDirection,
  CommentSyncProvider,
  CommentSyncStatus,
} from "@repo/api/src/types/comment-thread-dto";
import {
  GitHubAccessDenialReason,
  GitHubCredentialKind,
} from "@repo/api/src/types/github";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listerMocks = vi.hoisted(() => ({
  issueComments: vi.fn(),
  reviewComments: vi.fn(),
  reviews: vi.fn(),
  getGitHubSyncClient: vi.fn(),
}));

vi.mock("@repo/github/pull-request-comment-lists", () => ({
  listAllPullRequestIssueComments: listerMocks.issueComments,
  listAllPullRequestReviewComments: listerMocks.reviewComments,
  listAllPullRequestReviews: listerMocks.reviews,
}));

vi.mock("@/lib/github/github-sync-client-pool", () => ({
  getGitHubSyncClient: listerMocks.getGitHubSyncClient,
}));

import { providerIssueComment } from "@/__tests__/support/comments/github-apply-external.test-fixtures";
import { list } from "@/__tests__/support/comments/github-comment-reconcile.test-fixtures";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import {
  type SeededOrg,
  SHARED_REPO_FULL_NAME,
  seedTwoOrgFixture,
} from "@/__tests__/utils/two-org-fixture";
import { reconcilePullRequestCommentsOnView } from "@/app/comments/service/github/github-comment-on-demand-reconcile";
import {
  GitHubCommentReconcileStatus,
  reconcilePullRequestComments,
} from "@/app/comments/service/github/github-comment-reconcile";
import { readPullRequestCommentsReconcileMarker } from "@/app/comments/service/github/github-comment-reconcile-marker";
import { branchCommentsService } from "./branch-comments-service";

const describeIfDb = keys().DATABASE_URL ? describe : describe.skip;
const organizations = createCommittedTestOrganizationTracker();

afterEach(() => organizations.cleanup());

describeIfDb(
  "branch PR comments read: stored rows and the first-view reconcile",
  () => {
    beforeEach(() => {
      vi.clearAllMocks();
      listerMocks.getGitHubSyncClient.mockResolvedValue({
        ok: true,
        value: {
          octokit: {},
          kind: GitHubCredentialKind.Installation,
          credentialOwnerId: null,
        },
      });
      listerMocks.issueComments.mockResolvedValue(
        list([providerIssueComment(11), providerIssueComment(12)])
      );
      listerMocks.reviewComments.mockResolvedValue(list([]));
      listerMocks.reviews.mockResolvedValue(list([]));
    });

    it("stores the comments on first view and returns them, then serves stored rows without reconciling again", async () => {
      const { org, pullRequestDetailId } = await seedPullRequest();

      const first = await read(org);

      expect(first).toMatchObject({
        state: BranchCommentsState.Populated,
        stale: false,
        mixedProjection: false,
      });
      expect(first?.comments.map((comment) => comment.body)).toEqual([
        "issue 11",
        "issue 12",
      ]);
      expect(listerMocks.getGitHubSyncClient).toHaveBeenCalledTimes(1);
      expect((await marker(pullRequestDetailId)).commentsReconciledAt).not.toBe(
        null
      );

      const second = await read(org);

      expect(second?.comments).toHaveLength(2);
      expect(listerMocks.getGitHubSyncClient).toHaveBeenCalledTimes(1);
    });

    it("returns SyncedEmpty proofed at the reconcile when the pull request has no comments", async () => {
      listerMocks.issueComments.mockResolvedValue(list([]));
      const { org, pullRequestDetailId } = await seedPullRequest();

      const result = await read(org);

      const { commentsReconciledAt } = await marker(pullRequestDetailId);
      expect(result).toMatchObject({
        state: BranchCommentsState.SyncedEmpty,
        providerProofedAt: commentsReconciledAt?.toISOString(),
        comments: [],
      });
    });

    it("returns ProviderError with an existing failure reason when the first-view reconcile fails", async () => {
      listerMocks.getGitHubSyncClient.mockResolvedValue({
        ok: false,
        error: { reason: GitHubAccessDenialReason.RateLimited },
      });
      const { org } = await seedPullRequest();

      const result = await read(org);

      expect(result).toMatchObject({
        state: BranchCommentsState.ProviderError,
        failureReason: BranchCommentsFailureReason.RateLimit,
        comments: [],
      });
      expect(listerMocks.issueComments).not.toHaveBeenCalled();
    });

    it("returns the generic ProviderError without reconciling again within the freshness floor after a first-view reconcile failed", async () => {
      listerMocks.getGitHubSyncClient.mockResolvedValue({
        ok: false,
        error: { reason: GitHubAccessDenialReason.RateLimited },
      });
      const { org } = await seedPullRequest();

      await read(org);
      const second = await read(org);

      expect(listerMocks.getGitHubSyncClient).toHaveBeenCalledTimes(1);
      expect(second).toMatchObject({
        state: BranchCommentsState.ProviderError,
        failureReason: BranchCommentsFailureReason.ProviderError,
        stale: false,
        comments: [],
      });
    });

    it("lets only the first of two views that both read the pull request due reach GitHub", async () => {
      const { org, pullRequestDetailId } = await seedPullRequest();
      const delayedViewMarker = await readPullRequestCommentsReconcileMarker(
        org.organizationId,
        pullRequestDetailId
      );
      expect(delayedViewMarker?.attemptDue).toBe(true);

      await read(org);
      const delayed =
        await reconcilePullRequestCommentsOnView(pullRequestDetailId);

      expect(delayed?.status).toBe(GitHubCommentReconcileStatus.Claimed);
      expect(listerMocks.getGitHubSyncClient).toHaveBeenCalledTimes(1);
    });

    it("keeps the cron's claim free of the freshness floor, which its due scan applies", async () => {
      const { org, pullRequestDetailId } = await seedPullRequest();
      await read(org);

      const cronRun = await reconcilePullRequestComments({
        pullRequestDetailId,
      });

      expect(cronRun.status).toBe(GitHubCommentReconcileStatus.Reconciled);
      expect(listerMocks.getGitHubSyncClient).toHaveBeenCalledTimes(2);
    });

    it("returns UnsyncedUnknown without reaching GitHub while another run holds the lease", async () => {
      const { org, pullRequestDetailId } = await seedPullRequest();
      await withDb((db) =>
        db.pullRequestDetail.update({
          where: { id: pullRequestDetailId },
          data: {
            commentsReconcileClaimedAt: new Date(),
            commentsReconcileAttemptedAt: new Date(),
          },
          select: { id: true },
        })
      );

      const result = await read(org);

      expect(result).toMatchObject({
        state: BranchCommentsState.UnsyncedUnknown,
        comments: [],
        providerProofedAt: null,
      });
      expect(listerMocks.getGitHubSyncClient).not.toHaveBeenCalled();
    });

    it("marks only the comment with an unconfirmed GitHub sync state stale", async () => {
      const { org } = await seedPullRequest();
      const stored = await read(org);
      const unconfirmed = stored?.comments[0]?.id;
      if (!unconfirmed) {
        throw new Error("first view stored no comment");
      }
      await withDb((db) =>
        db.commentSyncState.create({
          data: {
            organizationId: org.organizationId,
            commentId: unconfirmed,
            provider: CommentSyncProvider.Github,
            direction: CommentSyncDirection.Outbound,
            state: CommentSyncStatus.Failed,
          },
          select: { id: true },
        })
      );

      const result = await read(org);

      expect(result).toMatchObject({
        state: BranchCommentsState.StaleMixed,
        stale: true,
        mixedProjection: true,
      });
      expect(
        result?.comments.map(({ id, stale }) => ({
          unconfirmed: id === unconfirmed,
          stale,
        }))
      ).toEqual([
        { unconfirmed: true, stale: true },
        { unconfirmed: false, stale: false },
      ]);
    });

    describe("a pull request on a repository no installation lists (Kerensa, 2026-10-05)", () => {
      it("reconciles on first view with a pool credential and serves the stored rows", async () => {
        const { org } = await seedPullRequest(INSTALLATIONLESS_REPO_FULL_NAME);
        listerMocks.getGitHubSyncClient.mockResolvedValue({
          ok: true,
          value: {
            octokit: {},
            kind: GitHubCredentialKind.OauthUser,
            credentialOwnerId: org.userId,
          },
        });

        const result = await read(org, INSTALLATIONLESS_REPO_FULL_NAME);

        expect(listerMocks.getGitHubSyncClient).toHaveBeenCalledWith({
          organizationId: org.organizationId,
          target: { owner: "dev", repo: "local-repo" },
        });
        expect(result).toMatchObject({
          state: BranchCommentsState.Populated,
          repositoryFullName: INSTALLATIONLESS_REPO_FULL_NAME,
        });
        expect(result?.comments.map((comment) => comment.body)).toEqual([
          "issue 11",
          "issue 12",
        ]);
      });

      it("serves UnsyncedUnknown on the first and a later view when the org has no credential to draw", async () => {
        listerMocks.getGitHubSyncClient.mockResolvedValue({
          ok: false,
          error: { reason: GitHubAccessDenialReason.NotConnected },
        });
        const { org, pullRequestDetailId } = await seedPullRequest(
          INSTALLATIONLESS_REPO_FULL_NAME
        );

        const first = await read(org, INSTALLATIONLESS_REPO_FULL_NAME);
        const second = await read(org, INSTALLATIONLESS_REPO_FULL_NAME);

        expect(
          (await reconcileStamps(pullRequestDetailId))
            .commentsReconcileAttemptedAt
        ).not.toBeNull();
        expect(listerMocks.getGitHubSyncClient).toHaveBeenCalledTimes(1);
        for (const view of [first, second]) {
          expect(view).toMatchObject({
            state: BranchCommentsState.UnsyncedUnknown,
            providerProofedAt: null,
            stale: false,
            comments: [],
          });
          expect(view).not.toHaveProperty("failureReason");
        }
      });
    });

    it("marks every stored comment stale after a partial reconcile, which marks nothing reconciled", async () => {
      listerMocks.issueComments.mockResolvedValue(
        list([providerIssueComment(11)], false)
      );
      const { org, pullRequestDetailId } = await seedPullRequest();

      const result = await read(org);

      expect(
        (await marker(pullRequestDetailId)).commentsReconciledAt
      ).toBeNull();
      expect(result).toMatchObject({
        state: BranchCommentsState.StaleMixed,
        stale: true,
      });
      expect(result?.comments.map((comment) => comment.stale)).toEqual([true]);
    });
  }
);

/** A repository the seeded org's installation does not list. */
const INSTALLATIONLESS_REPO_FULL_NAME = "dev/local-repo";

async function seedPullRequest(
  repositoryFullName = SHARED_REPO_FULL_NAME
): Promise<{
  org: SeededOrg;
  pullRequestDetailId: string;
}> {
  const { orgA, orgB } = await seedTwoOrgFixture();
  organizations.track(orgA.organizationId);
  organizations.track(orgB.organizationId);
  const pullRequest = await withDb((db) =>
    db.pullRequestDetail.create({
      data: {
        organizationId: orgA.organizationId,
        branchArtifactId: orgA.branchArtifactId,
        repositoryId:
          repositoryFullName === SHARED_REPO_FULL_NAME
            ? orgA.repositoryId
            : null,
        repositoryFullName,
        number: 1,
        title: "First view",
      },
      select: { id: true },
    })
  );
  return { org: orgA, pullRequestDetailId: pullRequest.id };
}

function read(org: SeededOrg, repositoryFullName = SHARED_REPO_FULL_NAME) {
  return branchCommentsService.getBranchComments(
    org.organizationId,
    org.branchArtifactId,
    { repositoryFullName, pullRequestNumber: 1 }
  );
}

function reconcileStamps(pullRequestDetailId: string) {
  return withDb((db) =>
    db.pullRequestDetail.findUniqueOrThrow({
      where: { id: pullRequestDetailId },
      select: { commentsReconcileAttemptedAt: true },
    })
  );
}

function marker(pullRequestDetailId: string) {
  return withDb((db) =>
    db.pullRequestDetail.findUniqueOrThrow({
      where: { id: pullRequestDetailId },
      select: { commentsReconciledAt: true },
    })
  );
}
