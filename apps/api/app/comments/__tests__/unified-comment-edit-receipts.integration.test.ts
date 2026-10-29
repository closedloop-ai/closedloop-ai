import {
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import { CommentReactionEmoji } from "@repo/api/src/types/comment-thread-dto";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiKeyRouteRequest,
  countReceipts,
  createReceiptRouteHarness,
  failReceiptInserts,
  forcedReceiptFailures,
  readReceipts,
  receiptRouteParams,
  turnAttributionFlagOff,
} from "@/__tests__/support/lib/operation-receipt-route.test-helpers";

vi.mock("@/lib/attribution-evidence-policy-feature", async (importOriginal) =>
  (
    await import("@/__tests__/support/lib/operation-receipt-route.test-mocks")
  ).receiptRouteFlagMock(await importOriginal())
);
vi.mock("@/lib/auth/with-any-auth", async () =>
  (
    await import("@/__tests__/support/lib/operation-receipt-route.test-mocks")
  ).receiptRouteAuthMock()
);
vi.mock("@vercel/functions", async () =>
  (
    await import("@/__tests__/support/lib/operation-receipt-route.test-mocks")
  ).receiptRouteWaitUntilMock()
);
vi.mock(
  "@/lib/operation-receipts/operation-receipt-writer",
  async (importOriginal) =>
    (
      await import("@/__tests__/support/lib/operation-receipt-route.test-mocks")
    ).failingReceiptWriterMock(await importOriginal())
);
vi.mock("@/lib/mention-notifications", () => ({
  dispatchMentionNotifications: vi.fn(),
}));
vi.mock("@/app/search/search-index-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/app/search/search-index-service")>();
  return {
    ...actual,
    searchIndexService: {
      ...actual.searchIndexService,
      indexAfterCommit: vi.fn(),
      removeAfterCommit: vi.fn(),
    },
  };
});

import {
  DOCUMENT_THREAD_ANCHOR,
  seedReceiptThread,
  switchDocumentComments,
} from "@/__tests__/support/comments/comment-receipt-route.test-fixtures";
import {
  PUT as react,
  DELETE as unreact,
} from "@/app/comments/[commentId]/reactions/[emoji]/route";
import {
  DELETE as deleteComment,
  PATCH as editComment,
} from "@/app/comments/[commentId]/route";

const harness = createReceiptRouteHarness();
const EMOJI = CommentReactionEmoji.ThumbsUp;
const REACTION_ROUTE = "/comments/[commentId]/reactions/[emoji]";

/**
 * ISS-12552: an API-key comment edit, delete or reaction
 * records its receipt in the comment command's own transaction. These routes
 * have no catch of their own, so a failed receipt rejects the handler, which
 * `withAnyAuth` answers with 500 in production.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 unified comment edit, delete and reaction receipts",
  () => {
    afterEach(() => harness.cleanup());

    async function seedDocumentComment() {
      const world = await harness.seedWorld();
      await switchDocumentComments(world.organizationId);
      const documentId = await harness.seedDocument(world, "Commented");
      const { rootCommentId } = await seedReceiptThread(
        world,
        documentId,
        DOCUMENT_THREAD_ANCHOR
      );
      return { world, documentId, commentId: rootCommentId };
    }

    it("PATCH keeps the comment unedited when its receipt cannot be stored", async () => {
      const { world, commentId } = await seedDocumentComment();
      failReceiptInserts();

      await expect(
        editComment(
          apiKeyRouteRequest("PATCH", `/comments/${commentId}`, {
            body: "edited",
            expectedRevision: 0,
          }),
          receiptRouteParams({ commentId })
        )
      ).rejects.toThrow();

      expect(forcedReceiptFailures()).toBe(1);
      expect(await readComment(commentId)).toEqual({
        plainText: "seeded root",
        deletedAt: null,
      });
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("DELETE keeps the comment when its receipt cannot be stored", async () => {
      const { world, commentId } = await seedDocumentComment();
      failReceiptInserts();

      await expect(
        deleteComment(
          apiKeyRouteRequest("DELETE", `/comments/${commentId}`),
          receiptRouteParams({ commentId })
        )
      ).rejects.toThrow();

      expect(forcedReceiptFailures()).toBe(1);
      expect(await readComment(commentId)).toEqual({
        plainText: "seeded root",
        deletedAt: null,
      });
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("PUT reaction adds nothing when its receipt cannot be stored", async () => {
      const { world, commentId } = await seedDocumentComment();
      failReceiptInserts();

      await expect(
        react(
          reactionRequest("PUT", commentId),
          receiptRouteParams({ commentId, emoji: EMOJI })
        )
      ).rejects.toThrow();

      expect(forcedReceiptFailures()).toBe(1);
      expect(await countReactions(commentId)).toBe(0);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("DELETE reaction keeps it when its receipt cannot be stored", async () => {
      const { world, commentId } = await seedDocumentComment();
      await seedReaction(commentId, world.userId);
      failReceiptInserts();

      await expect(
        unreact(
          reactionRequest("DELETE", commentId),
          receiptRouteParams({ commentId, emoji: EMOJI })
        )
      ).rejects.toThrow();

      expect(forcedReceiptFailures()).toBe(1);
      expect(await countReactions(commentId)).toBe(1);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("records a reaction as a comment on the document, and a repeat as a no-op", async () => {
      const { world, documentId, commentId } = await seedDocumentComment();
      const put = () =>
        react(
          reactionRequest("PUT", commentId),
          receiptRouteParams({ commentId, emoji: EMOJI })
        );

      const statuses = [(await put()).status, (await put()).status];

      expect(statuses).toEqual([200, 200]);
      expect(await readReceipts(world.organizationId)).toEqual(
        [OperationReceiptOutcome.Committed, OperationReceiptOutcome.NoOp].map(
          (outcome) => ({
            operationKind: OperationKind.Comment,
            outcome,
            source: OperationSource.Api,
            targetArtifactId: documentId,
            createdArtifactId: null,
            changedFields: [],
            route: REACTION_ROUTE,
          })
        )
      );
    });

    it("writes no receipt with attribution-evidence-policy off", async () => {
      const { world, commentId } = await seedDocumentComment();
      turnAttributionFlagOff();

      const response = await deleteComment(
        apiKeyRouteRequest("DELETE", `/comments/${commentId}`),
        receiptRouteParams({ commentId })
      );

      expect(response.status).toBe(200);
      expect((await readComment(commentId)).deletedAt).not.toBeNull();
      expect(await countReceipts(world.organizationId)).toBe(0);
    });
  }
);

function reactionRequest(method: string, commentId: string) {
  return apiKeyRouteRequest(
    method,
    `/comments/${commentId}/reactions/${encodeURIComponent(EMOJI)}`
  );
}

function readComment(commentId: string) {
  return withDb((db) =>
    db.comment.findUniqueOrThrow({
      where: { id: commentId },
      select: { plainText: true, deletedAt: true },
    })
  );
}

function countReactions(commentId: string): Promise<number> {
  return withDb((db) => db.commentReaction.count({ where: { commentId } }));
}

async function seedReaction(commentId: string, userId: string): Promise<void> {
  await withDb((db) =>
    db.commentReaction.create({
      data: { commentId, userId, emoji: EMOJI },
      select: { id: true },
    })
  );
}
