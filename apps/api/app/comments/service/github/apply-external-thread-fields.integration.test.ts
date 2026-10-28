/**
 * ISS-11212: a review-comment webhook carries none of its thread's review-thread
 * id or resolution and, for a reply, not the root's review id, URL or position.
 * Those seed a new thread and never rewrite the values the reconcile stores,
 * against a real Postgres.
 */
import { GitHubLegacyCommentState, ThreadStatus, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  applyInput,
  at,
  externalComment,
  GITHUB_TEST_REPOSITORY,
  type GitHubCommentScope,
  reviewThreadEvent,
  seedGitHubCommentScope,
} from "@/__tests__/support/comments/github-apply-external.test-fixtures";
import {
  autoRollbackTransaction,
  createTestOrganization,
} from "@/__tests__/utils/db-helpers";
import { applyExternal } from "./apply-external";
import {
  ApplyExternalOutcome,
  type GitHubExternalComment,
} from "./apply-external-events";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const ROOT_URL = `https://github.com/${GITHUB_TEST_REPOSITORY}/pull/42#discussion_r1`;

async function seed(): Promise<GitHubCommentScope> {
  return await seedGitHubCommentScope(await createTestOrganization());
}

async function outcome(
  scope: GitHubCommentScope,
  event: Parameters<typeof applyInput>[1][number]
) {
  const result = await applyExternal(applyInput(scope, [event]));
  return result.outcomes[0];
}

async function threadFields(scope: GitHubCommentScope) {
  return await withDb((db) =>
    db.gitHubCommentThreadProjection.findFirstOrThrow({
      where: { branchArtifactId: scope.branchArtifactId, rootCommentId: "1" },
      select: {
        reviewThreadId: true,
        reviewId: true,
        htmlUrl: true,
        line: true,
        legacyState: true,
        thread: { select: { revision: true, anchor: true, status: true } },
      },
    })
  );
}

describeIfDb("applyExternal — a reply's thread fields", () => {
  async function storeRootAndReply(scope: GitHubCommentScope) {
    await outcome(scope, {
      ...reviewThreadEvent(1, {
        comments: [
          externalComment(1),
          externalComment(2, { githubInReplyToCommentId: 1 }),
        ],
      }),
      reviewId: "root-review",
      htmlUrl: ROOT_URL,
    });
  }

  /** A reply as the review-comment webhook delivers it: no root in sight. */
  function replyDelivery(
    githubCommentId: number,
    over: Partial<GitHubExternalComment> = {}
  ) {
    return {
      ...reviewThreadEvent(1, {
        line: 20,
        comments: [
          externalComment(githubCommentId, {
            githubInReplyToCommentId: 1,
            ...over,
          }),
        ],
      }),
      reviewThreadId: null,
      reviewId: "reply-review",
      htmlUrl: `https://github.com/${GITHUB_TEST_REPOSITORY}/pull/42#discussion_r${githubCommentId}`,
      threadFieldsFromReply: true,
    };
  }

  it("leaves the thread and its revision alone when a reply is redelivered unchanged", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seed();
      await storeRootAndReply(scope);
      const before = await threadFields(scope);

      const result = await applyExternal(applyInput(scope, [replyDelivery(2)]));

      expect(result).toEqual({
        outcomes: [ApplyExternalOutcome.Unchanged],
        changedThreadIds: [],
      });
      expect(await threadFields(scope)).toEqual(before);
    });
  });

  it("keeps the root's review id, URL, position and anchor when a reply is edited or added", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seed();
      await storeRootAndReply(scope);
      const before = await threadFields(scope);

      expect(
        await outcome(
          scope,
          replyDelivery(2, { bodyMarkdown: "edited", providerUpdatedAt: at(1) })
        )
      ).toBe(ApplyExternalOutcome.Applied);
      expect(await outcome(scope, replyDelivery(3))).toBe(
        ApplyExternalOutcome.Applied
      );

      const after = await threadFields(scope);
      expect(after).toEqual({
        ...before,
        thread: { ...before.thread, revision: after.thread.revision },
      });
      expect(after).toEqual(
        expect.objectContaining({
          reviewId: "root-review",
          htmlUrl: ROOT_URL,
          line: 10,
        })
      );
    });
  });
});

describeIfDb("applyExternal — a root comment webhook's thread fields", () => {
  /** The thread as the reconcile stores it from the review-thread read. */
  async function storeReconciledResolvedThread(scope: GitHubCommentScope) {
    await outcome(scope, {
      ...reviewThreadEvent(1),
      reviewId: "root-review",
      htmlUrl: ROOT_URL,
      legacyState: GitHubLegacyCommentState.ADDRESSED,
      resolutionStatus: ThreadStatus.RESOLVED,
    });
  }

  /** A root comment as the review-comment webhook delivers it. */
  function rootDelivery(over: Partial<GitHubExternalComment> = {}) {
    return {
      ...reviewThreadEvent(1, { comments: [externalComment(1, over)] }),
      reviewThreadId: null,
      reviewId: "root-review",
      htmlUrl: ROOT_URL,
    };
  }

  it("leaves the thread and its revision alone when the root is redelivered unchanged", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seed();
      await storeReconciledResolvedThread(scope);
      const before = await threadFields(scope);

      const result = await applyExternal(applyInput(scope, [rootDelivery()]));

      expect(result).toEqual({
        outcomes: [ApplyExternalOutcome.Unchanged],
        changedThreadIds: [],
      });
      expect(await threadFields(scope)).toEqual(before);
    });
  });

  it("keeps the stored review-thread id and resolution when the root is edited", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seed();
      await storeReconciledResolvedThread(scope);
      const before = await threadFields(scope);

      expect(
        await outcome(
          scope,
          rootDelivery({ bodyMarkdown: "edited", providerUpdatedAt: at(1) })
        )
      ).toBe(ApplyExternalOutcome.Applied);

      const after = await threadFields(scope);
      expect(after).toEqual({
        ...before,
        thread: { ...before.thread, revision: after.thread.revision },
      });
      expect(after).toEqual(
        expect.objectContaining({
          reviewThreadId: "PRRT_1",
          legacyState: GitHubLegacyCommentState.ADDRESSED,
          thread: expect.objectContaining({ status: ThreadStatus.RESOLVED }),
        })
      );
    });
  });

  it("seeds a thread it creates from the root's fields", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seed();

      expect(await outcome(scope, rootDelivery())).toBe(
        ApplyExternalOutcome.Applied
      );

      expect(await threadFields(scope)).toEqual(
        expect.objectContaining({
          reviewThreadId: null,
          reviewId: "root-review",
          htmlUrl: ROOT_URL,
          line: 10,
          legacyState: GitHubLegacyCommentState.PENDING,
          thread: expect.objectContaining({ status: ThreadStatus.OPEN }),
        })
      );
    });
  });
});
