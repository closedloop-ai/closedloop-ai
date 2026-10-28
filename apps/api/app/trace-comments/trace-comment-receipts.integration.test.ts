import { randomUUID } from "node:crypto";
import {
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import { CommentTargetType } from "@repo/api/src/types/comment";
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
  seedReceiptBranch,
  seedReceiptSession,
} from "@/__tests__/support/comments/comment-receipt-route.test-fixtures";
import { legacyTraceAnchor } from "@/__tests__/support/trace-comments/legacy-route.test-fixtures";
import { POST as replyToSessionComment } from "@/app/agent-sessions/[id]/trace-comments/[commentId]/replies/route";
import {
  DELETE as deleteSessionComment,
  PATCH as editSessionComment,
} from "@/app/agent-sessions/[id]/trace-comments/[commentId]/route";
import { POST as createSessionComment } from "@/app/agent-sessions/[id]/trace-comments/route";
import { POST as createBranchComment } from "@/app/branches/[id]/trace-comments/route";
import { traceCommentsService } from "./service";

const harness = createReceiptRouteHarness();
const SESSION_COMMENTS_ROUTE = "/agent-sessions/[id]/trace-comments";
const SESSION_REPLIES_ROUTE =
  "/agent-sessions/[id]/trace-comments/[commentId]/replies";

/**
 * ISS-12552: an API-key trace comment, reply, edit or delete on
 * a Session or Branch records its receipt in the comment command's own
 * transaction, so a receipt that cannot be stored rolls the comment back.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 trace comment receipts",
  () => {
    afterEach(() => harness.cleanup());

    it("POST session comment rolls back when its receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      const sessionId = await seedReceiptSession(world);
      failReceiptInserts();

      const response = await createSessionComment(
        apiKeyRouteRequest(
          "POST",
          `/agent-sessions/${sessionId}/trace-comments`,
          draft()
        ),
        receiptRouteParams({ id: sessionId })
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await countThreads(sessionId)).toBe(0);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("POST branch comment rolls back when its receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      const branchId = await seedReceiptBranch(world);
      failReceiptInserts();

      const response = await createBranchComment(
        apiKeyRouteRequest(
          "POST",
          `/branches/${branchId}/trace-comments`,
          draft()
        ),
        receiptRouteParams({ id: branchId })
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await countThreads(branchId)).toBe(0);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("POST reply rolls back when its receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      const sessionId = await seedReceiptSession(world);
      const commentId = await seedTraceComment(world, sessionId);
      failReceiptInserts();

      const response = await replyToSessionComment(
        apiKeyRouteRequest(
          "POST",
          `/agent-sessions/${sessionId}/trace-comments/${commentId}/replies`,
          { body: "reply" }
        ),
        receiptRouteParams({ id: sessionId, commentId })
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await countLiveComments(sessionId)).toBe(1);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("PATCH keeps the comment unedited when its receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      const sessionId = await seedReceiptSession(world);
      const commentId = await seedTraceComment(world, sessionId);
      failReceiptInserts();

      const response = await editSessionComment(
        apiKeyRouteRequest(
          "PATCH",
          `/agent-sessions/${sessionId}/trace-comments/${commentId}`,
          { body: "edited" }
        ),
        receiptRouteParams({ id: sessionId, commentId })
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await commentText(commentId)).toBe("seeded root");
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("DELETE keeps the comment when its receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      const sessionId = await seedReceiptSession(world);
      const commentId = await seedTraceComment(world, sessionId);
      failReceiptInserts();

      const response = await deleteSessionComment(
        apiKeyRouteRequest(
          "DELETE",
          `/agent-sessions/${sessionId}/trace-comments/${commentId}`
        ),
        receiptRouteParams({ id: sessionId, commentId })
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await countLiveComments(sessionId)).toBe(1);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("records a comment and a reply on the session, each naming its comment", async () => {
      const world = await harness.seedWorld();
      const sessionId = await seedReceiptSession(world);

      const created = await createSessionComment(
        apiKeyRouteRequest(
          "POST",
          `/agent-sessions/${sessionId}/trace-comments`,
          draft()
        ),
        receiptRouteParams({ id: sessionId })
      );
      const root = (
        (await created.json()) as {
          data: { id: string; operationReceipt?: { outcome: string } };
        }
      ).data;
      const replied = await replyToSessionComment(
        apiKeyRouteRequest(
          "POST",
          `/agent-sessions/${sessionId}/trace-comments/${root.id}/replies`,
          { body: "reply" }
        ),
        receiptRouteParams({ id: sessionId, commentId: root.id })
      );

      expect([created.status, replied.status]).toEqual([200, 200]);
      expect(root.operationReceipt?.outcome).toBe(
        OperationReceiptOutcome.Committed
      );
      expect(await readReceipts(world.organizationId)).toEqual(
        [SESSION_COMMENTS_ROUTE, SESSION_REPLIES_ROUTE].map((route) => ({
          operationKind: OperationKind.Comment,
          outcome: OperationReceiptOutcome.Committed,
          source: OperationSource.Api,
          targetArtifactId: sessionId,
          createdArtifactId: null,
          changedFields: [],
          route,
        }))
      );
      expect(await readReceiptCommentIds(world.organizationId)).toEqual([
        root.id,
        await replyId(sessionId, root.id),
      ]);
    });

    it("writes no receipt with attribution-evidence-policy off", async () => {
      const world = await harness.seedWorld();
      const sessionId = await seedReceiptSession(world);
      turnAttributionFlagOff();

      const response = await createSessionComment(
        apiKeyRouteRequest(
          "POST",
          `/agent-sessions/${sessionId}/trace-comments`,
          draft()
        ),
        receiptRouteParams({ id: sessionId })
      );

      expect(response.status).toBe(200);
      expect(await countThreads(sessionId)).toBe(1);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });
  }
);

function draft() {
  return {
    anchor: legacyTraceAnchor(1),
    body: "root",
    clientId: randomUUID(),
  };
}

/** A root comment the world's caller left on the session, with no receipt. */
async function seedTraceComment(
  world: { organizationId: string; userId: string },
  sessionId: string
): Promise<string> {
  const created = await traceCommentsService.create({
    organizationId: world.organizationId,
    userId: world.userId,
    target: { type: CommentTargetType.Session, id: sessionId },
    draft: { anchor: legacyTraceAnchor(1), body: "seeded root" },
  });
  if (!created || "ok" in created) {
    throw new Error("Failed to seed the ISS-12552 trace comment");
  }
  return created.id;
}

function countThreads(artifactId: string): Promise<number> {
  return withDb((db) => db.commentThread.count({ where: { artifactId } }));
}

function countLiveComments(artifactId: string): Promise<number> {
  return withDb((db) =>
    db.comment.count({ where: { thread: { artifactId }, deletedAt: null } })
  );
}

async function commentText(commentId: string): Promise<string | null> {
  const row = await withDb((db) =>
    db.comment.findUniqueOrThrow({
      where: { id: commentId },
      select: { plainText: true },
    })
  );
  return row.plainText;
}

async function readReceiptCommentIds(
  organizationId: string
): Promise<(string | null)[]> {
  const rows = await withDb((db) =>
    db.artifactOperationReceipt.findMany({
      where: { organizationId },
      orderBy: { createdAt: "asc" },
      select: { commentId: true },
    })
  );
  return rows.map((row) => row.commentId);
}

async function replyId(artifactId: string, rootId: string): Promise<string> {
  const row = await withDb((db) =>
    db.comment.findFirstOrThrow({
      where: { thread: { artifactId }, id: { not: rootId } },
      select: { id: true },
    })
  );
  return row.id;
}
