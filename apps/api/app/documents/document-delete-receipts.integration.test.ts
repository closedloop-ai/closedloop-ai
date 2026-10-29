import {
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import { BatchMutationRoute } from "@repo/api/src/types/batch-mutation-routes";
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

import { DELETE as deleteDocument } from "@/app/documents/[id]/route";
import { POST as batchDelete } from "@/app/documents/batch-delete/route";
import { POST as batchDeleteV2 } from "@/app/documents/batch-delete/v2/route";

const harness = createReceiptRouteHarness();
const DELETE_ROUTE = "/documents/[id]";
const BATCH_DELETE_V2_ROUTE = "/documents/batch-delete/v2";

/**
 * ISS-12552: an API-key document delete records one receipt per
 * deleted document, in the delete's own transaction.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 document delete receipts",
  () => {
    afterEach(() => harness.cleanup());

    it("DELETE keeps the document when its receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      const documentId = await harness.seedDocument(world, "Kept");
      failReceiptInserts();

      const response = await deleteDocument(
        apiKeyRouteRequest("DELETE", `/documents/${documentId}`),
        receiptRouteParams({ id: documentId })
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await countDocuments([documentId])).toBe(1);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("POST batch-delete keeps every document when a receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      const ids = [
        await harness.seedDocument(world, "Kept A"),
        await harness.seedDocument(world, "Kept B"),
      ];
      failReceiptInserts();

      const response = await batchDelete(
        apiKeyRouteRequest("POST", BatchMutationRoute.DocumentsDelete, {
          documentIds: ids,
        }),
        receiptRouteParams({})
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await countDocuments(ids)).toBe(2);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("POST batch-delete/v2 keeps every document when a receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      const ids = [
        await harness.seedDocument(world, "Kept A"),
        await harness.seedDocument(world, "Kept B"),
      ];
      failReceiptInserts();

      const response = await batchDeleteV2(
        apiKeyRouteRequest("POST", BATCH_DELETE_V2_ROUTE, {
          documentIds: ids,
        }),
        receiptRouteParams({})
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await countDocuments(ids)).toBe(2);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("DELETE records a delete naming the document", async () => {
      const world = await harness.seedWorld();
      const documentId = await harness.seedDocument(world, "Deleted");

      const response = await deleteDocument(
        apiKeyRouteRequest("DELETE", `/documents/${documentId}`),
        receiptRouteParams({ id: documentId })
      );

      expect(response.status).toBe(200);
      expect(await countDocuments([documentId])).toBe(0);
      expect(await readReceipts(world.organizationId)).toEqual([
        deleteReceipt(documentId, DELETE_ROUTE),
      ]);
    });

    it("POST batch-delete/v2 records one delete per deleted document and none for a missing id", async () => {
      const world = await harness.seedWorld();
      const ids = [
        await harness.seedDocument(world, "Deleted A"),
        await harness.seedDocument(world, "Deleted B"),
      ];
      const missingId = crypto.randomUUID();

      const response = await batchDeleteV2(
        apiKeyRouteRequest("POST", BATCH_DELETE_V2_ROUTE, {
          documentIds: [...ids, missingId],
        }),
        receiptRouteParams({})
      );

      expect(response.status).toBe(200);
      expect(await countDocuments(ids)).toBe(0);
      const receipts = await readReceipts(world.organizationId);
      expect(receipts).toHaveLength(2);
      expect(receipts).toEqual(
        expect.arrayContaining(
          ids.map((id) => deleteReceipt(id, BATCH_DELETE_V2_ROUTE))
        )
      );
    });

    it("writes no receipt with attribution-evidence-policy off", async () => {
      const world = await harness.seedWorld();
      const documentId = await harness.seedDocument(world, "Deleted");
      turnAttributionFlagOff();

      const response = await batchDelete(
        apiKeyRouteRequest("POST", BatchMutationRoute.DocumentsDelete, {
          documentIds: [documentId],
        }),
        receiptRouteParams({})
      );

      expect(response.status).toBe(200);
      expect(await countDocuments([documentId])).toBe(0);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });
  }
);

function deleteReceipt(documentId: string, route: string) {
  return {
    operationKind: OperationKind.Delete,
    outcome: OperationReceiptOutcome.Committed,
    source: OperationSource.Api,
    targetArtifactId: documentId,
    createdArtifactId: null,
    changedFields: [],
    route,
  };
}

function countDocuments(ids: string[]): Promise<number> {
  return withDb((db) => db.artifact.count({ where: { id: { in: ids } } }));
}
