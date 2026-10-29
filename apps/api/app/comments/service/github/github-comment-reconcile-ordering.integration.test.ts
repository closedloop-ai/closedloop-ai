/**
 * ISS-11212 review fixes against a real Postgres: what a reconcile's lists may
 * still overwrite once something newer has been written. A list carries no
 * ordering key for a review thread's resolution or for a review summary's
 * edited body (`edited` keeps `submitted_at`), so a write that lands after the
 * list was read must survive it; and while the previous API bundle still
 * serves, its projection timestamp counts as the stored key.
 */
import { GitHubCommentThreadKind, ThreadStatus, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { GitHubProviderResultStatus } from "@repo/github/provider-result";
import { describe, expect, it } from "vitest";
import {
  applyInput,
  at,
  type GitHubCommentScope,
  issueCommentEvent,
  providerIssueComment,
  providerReview,
  providerReviewComment,
  reviewThreadEvent,
  seedGitHubCommentScope,
  storedComment,
} from "@/__tests__/support/comments/github-apply-external.test-fixtures";
import {
  autoRollbackTransactionJoining,
  createTestOrganization,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { backfillFetchProvenance } from "@/lib/github-fetch-provenance";
import { GitHubReviewThreadResolutionAttributionKind } from "../thread-resolution";
import { applyExternal } from "./apply-external";
import {
  GitHubExternalEventKind,
  type GitHubReviewSummaryUpsertEvent,
} from "./apply-external-events";
import {
  GitHubCommentReconcileReason,
  GitHubCommentReconcileStatus,
  type PrefetchedReconcileLists,
  reconcilePullRequestComments,
} from "./github-comment-reconcile";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const joinAmbientTransaction = autoRollbackTransactionJoining(
  "every case asserts stored rows after sequential calls; none depends on a transaction boundary"
);

const ROOT_COMMENT_ID = 11;
const REVIEW_ID = 501;

function list<T>(
  items: T[],
  extra: { complete?: boolean; shifted?: true } = {}
) {
  return {
    status: GitHubProviderResultStatus.Success,
    value: { items, complete: extra.complete ?? true, ...extra },
  } as const;
}

function reconcile(
  scope: GitHubCommentScope,
  over: Partial<Omit<PrefetchedReconcileLists, "fetchProvenance">>
) {
  return reconcilePullRequestComments({
    pullRequestDetailId: scope.pullRequestDetailId,
    prefetched: {
      issueComments: list([]),
      reviewComments: list([]),
      reviews: list([]),
      listedAt: new Date(),
      fetchProvenance: backfillFetchProvenance(),
      ...over,
    },
  });
}

async function seed(): Promise<GitHubCommentScope> {
  return await seedGitHubCommentScope(await createTestOrganization());
}

async function storedThread(scope: GitHubCommentScope) {
  const stored = await storedComment(scope, ROOT_COMMENT_ID);
  return await withDb((db) =>
    db.commentThread.findUniqueOrThrow({
      where: { id: stored?.threadId ?? "" },
      select: {
        externalId: true,
        status: true,
        resolvedAt: true,
        resolvedById: true,
        metadata: true,
      },
    })
  );
}

/** A provider-confirmed resolution, as the review-thread webhook applies it. */
async function resolveByWebhook(
  scope: GitHubCommentScope,
  resolvedById: string
): Promise<void> {
  const { externalId } = await storedThread(scope);
  await applyExternal(
    applyInput(scope, [
      {
        kind: GitHubExternalEventKind.ThreadStatus,
        threadExternalId: externalId ?? "",
        resolved: true,
        resolvedAt: at(5),
        resolvedById,
        attribution: {
          kind: GitHubReviewThreadResolutionAttributionKind.ConnectedUser,
          githubUserId: "4242",
          githubNodeId: "U_4242",
          githubLogin: "octocat",
          source: "pull_request_review_thread",
          recordedAt: at(5).toISOString(),
        },
      },
    ])
  );
}

/** The stored root comment as the list returns it, so only its thread differs. */
function listedRootComment() {
  return providerReviewComment(ROOT_COMMENT_ID, {
    body: `body ${ROOT_COMMENT_ID}`,
  });
}

function reviewSummaryEvent(body: string): GitHubReviewSummaryUpsertEvent {
  return {
    kind: GitHubExternalEventKind.ReviewSummaryUpsert,
    reviewId: REVIEW_ID,
    htmlUrl: null,
    comment: {
      githubCommentId: REVIEW_ID,
      htmlUrl: null,
      bodyMarkdown: body,
      author: null,
      createdAt: at(0),
      providerUpdatedAt: at(0),
    },
  };
}

describeIfDb(
  "reconcile vs a review-thread resolution written after the list",
  () => {
    it("keeps a thread a resolve webhook resolved after the lists were read", async () => {
      await joinAmbientTransaction(async () => {
        const scope = await seed();
        const resolver = await createTestUser(scope.organizationId);
        await applyExternal(
          applyInput(scope, [reviewThreadEvent(ROOT_COMMENT_ID)])
        );
        const listedAt = new Date();
        await resolveByWebhook(scope, resolver.id);

        await reconcile(scope, {
          reviewComments: list([listedRootComment()]),
          listedAt,
        });

        const thread = await storedThread(scope);
        expect(thread.status).toBe(ThreadStatus.RESOLVED);
        expect(thread.resolvedById).toBe(resolver.id);
      });
    });

    it("reopens a thread resolved before the lists were read, clearing its resolution", async () => {
      await joinAmbientTransaction(async () => {
        const scope = await seed();
        const resolver = await createTestUser(scope.organizationId);
        await applyExternal(
          applyInput(scope, [reviewThreadEvent(ROOT_COMMENT_ID)])
        );
        await resolveByWebhook(scope, resolver.id);
        const listedAt = new Date(Date.now() + 1000);

        await reconcile(scope, {
          reviewComments: list([listedRootComment()]),
          listedAt,
        });

        expect(await storedThread(scope)).toMatchObject({
          status: ThreadStatus.OPEN,
          resolvedAt: null,
          resolvedById: null,
          metadata: {},
        });
      });
    });
  }
);

describeIfDb("reconcile vs a review summary edited after the list", () => {
  it("keeps the body an edited webhook wrote after the lists were read", async () => {
    await joinAmbientTransaction(async () => {
      const scope = await seed();
      const listedAt = new Date();
      await applyExternal(applyInput(scope, [reviewSummaryEvent("edited")]));

      await reconcile(scope, {
        reviews: list([providerReview(REVIEW_ID, "listed", at(0))]),
        listedAt,
      });

      expect((await storedComment(scope, REVIEW_ID))?.comment.plainText).toBe(
        "edited"
      );
    });
  });

  it("deletes the stored summary when an edit clears the review body", async () => {
    await joinAmbientTransaction(async () => {
      const scope = await seed();
      await applyExternal(applyInput(scope, [reviewSummaryEvent("summary")]));

      await applyExternal(
        applyInput(scope, [
          {
            kind: GitHubExternalEventKind.CommentDelete,
            threadKind: GitHubCommentThreadKind.REVIEW_SUMMARY,
            githubCommentId: REVIEW_ID,
            providerUpdatedAt: at(0),
          },
        ])
      );

      const stored = await storedComment(scope, REVIEW_ID);
      expect(stored?.comment.deletedAt).not.toBeNull();
      expect(stored?.threadProjection.deletedAt).not.toBeNull();
    });
  });
});

describeIfDb(
  "ordering against the previous API bundle's projection key",
  () => {
    it("keeps a newer body the previous bundle wrote without a sync row", async () => {
      await joinAmbientTransaction(async () => {
        const scope = await seed();
        await applyExternal(
          applyInput(scope, [
            issueCommentEvent(1, {
              bodyMarkdown: "v1",
              providerUpdatedAt: at(1),
            }),
          ])
        );
        const stored = await storedComment(scope, 1);
        await withDb(async (db) => {
          await db.gitHubCommentProjection.update({
            where: { commentId: stored?.commentId ?? "" },
            data: { githubUpdatedAt: at(3) },
            select: { commentId: true },
          });
          await db.comment.update({
            where: { id: stored?.commentId ?? "" },
            data: { plainText: "v3" },
            select: { id: true },
          });
        });

        await applyExternal(
          applyInput(scope, [
            issueCommentEvent(1, {
              bodyMarkdown: "v2",
              providerUpdatedAt: at(2),
            }),
          ])
        );

        expect((await storedComment(scope, 1))?.comment.plainText).toBe("v3");
      });
    });
  }
);

describeIfDb("reconcile of a list whose pages shifted mid-read", () => {
  it("applies its rows, skips its cleanup and reports the shift", async () => {
    await joinAmbientTransaction(async () => {
      const scope = await seed();
      await applyExternal(applyInput(scope, [issueCommentEvent(9999)]));

      const result = await reconcile(scope, {
        issueComments: list([providerIssueComment(1)], {
          complete: false,
          shifted: true,
        }),
      });

      expect(result.status).toBe(GitHubCommentReconcileStatus.Partial);
      expect(result.reasons).toEqual([
        GitHubCommentReconcileReason.ListShifted,
      ]);
      expect((await storedComment(scope, 1))?.comment.deletedAt).toBeNull();
      expect((await storedComment(scope, 9999))?.comment.deletedAt).toBeNull();
    });
  });
});
