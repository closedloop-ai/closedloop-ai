/**
 * ISS-11212 (PLN-2122 Step 5, acceptance criterion 7): the reconcile applies
 * every row of complete provider lists past any page boundary, deletes what a
 * complete list no longer holds, never cleans up after an incomplete list, and
 * keeps its lease and reconciled marker honest. Lists are handed in as the
 * listers return them, or read through mocked listers for the fetch path.
 */
import {
  GitHubAccessDenialReason,
  GitHubCredentialKind,
} from "@repo/api/src/types/github";
import { GitHubCommentThreadKind, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  at,
  type GitHubCommentScope,
  issueCommentEvent,
  providerIssueComment,
  providerReview,
  providerReviewComment,
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
import { GitHubExternalEventKind } from "./apply-external-events";
import {
  GitHubCommentReconcileReason,
  GitHubCommentReconcileStatus,
} from "./github-comment-reconcile";
import { RECONCILE_COMMENTS_PER_APPLY } from "./github-comment-reconcile-events";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const joinAmbientTransaction = autoRollbackTransactionJoining(
  "every case asserts the reconcile's outcome and stored rows, not the per-chunk transaction boundary; the chunk cap is pinned by the chunking unit test"
);
// Under the integration tier's 30s testTimeout, which the tier budget guard
// (`__tests__/integration-suite-timeout-budget.test.ts`) holds every bound to.
const HEAVY = { timeout: 25_000 };

function range(from: number, count: number): number[] {
  return Array.from({ length: count }, (_, index) => from + index);
}

async function liveCount(
  scope: GitHubCommentScope,
  threadKind: GitHubCommentThreadKind
): Promise<number> {
  return await withDb((db) =>
    db.gitHubCommentProjection.count({
      where: {
        githubDeletedAt: null,
        comment: { deletedAt: null },
        threadProjection: {
          branchArtifactId: scope.branchArtifactId,
          threadKind,
        },
      },
    })
  );
}

describeIfDb("reconcilePullRequestComments — completeness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stores every row of 130-comment lists and removes the one deleted upstream", async () => {
    await joinAmbientTransaction(async () => {
      const scope = await seed();
      await applyExternal(
        applyInput(scope, [issueCommentEvent(9999), reviewThreadEvent(8999)])
      );

      const result = await reconcile(
        scope,
        lists({
          issueComments: list(
            range(1, 130).map((id) => providerIssueComment(id))
          ),
          reviewComments: list(
            range(1001, 130).map((id) => providerReviewComment(id))
          ),
        })
      );

      expect(result.status).toBe(GitHubCommentReconcileStatus.Reconciled);
      expect(
        await liveCount(scope, GitHubCommentThreadKind.ISSUE_COMMENT)
      ).toBe(130);
      expect(
        await liveCount(scope, GitHubCommentThreadKind.REVIEW_THREAD)
      ).toBe(130);
      expect(
        (await storedComment(scope, 9999))?.comment.deletedAt
      ).not.toBeNull();
      expect(
        (await storedComment(scope, 8999))?.comment.deletedAt
      ).not.toBeNull();
      const after = await marker(scope);
      expect(after.commentsReconciledAt).not.toBeNull();
      expect(after.commentsReconcileAttemptedAt).not.toBeNull();
      expect(after.commentsReconcileClaimedAt).toBeNull();
    }, HEAVY);
  });

  it("deletes more stale comments than one cleanup call holds", async () => {
    await joinAmbientTransaction(async () => {
      const scope = await seed();
      const stale = range(1, RECONCILE_COMMENTS_PER_APPLY + 1);
      await applyExternal(
        applyInput(
          scope,
          stale.map((id) => issueCommentEvent(id))
        )
      );

      const result = await reconcile(scope, lists());

      expect(result.status).toBe(GitHubCommentReconcileStatus.Reconciled);
      expect(
        await liveCount(scope, GitHubCommentThreadKind.ISSUE_COMMENT)
      ).toBe(0);
      for (const id of [stale[0], stale.at(-1)] as number[]) {
        expect(
          (await storedComment(scope, id))?.threadProjection.deletedAt
        ).not.toBeNull();
      }
    }, HEAVY);
  });

  it.each([100, 101])("stores every row of a %i-row list", async (count) => {
    await joinAmbientTransaction(async () => {
      const scope = await seed();

      await reconcile(
        scope,
        lists({
          issueComments: list(
            range(1, count).map((id) => providerIssueComment(id))
          ),
        })
      );

      expect(
        await liveCount(scope, GitHubCommentThreadKind.ISSUE_COMMENT)
      ).toBe(count);
    }, HEAVY);
  });

  it("applies a ceiling-hit list's rows but skips its cleanup and leaves the PR unreconciled", async () => {
    await joinAmbientTransaction(async () => {
      const scope = await seed();
      await applyExternal(applyInput(scope, [issueCommentEvent(9999)]));

      const result = await reconcile(
        scope,
        lists({
          issueComments: list(
            range(1, 3).map((id) => providerIssueComment(id)),
            false
          ),
        })
      );

      expect(result.status).toBe(GitHubCommentReconcileStatus.Partial);
      expect(result.reasons).toEqual([
        GitHubCommentReconcileReason.ListCeiling,
      ]);
      expect(
        await liveCount(scope, GitHubCommentThreadKind.ISSUE_COMMENT)
      ).toBe(4);
      expect((await storedComment(scope, 9999))?.comment.deletedAt).toBeNull();
      expect((await marker(scope)).commentsReconciledAt).toBeNull();
    });
  });

  it("stores non-blank review bodies as summary threads and skips blank ones", async () => {
    await joinAmbientTransaction(async () => {
      const scope = await seed();

      await reconcile(
        scope,
        lists({
          reviews: list([
            providerReview(501, "Looks good"),
            providerReview(502, "  "),
          ]),
        })
      );

      expect(
        await liveCount(scope, GitHubCommentThreadKind.REVIEW_SUMMARY)
      ).toBe(1);
      expect((await storedComment(scope, 501))?.comment.plainText).toBe(
        "Looks good"
      );
    });
  });
});

describeIfDb(
  "reconcilePullRequestComments — writes after the lists were read",
  () => {
    const MINUTE = 60_000;

    it("keeps a comment a webhook created after the lists were read", async () => {
      await joinAmbientTransaction(async () => {
        const scope = await seed();
        const listedAt = new Date(Date.now() - MINUTE);
        const createdLater = new Date();
        await applyExternal(
          applyInput(scope, [
            issueCommentEvent(77, {
              createdAt: createdLater,
              providerUpdatedAt: createdLater,
            }),
          ])
        );

        await reconcile(
          scope,
          lists({ issueComments: list([providerIssueComment(1)]), listedAt })
        );

        const kept = await storedComment(scope, 77);
        expect(kept?.comment.deletedAt).toBeNull();
        expect(kept?.threadProjection.deletedAt).toBeNull();
        expect(
          await liveCount(scope, GitHubCommentThreadKind.ISSUE_COMMENT)
        ).toBe(2);
      });
    });

    it("keeps a comment GitHub stamped in the second the lists were read", async () => {
      await joinAmbientTransaction(async () => {
        const scope = await seed();
        const second = Math.floor((Date.now() - MINUTE) / 1000) * 1000;
        const stampedInListSecond = new Date(second);
        await applyExternal(
          applyInput(scope, [
            issueCommentEvent(78, {
              createdAt: stampedInListSecond,
              providerUpdatedAt: stampedInListSecond,
            }),
          ])
        );

        await reconcile(
          scope,
          lists({
            issueComments: list([providerIssueComment(1)]),
            listedAt: new Date(second + 500),
          })
        );

        expect((await storedComment(scope, 78))?.comment.deletedAt).toBeNull();
      });
    });

    it("leaves deleted a comment whose delete landed after the lists were read", async () => {
      await joinAmbientTransaction(async () => {
        const scope = await seed();
        await applyExternal(
          applyInput(scope, [
            issueCommentEvent(5, { providerUpdatedAt: at(1) }),
          ])
        );
        const listedAt = new Date(Date.now() - MINUTE);
        await applyExternal(
          applyInput(scope, [
            {
              kind: GitHubExternalEventKind.CommentDelete,
              threadKind: GitHubCommentThreadKind.ISSUE_COMMENT,
              githubCommentId: 5,
              providerUpdatedAt: at(2),
            },
          ])
        );

        await reconcile(
          scope,
          lists({ issueComments: list([providerIssueComment(5)]), listedAt })
        );

        expect(
          (await storedComment(scope, 5))?.comment.deletedAt
        ).not.toBeNull();
      });
    });
  }
);

describeIfDb(
  "reconcilePullRequestComments — lease and provider failures",
  () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("does nothing while another run holds a lease younger than ten minutes", async () => {
      await joinAmbientTransaction(async () => {
        const scope = await seed();
        const claimedAt = new Date(Date.now() - 60_000);
        await withDb((db) =>
          db.pullRequestDetail.update({
            where: { id: scope.pullRequestDetailId },
            data: { commentsReconcileClaimedAt: claimedAt },
          })
        );

        const result = await reconcile(
          scope,
          lists({ issueComments: list([providerIssueComment(1)]) })
        );

        expect(result.status).toBe(GitHubCommentReconcileStatus.Claimed);
        expect(await storedComment(scope, 1)).toBeNull();
        expect((await marker(scope)).commentsReconcileClaimedAt).toEqual(
          claimedAt
        );
      });
    });

    it("takes over a lease older than ten minutes", async () => {
      await joinAmbientTransaction(async () => {
        const scope = await seed();
        await withDb((db) =>
          db.pullRequestDetail.update({
            where: { id: scope.pullRequestDetailId },
            data: {
              commentsReconcileClaimedAt: new Date(Date.now() - 11 * 60_000),
            },
          })
        );

        const result = await reconcile(
          scope,
          lists({ issueComments: list([providerIssueComment(1)]) })
        );

        expect(result.status).toBe(GitHubCommentReconcileStatus.Reconciled);
        expect(await storedComment(scope, 1)).not.toBeNull();
      });
    });

    it("reads the three lists with the drawn client when nothing is prefetched", async () => {
      await joinAmbientTransaction(async () => {
        const scope = await seed();
        const octokit = { marker: "pool-client" };
        listerMocks.getGitHubSyncClient.mockResolvedValue({
          ok: true,
          value: {
            octokit,
            kind: GitHubCredentialKind.Installation,
            credentialOwnerId: null,
          },
        });
        listerMocks.issueComments.mockResolvedValue(
          list([providerIssueComment(7)])
        );
        listerMocks.reviewComments.mockResolvedValue(list([]));
        listerMocks.reviews.mockResolvedValue(list([]));

        const result = await reconcile(scope);

        expect(result.status).toBe(GitHubCommentReconcileStatus.Reconciled);
        expect(listerMocks.getGitHubSyncClient).toHaveBeenCalledWith({
          organizationId: scope.organizationId,
          target: { owner: "acme", repo: "web" },
        });
        for (const lister of [
          listerMocks.issueComments,
          listerMocks.reviewComments,
          listerMocks.reviews,
        ]) {
          expect(lister).toHaveBeenCalledWith(octokit, "acme", "web", 42);
        }
        expect(await storedComment(scope, 7)).not.toBeNull();
      });
    });

    it("reports a refused credential as a provider error and reads nothing", async () => {
      await joinAmbientTransaction(async () => {
        const scope = await seed();
        listerMocks.getGitHubSyncClient.mockResolvedValue({
          ok: false,
          error: { reason: GitHubAccessDenialReason.NoInstallation },
        });

        const result = await reconcile(scope);

        expect(result.status).toBe(GitHubCommentReconcileStatus.ProviderError);
        expect(result.errorCode).toBe(GitHubAccessDenialReason.NoInstallation);
        expect(listerMocks.issueComments).not.toHaveBeenCalled();
        expect((await marker(scope)).commentsReconcileClaimedAt).toBeNull();
      });
    });
  }
);
