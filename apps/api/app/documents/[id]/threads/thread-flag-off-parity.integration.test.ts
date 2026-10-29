import { randomUUID } from "node:crypto";
import { ThreadSource, ThreadStatus } from "@repo/api/src/types/comment";
import { CommentBodyFormat } from "@repo/api/src/types/comment-thread-dto";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiKeyRouteRequest,
  countReceipts,
  createReceiptRouteHarness,
  receiptRouteParams,
  turnAttributionFlagOff,
} from "@/__tests__/support/lib/operation-receipt-route.test-helpers";
import { countTransactions } from "@/__tests__/support/lib/transaction-count.test-helpers";

const liveblocks = vi.hoisted(() => ({
  markArtifactThreadResolved: vi.fn(),
  markArtifactThreadUnresolved: vi.fn(),
  deleteArtifactComment: vi.fn(),
  replyToArtifactThread: vi.fn(),
}));

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
  "@repo/collaboration/server/room-management",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    markArtifactThreadResolved: liveblocks.markArtifactThreadResolved,
    markArtifactThreadUnresolved: liveblocks.markArtifactThreadUnresolved,
    deleteArtifactComment: liveblocks.deleteArtifactComment,
    replyToArtifactThread: liveblocks.replyToArtifactThread,
  })
);

import { commentsService } from "@/app/comments/service";
import { POST as replyToThread } from "@/app/documents/[id]/threads/[threadId]/replies/route";
import { POST as resolveThread } from "@/app/documents/[id]/threads/[threadId]/resolve/route";

const harness = createReceiptRouteHarness();
const organizationIds: string[] = [];

/**
 * ISS-12552: flag-off behavior equals main for document threads. With
 * `attribution-evidence-policy` off, a thread reply and resolve run exactly as
 * on main.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 document thread writes match main with attribution evidence off",
  () => {
    beforeEach(() => {
      liveblocks.markArtifactThreadResolved.mockReset().mockResolvedValue({});
      liveblocks.markArtifactThreadUnresolved.mockReset().mockResolvedValue({});
      liveblocks.deleteArtifactComment.mockReset().mockResolvedValue(undefined);
      liveblocks.replyToArtifactThread.mockReset();
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      const orgIds = organizationIds.splice(0);
      await withDb((db) =>
        db.commentThread.deleteMany({
          where: { organizationId: { in: orgIds } },
        })
      );
      await harness.cleanup();
    });

    it("a reply opens only the projection's own transaction", async () => {
      const { world, documentId, externalId, roomId } =
        await seedDocumentThread();
      liveblocks.replyToArtifactThread.mockResolvedValue(
        liveblocksComment(roomId, externalId, world.userId)
      );
      turnAttributionFlagOff();
      const transactions = countTransactions();

      const response = await replyToThread(
        apiKeyRouteRequest(
          "POST",
          `/documents/${documentId}/threads/${externalId}/replies`,
          { body: "Agreed." }
        ),
        receiptRouteParams({ id: documentId, threadId: externalId })
      );

      expect(response.status).toBe(200);
      // `upsertCommentFromLiveblocks` opens it; main wrapped nothing around it.
      expect(transactions.calls).toBe(1);
      expect(await commentCount(externalId)).toBe(2);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("a resolve whose projection fails leaves Liveblocks resolved", async () => {
      const { documentId, externalId } = await seedDocumentThread();
      turnAttributionFlagOff();
      vi.spyOn(commentsService, "resolveThread").mockRejectedValue(
        new Error("forced projection failure")
      );

      const response = await resolveThread(
        apiKeyRouteRequest(
          "POST",
          `/documents/${documentId}/threads/${externalId}/resolve`
        ),
        receiptRouteParams({ id: documentId, threadId: externalId })
      );

      expect(response.status).toBe(500);
      expect(liveblocks.markArtifactThreadResolved).toHaveBeenCalledTimes(1);
      expect(liveblocks.markArtifactThreadUnresolved).not.toHaveBeenCalled();
    });
  }
);

async function seedDocumentThread() {
  const world = await harness.seedWorld();
  organizationIds.push(world.organizationId);
  const documentId = await harness.seedDocument(world, "Discussed");
  const externalId = `th_${randomUUID()}`;
  const roomId = `room-${randomUUID()}`;
  await withDb((db) =>
    db.commentThread.create({
      data: {
        organizationId: world.organizationId,
        artifactId: documentId,
        source: ThreadSource.Liveblocks,
        externalId,
        roomId,
        status: ThreadStatus.Open,
        createdById: world.userId,
        comments: {
          create: {
            authorId: world.userId,
            body: { version: 1, content: [] },
            bodyFormat: CommentBodyFormat.LiveblocksV1,
            plainText: "synced",
            externalId: `cm_${randomUUID()}`,
          },
        },
      },
      select: { id: true },
    })
  );
  return { world, documentId, externalId, roomId };
}

function liveblocksComment(roomId: string, threadId: string, userId: string) {
  return {
    type: "comment",
    id: `cm_${randomUUID()}`,
    threadId,
    roomId,
    userId,
    createdAt: new Date("2026-10-22T12:00:00.000Z"),
    body: {
      version: 1,
      content: [{ type: "paragraph", children: [{ text: "Agreed." }] }],
    },
    reactions: [],
    attachments: [],
    metadata: {},
  };
}

function commentCount(externalId: string): Promise<number> {
  return withDb((db) =>
    db.comment.count({ where: { thread: { externalId } } })
  );
}
