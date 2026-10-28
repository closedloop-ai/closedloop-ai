import { randomUUID } from "node:crypto";
import { CommentTargetType } from "@repo/api/src/types/comment";
import {
  CommentSyncDirection,
  CommentSyncProvider,
  CommentSyncStatus,
} from "@repo/api/src/types/comment-thread-dto";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiKeyRouteRequest,
  countReceipts,
  createReceiptRouteHarness,
  receiptRouteParams,
  turnAttributionFlagOff,
} from "@/__tests__/support/lib/operation-receipt-route.test-helpers";
import { countTransactions } from "@/__tests__/support/lib/transaction-count.test-helpers";

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
import { POST as retrySessionCommentSync } from "@/app/agent-sessions/[id]/trace-comments/[commentId]/retry-sync/route";
import {
  DELETE as deleteSessionComment,
  PATCH as editSessionComment,
} from "@/app/agent-sessions/[id]/trace-comments/[commentId]/route";
import { POST as abandonSessionCommentSync } from "@/app/agent-sessions/[id]/trace-comments/[commentId]/sync-abandoned/route";
import { POST as createSessionComment } from "@/app/agent-sessions/[id]/trace-comments/route";
import { POST as abandonBranchCommentSync } from "@/app/branches/[id]/trace-comments/[commentId]/sync-abandoned/route";
import { POST as createBranchComment } from "@/app/branches/[id]/trace-comments/route";
import { traceCommentsService } from "./service";

const harness = createReceiptRouteHarness();

/**
 * ISS-12552: flag-off behavior equals main for Session and Branch trace
 * comment writes. With `attribution-evidence-policy` off, the service is
 * handed no record, the answer is main's body with no receipt, the write
 * persists in main's one command transaction, and nothing is recorded.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 trace comment writes match main with attribution evidence off",
  () => {
    afterEach(async () => {
      vi.restoreAllMocks();
      await harness.cleanup();
    });

    it("POST a Session comment", async () => {
      const world = await harness.seedWorld();
      const sessionId = await seedReceiptSession(world);
      turnAttributionFlagOff();
      const service = vi.spyOn(traceCommentsService, "create");
      const transactions = countTransactions();

      const response = await createSessionComment(
        apiKeyRouteRequest(
          "POST",
          `/agent-sessions/${sessionId}/trace-comments`,
          draft()
        ),
        receiptRouteParams({ id: sessionId })
      );

      expect(await observedAnswer(response, service.mock.calls)).toStrictEqual(
        mainAnswer(await service.mock.results[0]?.value)
      );
      expect(transactions.opened).toBe(1);
      expect(await countLiveComments(sessionId)).toBe(1);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("POST a Branch comment", async () => {
      const world = await harness.seedWorld();
      const branchId = await seedReceiptBranch(world);
      turnAttributionFlagOff();
      const service = vi.spyOn(traceCommentsService, "create");
      const transactions = countTransactions();

      const response = await createBranchComment(
        apiKeyRouteRequest(
          "POST",
          `/branches/${branchId}/trace-comments`,
          draft()
        ),
        receiptRouteParams({ id: branchId })
      );

      expect(await observedAnswer(response, service.mock.calls)).toStrictEqual(
        mainAnswer(await service.mock.results[0]?.value)
      );
      expect(transactions.opened).toBe(1);
      expect(await countLiveComments(branchId)).toBe(1);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("POST a reply", async () => {
      const { world, sessionId, commentId } = await seedSessionComment();
      turnAttributionFlagOff();
      const service = vi.spyOn(traceCommentsService, "reply");
      const transactions = countTransactions();

      const response = await replyToSessionComment(
        apiKeyRouteRequest(
          "POST",
          `/agent-sessions/${sessionId}/trace-comments/${commentId}/replies`,
          { body: "reply" }
        ),
        receiptRouteParams({ id: sessionId, commentId })
      );

      expect(await observedAnswer(response, service.mock.calls)).toStrictEqual(
        mainAnswer(mutationValue(await service.mock.results[0]?.value))
      );
      expect(transactions.opened).toBe(1);
      expect(await countLiveComments(sessionId)).toBe(2);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("PATCH a comment", async () => {
      const { world, sessionId, commentId } = await seedSessionComment();
      turnAttributionFlagOff();
      const service = vi.spyOn(traceCommentsService, "update");
      const transactions = countTransactions();

      const response = await editSessionComment(
        apiKeyRouteRequest(
          "PATCH",
          `/agent-sessions/${sessionId}/trace-comments/${commentId}`,
          { body: "edited" }
        ),
        receiptRouteParams({ id: sessionId, commentId })
      );

      expect(await observedAnswer(response, service.mock.calls)).toStrictEqual(
        mainAnswer(mutationValue(await service.mock.results[0]?.value))
      );
      expect(transactions.opened).toBe(1);
      expect(await commentText(commentId)).toBe("edited");
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("DELETE a comment", async () => {
      const { world, sessionId, commentId } = await seedSessionComment();
      turnAttributionFlagOff();
      const service = vi.spyOn(traceCommentsService, "delete");
      const transactions = countTransactions();

      const response = await deleteSessionComment(
        apiKeyRouteRequest(
          "DELETE",
          `/agent-sessions/${sessionId}/trace-comments/${commentId}`
        ),
        receiptRouteParams({ id: sessionId, commentId })
      );

      expect(await observedAnswer(response, service.mock.calls)).toStrictEqual(
        mainAnswer(mutationValue(await service.mock.results[0]?.value))
      );
      expect(transactions.opened).toBe(1);
      expect(await countLiveComments(sessionId)).toBe(0);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("POST retry-sync", async () => {
      const { world, sessionId, commentId } = await seedSessionComment();
      await seedDeadLetter(world.organizationId, sessionId);
      turnAttributionFlagOff();
      const service = vi.spyOn(traceCommentsService, "retrySync");
      const transactions = countTransactions();

      const response = await retrySessionCommentSync(
        apiKeyRouteRequest(
          "POST",
          `/agent-sessions/${sessionId}/trace-comments/${commentId}/retry-sync`
        ),
        receiptRouteParams({ id: sessionId, commentId })
      );

      expect(await observedAnswer(response, service.mock.calls)).toStrictEqual(
        mainAnswer(mutationValue(await service.mock.results[0]?.value))
      );
      expect(transactions.opened).toBe(1);
      expect(await deliveryState(sessionId)).toBe(CommentSyncStatus.Pending);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("POST sync-abandoned on a Session and a Branch", async () => {
      const session = await seedSessionComment();
      turnAttributionFlagOff();
      const service = vi.spyOn(traceCommentsService, "markSyncAbandoned");

      const sessionResponse = await abandonSessionCommentSync(
        apiKeyRouteRequest(
          "POST",
          `/agent-sessions/${session.sessionId}/trace-comments/${session.commentId}/sync-abandoned`
        ),
        receiptRouteParams({
          id: session.sessionId,
          commentId: session.commentId,
        })
      );
      expect(
        await observedAnswer(sessionResponse, service.mock.calls)
      ).toStrictEqual(
        mainAnswer(mutationValue(await service.mock.results[0]?.value))
      );
      expect(await deliveryState(session.sessionId)).toBe(
        CommentSyncStatus.Abandoned
      );
      expect(await countReceipts(session.world.organizationId)).toBe(0);

      service.mockClear();
      const branchWorld = await harness.seedWorld();
      turnAttributionFlagOff();
      const branchId = await seedReceiptBranch(branchWorld);
      const branchCommentId = await seedTraceComment(
        branchWorld,
        CommentTargetType.Branch,
        branchId
      );
      const transactions = countTransactions();

      const branchResponse = await abandonBranchCommentSync(
        apiKeyRouteRequest(
          "POST",
          `/branches/${branchId}/trace-comments/${branchCommentId}/sync-abandoned`
        ),
        receiptRouteParams({ id: branchId, commentId: branchCommentId })
      );
      expect(
        await observedAnswer(branchResponse, service.mock.calls)
      ).toStrictEqual(
        mainAnswer(mutationValue(await service.mock.results[0]?.value))
      );
      expect(transactions.opened).toBe(1);
      expect(await countReceipts(branchWorld.organizationId)).toBe(0);
    });
  }
);

/** What the caller got back and what the trace comment service was handed. */
async function observedAnswer(
  response: Response,
  calls: readonly (readonly unknown[])[]
) {
  return {
    serviceCalls: calls.length,
    record: calls[0]?.[1],
    status: response.status,
    body: await response.json(),
  };
}

/**
 * Main's answer to a trace comment write main served as `data`: the
 * service called once with no record (main passed none), 200, and exactly
 * `successResponse(data)`, so no `operationReceipt` rides along.
 */
function mainAnswer(data: unknown) {
  return {
    serviceCalls: 1,
    record: undefined,
    status: 200,
    body: { success: true, data: JSON.parse(JSON.stringify(data)) },
  };
}

/** What a legacy mutation route serves: the value of an ok result. */
function mutationValue(
  result: { ok: true; value: unknown } | { ok: false } | undefined
): unknown {
  if (!result?.ok) {
    throw new Error("the trace comment service did not succeed");
  }
  return result.value;
}

function draft() {
  return {
    anchor: legacyTraceAnchor(1),
    body: "root",
    clientId: randomUUID(),
  };
}

async function seedSessionComment() {
  const world = await harness.seedWorld();
  const sessionId = await seedReceiptSession(world);
  const commentId = await seedTraceComment(
    world,
    CommentTargetType.Session,
    sessionId
  );
  return { world, sessionId, commentId };
}

/** A root comment the world's caller left on the target, with no receipt. */
async function seedTraceComment(
  world: { organizationId: string; userId: string },
  type: CommentTargetType,
  id: string
): Promise<string> {
  const created = await traceCommentsService.create({
    organizationId: world.organizationId,
    userId: world.userId,
    target: { type, id },
    draft: { anchor: legacyTraceAnchor(1), body: "seeded root" },
  });
  if (!created || "ok" in created) {
    throw new Error("Failed to seed the ISS-12552 trace comment");
  }
  return created.id;
}

async function seedDeadLetter(
  organizationId: string,
  artifactId: string
): Promise<void> {
  const thread = await withDb((db) =>
    db.commentThread.findFirstOrThrow({
      where: { artifactId },
      select: { id: true },
    })
  );
  await withDb((db) =>
    db.commentSyncState.create({
      data: {
        organizationId,
        threadId: thread.id,
        provider: CommentSyncProvider.Desktop,
        direction: CommentSyncDirection.Inbound,
        state: CommentSyncStatus.Abandoned,
      },
      select: { id: true },
    })
  );
}

async function deliveryState(artifactId: string): Promise<string | null> {
  const row = await withDb((db) =>
    db.commentSyncState.findFirst({
      where: {
        thread: { artifactId },
        provider: CommentSyncProvider.Desktop,
        direction: CommentSyncDirection.Inbound,
      },
      select: { state: true },
    })
  );
  return row?.state ?? null;
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
