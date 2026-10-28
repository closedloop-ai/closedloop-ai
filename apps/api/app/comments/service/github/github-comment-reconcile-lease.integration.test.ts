/**
 * ISS-11212 (PLN-2122 Step 5): a reconcile whose lists only partly arrived
 * applies the ones that did and leaves the pull request due; the attempt is
 * stamped when the lease is claimed; and a run releases only its own lease.
 */
import { GitHubCredentialKind } from "@repo/api/src/types/github";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { GitHubProviderResultStatus } from "@repo/github/provider-result";
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

import {
  applyInput,
  issueCommentEvent,
  providerIssueComment,
  reviewThreadEvent,
  storedComment,
} from "@/__tests__/support/comments/github-apply-external.test-fixtures";
import {
  list,
  lists,
  marker,
  reconcile,
  seed,
} from "@/__tests__/support/comments/github-comment-reconcile.test-fixtures";
import { autoRollbackTransactionJoining } from "@/__tests__/utils/db-helpers";
import { applyExternal } from "./apply-external";
import { GitHubCommentReconcileStatus } from "./github-comment-reconcile";
import { readPullRequestCommentsReconcileMarker } from "./github-comment-reconcile-marker";

const APP_CLOCK_BEHIND_DATABASE = new Date("2001-01-01T00:00:00.000Z");

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const joinAmbientTransaction = autoRollbackTransactionJoining(
  "every case asserts the reconcile's outcome, stored rows and lease stamps, not the per-chunk transaction boundary"
);

describeIfDb(
  "reconcilePullRequestComments — partial lists and the run's own lease",
  () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("stamps the attempt and the reconcile from the database clock, so an app clock behind it cannot read a complete run as failed", async () => {
      await joinAmbientTransaction(async () => {
        const scope = await seed();
        const [clock] = await withDb(
          (db) =>
            db.$queryRaw<{ databaseNow: Date }[]>`
            SELECT now()::timestamp(3) AS "databaseNow"
          `
        );
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(APP_CLOCK_BEHIND_DATABASE);

        const result = await reconcile(scope, lists());

        vi.useRealTimers();
        expect(result.status).toBe(GitHubCommentReconcileStatus.Reconciled);
        expect(await marker(scope)).toEqual({
          commentsReconciledAt: clock?.databaseNow,
          commentsReconcileClaimedAt: null,
          commentsReconcileAttemptedAt: clock?.databaseNow,
        });
        expect(
          await readPullRequestCommentsReconcileMarker(
            scope.organizationId,
            scope.pullRequestDetailId
          )
        ).toEqual(expect.objectContaining({ latestAttemptFailed: false }));
      });
    });

    it("applies the lists that were read when one fails, skips the failed kind's cleanup, and leaves the PR due", async () => {
      await joinAmbientTransaction(async () => {
        const scope = await seed();
        await applyExternal(
          applyInput(scope, [issueCommentEvent(9999), reviewThreadEvent(8999)])
        );

        const result = await reconcile(
          scope,
          lists({
            issueComments: list([providerIssueComment(1)]),
            reviewComments: {
              status: GitHubProviderResultStatus.ProviderUnavailable,
            },
          })
        );

        expect(result).toEqual(
          expect.objectContaining({
            status: GitHubCommentReconcileStatus.ProviderError,
            errorCode: GitHubProviderResultStatus.ProviderUnavailable,
            reasons: [],
          })
        );
        expect(await storedComment(scope, 1)).not.toBeNull();
        expect(
          (await storedComment(scope, 9999))?.comment.deletedAt
        ).not.toBeNull();
        expect(
          (await storedComment(scope, 8999))?.comment.deletedAt
        ).toBeNull();
        expect(await marker(scope)).toEqual({
          commentsReconciledAt: null,
          commentsReconcileClaimedAt: null,
          commentsReconcileAttemptedAt: expect.any(Date),
        });
      });
    });

    it("applies nothing when every list fails, and releases the lease", async () => {
      await joinAmbientTransaction(async () => {
        const scope = await seed();
        const failed = {
          status: GitHubProviderResultStatus.ProviderUnavailable,
        };

        const result = await reconcile(
          scope,
          lists({
            issueComments: failed,
            reviewComments: failed,
            reviews: failed,
          })
        );

        expect(result).toEqual(
          expect.objectContaining({
            status: GitHubCommentReconcileStatus.ProviderError,
            errorCode: GitHubProviderResultStatus.ProviderUnavailable,
            appliedEvents: 0,
          })
        );
        expect(await marker(scope)).toEqual({
          commentsReconciledAt: null,
          commentsReconcileClaimedAt: null,
          commentsReconcileAttemptedAt: expect.any(Date),
        });
      });
    });

    it("stamps the attempt when it claims, before any list is read", async () => {
      await joinAmbientTransaction(async () => {
        const scope = await seed();
        listerMocks.getGitHubSyncClient.mockResolvedValue({
          ok: true,
          value: {
            octokit: {},
            kind: GitHubCredentialKind.Installation,
            credentialOwnerId: null,
          },
        });
        let duringRead: Awaited<ReturnType<typeof marker>> | null = null;
        listerMocks.issueComments.mockImplementation(async () => {
          duringRead = await marker(scope);
          return list([]);
        });
        listerMocks.reviewComments.mockResolvedValue(list([]));
        listerMocks.reviews.mockResolvedValue(list([]));

        await reconcile(scope);

        expect(duringRead).toEqual({
          commentsReconciledAt: null,
          commentsReconcileClaimedAt: expect.any(Date),
          commentsReconcileAttemptedAt: expect.any(Date),
        });
      });
    });

    it("leaves a lease a later run took over, and its reconciled stamp, alone", async () => {
      await joinAmbientTransaction(async () => {
        const scope = await seed();
        const laterLease = new Date(Date.now() + 60_000);
        listerMocks.getGitHubSyncClient.mockResolvedValue({
          ok: true,
          value: {
            octokit: {},
            kind: GitHubCredentialKind.Installation,
            credentialOwnerId: null,
          },
        });
        listerMocks.issueComments.mockImplementation(async () => {
          await withDb((db) =>
            db.pullRequestDetail.update({
              where: { id: scope.pullRequestDetailId },
              data: { commentsReconcileClaimedAt: laterLease },
            })
          );
          return list([]);
        });
        listerMocks.reviewComments.mockResolvedValue(list([]));
        listerMocks.reviews.mockResolvedValue(list([]));

        const result = await reconcile(scope);

        expect(result.status).toBe(GitHubCommentReconcileStatus.Reconciled);
        expect(await marker(scope)).toEqual(
          expect.objectContaining({
            commentsReconciledAt: null,
            commentsReconcileClaimedAt: laterLease,
          })
        );
      });
    });
  }
);
