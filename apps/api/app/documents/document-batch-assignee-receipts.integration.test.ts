import {
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
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
import { createTestUser } from "@/__tests__/utils/db-helpers";

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

import { POST as batchAssigneeV2 } from "@/app/documents/batch-update-assignee/v2/route";

const harness = createReceiptRouteHarness();
const ROUTE = "/documents/batch-update-assignee/v2";

/**
 * ISS-12552: an API-key batch owner change records one
 * UpdateFields receipt per document it applied to, in the batch's own
 * transaction. A document that already had that owner is a no-op.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 document batch owner receipts",
  () => {
    afterEach(() => harness.cleanup());

    it("leaves every owner unchanged when a receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      const ids = [
        await harness.seedDocument(world, "Kept A"),
        await harness.seedDocument(world, "Kept B"),
      ];
      const owner = await createTestUser(world.organizationId);
      const before = await readAssignees(ids);
      failReceiptInserts();

      const response = await batchAssigneeV2(
        apiKeyRouteRequest("POST", ROUTE, {
          documentIds: ids,
          assigneeId: owner.id,
        }),
        receiptRouteParams({})
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await readAssignees(ids)).toEqual(before);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("records the reassigned document and a no-op for one that already had the owner", async () => {
      const world = await harness.seedWorld();
      const moved = await harness.seedDocument(world, "Moved");
      const unchanged = await harness.seedDocument(world, "Unchanged");
      const owner = await createTestUser(world.organizationId);
      await setAssignee(unchanged, owner.id);

      const response = await batchAssigneeV2(
        apiKeyRouteRequest("POST", ROUTE, {
          documentIds: [moved, unchanged, crypto.randomUUID()],
          assigneeId: owner.id,
        }),
        receiptRouteParams({})
      );

      expect(response.status).toBe(200);
      expect((await response.json()).data).not.toHaveProperty(
        "operationReceipt"
      );
      const receipts = await readReceipts(world.organizationId);
      expect(receipts).toHaveLength(2);
      expect(receipts).toEqual(
        expect.arrayContaining([
          ownerReceipt(moved, OperationReceiptOutcome.Committed, [
            "assigneeId",
          ]),
          ownerReceipt(unchanged, OperationReceiptOutcome.NoOp, []),
        ])
      );
    });

    it("writes no receipt with attribution-evidence-policy off", async () => {
      const world = await harness.seedWorld();
      const documentId = await harness.seedDocument(world, "Assigned");
      const owner = await createTestUser(world.organizationId);
      turnAttributionFlagOff();

      const response = await batchAssigneeV2(
        apiKeyRouteRequest("POST", ROUTE, {
          documentIds: [documentId],
          assigneeId: owner.id,
        }),
        receiptRouteParams({})
      );

      expect(response.status).toBe(200);
      expect(await readAssignees([documentId])).toEqual([
        { id: documentId, assigneeId: owner.id },
      ]);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });
  }
);

function ownerReceipt(
  documentId: string,
  outcome: OperationReceiptOutcome,
  changedFields: string[]
) {
  return {
    operationKind: OperationKind.UpdateFields,
    outcome,
    source: OperationSource.Api,
    targetArtifactId: documentId,
    createdArtifactId: null,
    changedFields,
    route: ROUTE,
  };
}

function readAssignees(ids: string[]) {
  return withDb((db) =>
    db.artifact.findMany({
      where: { id: { in: ids } },
      orderBy: { id: "asc" },
      select: { id: true, assigneeId: true },
    })
  );
}

async function setAssignee(documentId: string, assigneeId: string) {
  await withDb((db) =>
    db.artifact.update({
      where: { id: documentId },
      data: { assigneeId },
      select: { id: true },
    })
  );
}
