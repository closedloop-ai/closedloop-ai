import { randomUUID } from "node:crypto";
import {
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import { ThreadSource, ThreadStatus } from "@repo/api/src/types/comment";
import { CommentBodyFormat } from "@repo/api/src/types/comment-thread-dto";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const liveblocks = vi.hoisted(() => ({
  markArtifactThreadResolved: vi.fn(),
  markArtifactThreadUnresolved: vi.fn(),
}));
vi.mock(
  "@repo/collaboration/server/room-management",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    markArtifactThreadResolved: liveblocks.markArtifactThreadResolved,
    markArtifactThreadUnresolved: liveblocks.markArtifactThreadUnresolved,
  })
);

import { POST as resolveThread } from "@/app/documents/[id]/threads/[threadId]/resolve/route";
import { POST as unresolveThread } from "@/app/documents/[id]/threads/[threadId]/unresolve/route";

const harness = createReceiptRouteHarness();
const organizationIds: string[] = [];
const RESOLVE_ROUTE = "/documents/[id]/threads/[threadId]/resolve";

/**
 * ISS-12552: an API-key document thread resolve or reopen
 * records its receipt in the local projection's transaction, after the
 * Liveblocks call. A projection that fails undoes the Liveblocks change, as
 * the document thread create and reply routes delete theirs.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 document thread resolution receipts",
  () => {
    beforeEach(() => {
      liveblocks.markArtifactThreadResolved.mockReset().mockResolvedValue({});
      liveblocks.markArtifactThreadUnresolved.mockReset().mockResolvedValue({});
    });

    afterEach(async () => {
      const orgIds = organizationIds.splice(0);
      await withDb((db) =>
        db.commentThread.deleteMany({
          where: { organizationId: { in: orgIds } },
        })
      );
      await harness.cleanup();
    });

    async function seedDocumentThread(status: ThreadStatus) {
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
            status,
            ...(status === ThreadStatus.Resolved
              ? { resolvedAt: new Date(), resolvedById: world.userId }
              : {}),
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

    function post(
      route: typeof resolveThread,
      action: "resolve" | "unresolve",
      documentId: string,
      threadId: string
    ) {
      return route(
        apiKeyRouteRequest(
          "POST",
          `/documents/${documentId}/threads/${threadId}/${action}`
        ),
        receiptRouteParams({ id: documentId, threadId })
      );
    }

    it("POST resolve keeps the projection open and reopens Liveblocks when its receipt cannot be stored", async () => {
      const { world, documentId, externalId, roomId } =
        await seedDocumentThread(ThreadStatus.Open);
      failReceiptInserts();

      const response = await post(
        resolveThread,
        "resolve",
        documentId,
        externalId
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await threadStatus(externalId)).toBe(ThreadStatus.Open);
      expect(await countReceipts(world.organizationId)).toBe(0);
      expect(liveblocks.markArtifactThreadUnresolved).toHaveBeenCalledWith({
        roomId,
        threadId: externalId,
        userId: world.userId,
      });
    });

    it("POST unresolve keeps the projection resolved and resolves Liveblocks again when its receipt cannot be stored", async () => {
      const { world, documentId, externalId, roomId } =
        await seedDocumentThread(ThreadStatus.Resolved);
      failReceiptInserts();

      const response = await post(
        unresolveThread,
        "unresolve",
        documentId,
        externalId
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await threadStatus(externalId)).toBe(ThreadStatus.Resolved);
      expect(await countReceipts(world.organizationId)).toBe(0);
      expect(liveblocks.markArtifactThreadResolved).toHaveBeenCalledWith({
        roomId,
        threadId: externalId,
        userId: world.userId,
      });
    });

    it("POST resolve leaves an already resolved Liveblocks thread alone when its receipt cannot be stored", async () => {
      const { world, documentId, externalId } = await seedDocumentThread(
        ThreadStatus.Resolved
      );
      failReceiptInserts();

      const response = await post(
        resolveThread,
        "resolve",
        documentId,
        externalId
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(liveblocks.markArtifactThreadUnresolved).not.toHaveBeenCalled();
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("records a committed comment when the thread has no local row by the time it is projected", async () => {
      const { world, documentId, externalId } = await seedDocumentThread(
        ThreadStatus.Open
      );
      liveblocks.markArtifactThreadResolved.mockImplementation(async () => {
        await withDb((db) =>
          db.commentThread.deleteMany({ where: { externalId } })
        );
        return {};
      });

      const response = await post(
        resolveThread,
        "resolve",
        documentId,
        externalId
      );

      expect(response.status).toBe(200);
      expect(await readReceipts(world.organizationId)).toEqual([
        {
          operationKind: OperationKind.Comment,
          outcome: OperationReceiptOutcome.Committed,
          source: OperationSource.Api,
          targetArtifactId: documentId,
          createdArtifactId: null,
          changedFields: [],
          route: RESOLVE_ROUTE,
        },
      ]);
    });

    it("records a comment on the document, and a repeated resolve as a no-op", async () => {
      const { world, documentId, externalId } = await seedDocumentThread(
        ThreadStatus.Open
      );

      const statuses = [
        (await post(resolveThread, "resolve", documentId, externalId)).status,
        (await post(resolveThread, "resolve", documentId, externalId)).status,
      ];

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
            route: RESOLVE_ROUTE,
          })
        )
      );
    });

    it("writes no receipt with attribution-evidence-policy off", async () => {
      const { world, documentId, externalId } = await seedDocumentThread(
        ThreadStatus.Open
      );
      turnAttributionFlagOff();

      const response = await post(
        resolveThread,
        "resolve",
        documentId,
        externalId
      );

      expect(response.status).toBe(200);
      expect(await threadStatus(externalId)).toBe(ThreadStatus.Resolved);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });
  }
);

async function threadStatus(externalId: string): Promise<string> {
  const thread = await withDb((db) =>
    db.commentThread.findFirstOrThrow({
      where: { externalId },
      select: { status: true },
    })
  );
  return thread.status;
}
