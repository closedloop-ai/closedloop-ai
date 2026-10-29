/**
 * ISS-11212 against a real Postgres: what one review-thread write leaves on
 * the thread and its other comments — a reply's parent link, a thread whose
 * projection was deleted, the external id, the thread fields a list older than
 * the thread may not overwrite, the comments a mixed event writes, and the
 * stored author.
 */
import { GitHubCommentThreadKind, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  applyInput,
  at,
  externalComment,
  GITHUB_TEST_AUTHOR,
  type GitHubCommentScope,
  issueCommentEvent,
  reviewThreadEvent,
  seedGitHubCommentScope,
  storedComment,
} from "@/__tests__/support/comments/github-apply-external.test-fixtures";
import {
  autoRollbackTransaction,
  createTestOrganization,
} from "@/__tests__/utils/db-helpers";
import { applyExternal } from "./apply-external";
import {
  ApplyExternalOutcome,
  type GitHubExternalEvent,
  GitHubExternalEventKind,
  type GitHubReviewThreadUpsertEvent,
} from "./apply-external-events";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

async function seed(): Promise<GitHubCommentScope> {
  return await seedGitHubCommentScope(await createTestOrganization());
}

async function outcome(scope: GitHubCommentScope, event: GitHubExternalEvent) {
  const result = await applyExternal(applyInput(scope, [event]));
  return result.outcomes[0];
}

/** A review-comment webhook's reply: no GraphQL id, and the reply's fields. */
function replyEvent(
  rootCommentId: number,
  replyId: number,
  over: Parameters<typeof externalComment>[1] = {}
): GitHubReviewThreadUpsertEvent {
  return {
    ...reviewThreadEvent(rootCommentId, {
      comments: [
        externalComment(replyId, {
          githubInReplyToCommentId: rootCommentId,
          ...over,
        }),
      ],
    }),
    reviewThreadId: null,
    threadFieldsFromReply: true,
  };
}

/** A review-comment webhook for a root: no GraphQL id. */
function rootWebhookEvent(
  rootCommentId: number,
  input: Parameters<typeof reviewThreadEvent>[1] = {}
): GitHubReviewThreadUpsertEvent {
  return { ...reviewThreadEvent(rootCommentId, input), reviewThreadId: null };
}

async function commentRow(scope: GitHubCommentScope, githubCommentId: number) {
  const stored = await storedComment(scope, githubCommentId);
  if (!stored) {
    throw new Error(`comment ${githubCommentId} is not stored`);
  }
  return await withDb((db) =>
    db.comment.findUniqueOrThrow({
      where: { id: stored.commentId },
      select: {
        id: true,
        authorId: true,
        parentCommentId: true,
        plainText: true,
        revision: true,
        thread: {
          select: {
            externalId: true,
            githubProjection: { select: { line: true, deletedAt: true } },
          },
        },
        githubProjection: { select: { externalAuthorId: true } },
      },
    })
  );
}

describeIfDb("applyExternal — reply parent links", () => {
  it("links a reply stored before its root once the root is written", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seed();
      await outcome(scope, replyEvent(941, 942));
      expect((await commentRow(scope, 942)).parentCommentId).toBeNull();

      await outcome(scope, rootWebhookEvent(941));

      const root = await commentRow(scope, 941);
      expect((await commentRow(scope, 942)).parentCommentId).toBe(root.id);
    });
  });

  it("fills a missing parent link on a write that changes nothing else", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seed();
      const thread = reviewThreadEvent(951, {
        comments: [
          externalComment(951),
          externalComment(952, { githubInReplyToCommentId: 951 }),
        ],
      });
      await outcome(scope, thread);
      const reply = await commentRow(scope, 952);
      await withDb((db) =>
        db.comment.update({
          where: { id: reply.id },
          data: { parentCommentId: null },
          select: { id: true },
        })
      );

      expect(await outcome(scope, thread)).toBe(ApplyExternalOutcome.Applied);

      const root = await commentRow(scope, 951);
      expect((await commentRow(scope, 952)).parentCommentId).toBe(root.id);
    });
  });
});

describeIfDb("applyExternal — a thread whose projection was deleted", () => {
  it("stores a reply that arrives after its root was deleted, bringing the thread back", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seed();
      await outcome(scope, rootWebhookEvent(1701));
      await outcome(scope, {
        kind: GitHubExternalEventKind.CommentDelete,
        threadKind: GitHubCommentThreadKind.REVIEW_THREAD,
        githubCommentId: 1701,
        providerUpdatedAt: at(1),
      });
      expect(
        (await storedComment(scope, 1701))?.threadProjection.deletedAt
      ).not.toBeNull();

      expect(await outcome(scope, replyEvent(1701, 1702))).toBe(
        ApplyExternalOutcome.Applied
      );

      const reply = await storedComment(scope, 1702);
      expect(reply?.comment.deletedAt).toBeNull();
      expect(reply?.threadProjection.deletedAt).toBeNull();
      expect(
        (await storedComment(scope, 1701))?.comment.deletedAt
      ).not.toBeNull();
    });
  });
});

describeIfDb("applyExternal — thread identity and fields", () => {
  it("keeps the review-thread external id once stored when a webhook writes the thread again", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seed();
      const prefix = `github-pr-thread:${scope.pullRequestDetailId}`;
      await outcome(scope, rootWebhookEvent(911));
      expect((await commentRow(scope, 911)).thread.externalId).toBe(
        `${prefix}:REVIEW_THREAD:root:911`
      );

      await outcome(scope, reviewThreadEvent(911));
      await outcome(
        scope,
        rootWebhookEvent(911, {
          comments: [
            externalComment(911, {
              bodyMarkdown: "edited",
              providerUpdatedAt: at(1),
            }),
          ],
        })
      );

      expect((await commentRow(scope, 911)).thread.externalId).toBe(
        `${prefix}:review-thread:PRRT_911`
      );
    });
  });

  it("keeps a position written after the list was read", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seed();
      await outcome(scope, rootWebhookEvent(901, { line: 10 }));
      await outcome(scope, replyEvent(901, 902));
      const listedAt = new Date();
      await outcome(
        scope,
        rootWebhookEvent(901, {
          line: 13,
          comments: [
            externalComment(901, {
              bodyMarkdown: "moved",
              providerUpdatedAt: at(2),
            }),
          ],
        })
      );

      await outcome(scope, {
        ...reviewThreadEvent(901, {
          line: 10,
          comments: [
            externalComment(901),
            externalComment(902, { githubInReplyToCommentId: 901 }),
          ],
        }),
        listedAt,
      });

      expect((await commentRow(scope, 901)).thread.githubProjection?.line).toBe(
        13
      );
      expect(
        (await storedComment(scope, 901))?.threadProjection.thread.anchor
      ).toEqual(expect.objectContaining({ endLine: 13 }));
    });
  });

  it("moves the thread to a list root newer than the stored one, whenever the thread was written", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seed();
      const listedAt = new Date();
      await outcome(scope, rootWebhookEvent(905, { line: 12 }));

      await outcome(scope, {
        ...reviewThreadEvent(905, {
          line: 13,
          comments: [
            externalComment(905, {
              bodyMarkdown: "edited",
              providerUpdatedAt: at(1),
            }),
          ],
        }),
        listedAt,
      });

      expect((await commentRow(scope, 905)).thread.githubProjection?.line).toBe(
        13
      );
    });
  });

  it("writes only the accepted comments of an event that also carries an older one", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seed();
      await outcome(
        scope,
        reviewThreadEvent(921, {
          comments: [
            externalComment(921),
            externalComment(922, { githubInReplyToCommentId: 921 }),
          ],
        })
      );
      await outcome(
        scope,
        replyEvent(921, 922, {
          bodyMarkdown: "newer",
          providerUpdatedAt: at(5),
        })
      );
      const replyBefore = await commentRow(scope, 922);

      expect(
        await outcome(scope, {
          ...reviewThreadEvent(921, {
            comments: [
              externalComment(921, {
                bodyMarkdown: "root v2",
                providerUpdatedAt: at(1),
              }),
              externalComment(922, { githubInReplyToCommentId: 921 }),
            ],
          }),
          listedAt: new Date(),
        })
      ).toBe(ApplyExternalOutcome.Applied);

      expect((await commentRow(scope, 921)).plainText).toBe("root v2");
      const replyAfter = await commentRow(scope, 922);
      expect(replyAfter.plainText).toBe("newer");
      expect(replyAfter.revision).toBe(replyBefore.revision);
    });
  });
});

describeIfDb("applyExternal — authors and scope", () => {
  it("stores the comment under the GitHub author's external author and its user", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seed();
      await outcome(scope, issueCommentEvent(931));

      const author = await withDb((db) =>
        db.externalCommentAuthor.findFirstOrThrow({
          where: {
            organizationId: scope.organizationId,
            providerUserId: String(GITHUB_TEST_AUTHOR.id),
          },
          select: { id: true, userId: true, providerLogin: true },
        })
      );
      const comment = await commentRow(scope, 931);
      expect(author.providerLogin).toBe(GITHUB_TEST_AUTHOR.login);
      expect(comment.authorId).toBe(author.userId);
      expect(comment.githubProjection?.externalAuthorId).toBe(author.id);
    });
  });

  it("refuses a review thread whose comment another organization stores, and leaves no thread", async () => {
    await autoRollbackTransaction(async () => {
      const orgA = await seed();
      const orgB = await seed();
      await outcome(orgB, reviewThreadEvent(961));

      expect(await outcome(orgA, reviewThreadEvent(961))).toBe(
        ApplyExternalOutcome.NoWrite
      );

      const threads = await withDb((db) =>
        db.commentThread.count({
          where: {
            organizationId: orgA.organizationId,
            artifactId: orgA.branchArtifactId,
          },
        })
      );
      expect(threads).toBe(0);
    });
  });
});
