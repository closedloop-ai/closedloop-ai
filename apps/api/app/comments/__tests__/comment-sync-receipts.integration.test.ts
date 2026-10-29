import {
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
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
  seedReceiptSession,
  seedReceiptThread,
} from "@/__tests__/support/comments/comment-receipt-route.test-fixtures";
import { POST as retrySessionCommentSync } from "@/app/agent-sessions/[id]/trace-comments/[commentId]/retry-sync/route";
import { POST as abandonSessionCommentSync } from "@/app/agent-sessions/[id]/trace-comments/[commentId]/sync-abandoned/route";
import { POST as retryThreadSync } from "@/app/comments/threads/[threadId]/retry-sync/route";

const harness = createReceiptRouteHarness();
const ABANDON_ROUTE =
  "/agent-sessions/[id]/trace-comments/[commentId]/sync-abandoned";

/**
 * ISS-12552: retry-sync and sync-abandoned write only the
 * thread's Desktop delivery row, in the comment command's own transaction and
 * with no provider call, so each records a Desktop sync receipt there.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 comment sync state receipts",
  () => {
    afterEach(() => harness.cleanup());

    async function seedSessionThread(abandoned: boolean) {
      const world = await harness.seedWorld();
      const sessionId = await seedReceiptSession(world);
      const thread = await seedReceiptThread(world, sessionId);
      if (abandoned) {
        await seedDeliveryState(
          world.organizationId,
          thread.threadId,
          CommentSyncStatus.Abandoned
        );
      }
      return { world, sessionId, ...thread };
    }

    it("POST threads retry-sync keeps the dead letter when its receipt cannot be stored", async () => {
      const { world, threadId } = await seedSessionThread(true);
      failReceiptInserts();

      await expect(
        retryThreadSync(
          apiKeyRouteRequest(
            "POST",
            `/comments/threads/${threadId}/retry-sync`
          ),
          receiptRouteParams({ threadId })
        )
      ).rejects.toThrow();

      expect(forcedReceiptFailures()).toBe(1);
      expect(await deliveryState(threadId)).toBe(CommentSyncStatus.Abandoned);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("POST trace retry-sync keeps the dead letter when its receipt cannot be stored", async () => {
      const { world, sessionId, threadId, rootCommentId } =
        await seedSessionThread(true);
      failReceiptInserts();

      const response = await retrySessionCommentSync(
        apiKeyRouteRequest(
          "POST",
          `/agent-sessions/${sessionId}/trace-comments/${rootCommentId}/retry-sync`
        ),
        receiptRouteParams({ id: sessionId, commentId: rootCommentId })
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await deliveryState(threadId)).toBe(CommentSyncStatus.Abandoned);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("POST trace sync-abandoned records no dead letter when its receipt cannot be stored", async () => {
      const { world, sessionId, threadId, rootCommentId } =
        await seedSessionThread(false);
      failReceiptInserts();

      const response = await abandonSessionCommentSync(
        apiKeyRouteRequest(
          "POST",
          `/agent-sessions/${sessionId}/trace-comments/${rootCommentId}/sync-abandoned`
        ),
        receiptRouteParams({ id: sessionId, commentId: rootCommentId })
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await deliveryState(threadId)).toBeNull();
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("records a Desktop sync write naming the session, and a repeat as a no-op", async () => {
      const { world, sessionId, rootCommentId } =
        await seedSessionThread(false);
      const abandon = () =>
        abandonSessionCommentSync(
          apiKeyRouteRequest(
            "POST",
            `/agent-sessions/${sessionId}/trace-comments/${rootCommentId}/sync-abandoned`
          ),
          receiptRouteParams({ id: sessionId, commentId: rootCommentId })
        );

      const statuses = [(await abandon()).status, (await abandon()).status];

      expect(statuses).toEqual([200, 200]);
      expect(await readReceipts(world.organizationId)).toEqual(
        [OperationReceiptOutcome.Committed, OperationReceiptOutcome.NoOp].map(
          (outcome) => ({
            operationKind: OperationKind.DesktopSync,
            outcome,
            source: OperationSource.Api,
            targetArtifactId: sessionId,
            createdArtifactId: null,
            changedFields: [],
            route: ABANDON_ROUTE,
          })
        )
      );
    });

    it("writes no receipt with attribution-evidence-policy off", async () => {
      const { world, threadId } = await seedSessionThread(true);
      turnAttributionFlagOff();

      const response = await retryThreadSync(
        apiKeyRouteRequest("POST", `/comments/threads/${threadId}/retry-sync`),
        receiptRouteParams({ threadId })
      );

      expect(response.status).toBe(200);
      expect(await deliveryState(threadId)).toBe(CommentSyncStatus.Pending);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });
  }
);

async function seedDeliveryState(
  organizationId: string,
  threadId: string,
  state: CommentSyncStatus
): Promise<void> {
  await withDb((db) =>
    db.commentSyncState.create({
      data: {
        organizationId,
        threadId,
        provider: CommentSyncProvider.Desktop,
        direction: CommentSyncDirection.Inbound,
        state,
      },
      select: { id: true },
    })
  );
}

async function deliveryState(threadId: string): Promise<string | null> {
  const row = await withDb((db) =>
    db.commentSyncState.findFirst({
      where: {
        threadId,
        provider: CommentSyncProvider.Desktop,
        direction: CommentSyncDirection.Inbound,
      },
      select: { state: true },
    })
  );
  return row?.state ?? null;
}
