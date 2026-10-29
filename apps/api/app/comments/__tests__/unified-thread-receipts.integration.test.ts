import { randomUUID } from "node:crypto";
import {
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import { ThreadStatus } from "@repo/api/src/types/comment";
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
import { commentTraceAnchor } from "@/__tests__/support/comments/comment-service.test-fixtures";
import { POST as createThread } from "@/app/artifacts/[id]/comments/threads/route";
import { POST as reopenThread } from "@/app/comments/threads/[threadId]/reopen/route";
import { POST as replyToThread } from "@/app/comments/threads/[threadId]/replies/route";
import { POST as resolveThread } from "@/app/comments/threads/[threadId]/resolve/route";

const harness = createReceiptRouteHarness();
const CREATE_THREAD_ROUTE = "/artifacts/[id]/comments/threads";

/**
 * ISS-12552: an API-key comment thread, reply, resolve or
 * reopen records its receipt in the comment command's own transaction. These
 * routes have no catch of their own, so a failed receipt rejects the handler,
 * which `withAnyAuth` answers with 500 in production.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 unified comment thread receipts",
  () => {
    afterEach(() => harness.cleanup());

    it("POST threads rolls the thread back when its receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      const sessionId = await seedReceiptSession(world);
      failReceiptInserts();

      await expect(
        createThread(
          apiKeyRouteRequest(
            "POST",
            `/artifacts/${sessionId}/comments/threads`,
            threadBody()
          ),
          receiptRouteParams({ id: sessionId })
        )
      ).rejects.toThrow();

      expect(forcedReceiptFailures()).toBe(1);
      expect(await countThreads(sessionId)).toBe(0);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("POST replies rolls the reply back when its receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      const sessionId = await seedReceiptSession(world);
      const { threadId } = await seedReceiptThread(world, sessionId);
      failReceiptInserts();

      await expect(
        replyToThread(
          apiKeyRouteRequest("POST", `/comments/threads/${threadId}/replies`, {
            body: "reply",
            clientId: randomUUID(),
          }),
          receiptRouteParams({ threadId })
        )
      ).rejects.toThrow();

      expect(forcedReceiptFailures()).toBe(1);
      expect(await countComments(threadId)).toBe(1);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("POST resolve keeps the thread open when its receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      const sessionId = await seedReceiptSession(world);
      const { threadId } = await seedReceiptThread(world, sessionId);
      failReceiptInserts();

      await expect(
        resolveThread(
          apiKeyRouteRequest("POST", `/comments/threads/${threadId}/resolve`),
          receiptRouteParams({ threadId })
        )
      ).rejects.toThrow();

      expect(forcedReceiptFailures()).toBe(1);
      expect(await threadStatus(threadId)).toBe(ThreadStatus.Open);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("POST reopen keeps the thread resolved when its receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      const sessionId = await seedReceiptSession(world);
      const { threadId } = await seedReceiptThread(world, sessionId);
      await markResolved(threadId);
      failReceiptInserts();

      await expect(
        reopenThread(
          apiKeyRouteRequest("POST", `/comments/threads/${threadId}/reopen`),
          receiptRouteParams({ threadId })
        )
      ).rejects.toThrow();

      expect(forcedReceiptFailures()).toBe(1);
      expect(await threadStatus(threadId)).toBe(ThreadStatus.Resolved);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("records a comment naming the artifact and its root, and a replayed client id as a no-op", async () => {
      const world = await harness.seedWorld();
      const sessionId = await seedReceiptSession(world);
      const body = threadBody();
      const post = () =>
        createThread(
          apiKeyRouteRequest(
            "POST",
            `/artifacts/${sessionId}/comments/threads`,
            body
          ),
          receiptRouteParams({ id: sessionId })
        );

      const first = await post();
      const replay = await post();

      expect([first.status, replay.status]).toEqual([200, 200]);
      const created = (await first.json()) as {
        data: {
          comments: { id: string }[];
          operationReceipt?: { outcome: string };
        };
      };
      expect(created.data.operationReceipt?.outcome).toBe(
        OperationReceiptOutcome.Committed
      );
      expect(await readReceipts(world.organizationId)).toEqual(
        [OperationReceiptOutcome.Committed, OperationReceiptOutcome.NoOp].map(
          (outcome) => ({
            operationKind: OperationKind.Comment,
            outcome,
            source: OperationSource.Api,
            targetArtifactId: sessionId,
            createdArtifactId: null,
            changedFields: [],
            route: CREATE_THREAD_ROUTE,
          })
        )
      );
      expect(await readReceiptCommentIds(world.organizationId)).toEqual([
        created.data.comments[0]?.id,
        created.data.comments[0]?.id,
      ]);
    });

    it("writes no receipt with attribution-evidence-policy off", async () => {
      const world = await harness.seedWorld();
      const sessionId = await seedReceiptSession(world);
      turnAttributionFlagOff();

      const response = await createThread(
        apiKeyRouteRequest(
          "POST",
          `/artifacts/${sessionId}/comments/threads`,
          threadBody()
        ),
        receiptRouteParams({ id: sessionId })
      );

      expect(response.status).toBe(200);
      expect(await countThreads(sessionId)).toBe(1);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });
  }
);

function threadBody() {
  return {
    anchor: commentTraceAnchor(1),
    body: "root",
    clientId: randomUUID(),
  };
}

function countThreads(artifactId: string): Promise<number> {
  return withDb((db) => db.commentThread.count({ where: { artifactId } }));
}

function countComments(threadId: string): Promise<number> {
  return withDb((db) =>
    db.comment.count({ where: { threadId, deletedAt: null } })
  );
}

async function threadStatus(threadId: string): Promise<string> {
  const thread = await withDb((db) =>
    db.commentThread.findUniqueOrThrow({
      where: { id: threadId },
      select: { status: true },
    })
  );
  return thread.status;
}

async function markResolved(threadId: string): Promise<void> {
  await withDb((db) =>
    db.commentThread.update({
      where: { id: threadId },
      data: { status: ThreadStatus.Resolved, resolvedAt: new Date() },
      select: { id: true },
    })
  );
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
