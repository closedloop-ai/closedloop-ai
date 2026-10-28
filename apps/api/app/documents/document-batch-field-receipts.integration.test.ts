import {
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import { BatchMutationRoute } from "@repo/api/src/types/batch-mutation-routes";
import { Priority } from "@repo/api/src/types/common";
import { DocumentStatus } from "@repo/api/src/types/document";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import type { NextRequest } from "next/server";
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

import { POST as batchPriority } from "@/app/documents/batch-update-priority/route";
import { POST as batchPriorityV2 } from "@/app/documents/batch-update-priority/v2/route";
import { POST as batchStatus } from "@/app/documents/batch-update-status/route";
import { POST as batchStatusV2 } from "@/app/documents/batch-update-status/v2/route";

const harness = createReceiptRouteHarness();
const PRIORITY_V2_ROUTE = "/documents/batch-update-priority/v2";
const STATUS_V2_ROUTE = "/documents/batch-update-status/v2";

type BatchRoute = (
  request: NextRequest,
  context: { params: Promise<Record<string, string>> }
) => Promise<Response>;

/**
 * ISS-12552: an API-key batch status or priority update records
 * one UpdateFields receipt per document it applied to, in the batch's own
 * transaction. A document that already held the value is a no-op.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 document batch field update receipts",
  () => {
    afterEach(() => harness.cleanup());

    it.each<{
      name: string;
      route: BatchRoute;
      path: string;
      body: Record<string, string>;
    }>([
      {
        name: "batch-update-priority",
        route: batchPriority,
        path: BatchMutationRoute.DocumentsUpdatePriority,
        body: { priority: Priority.High },
      },
      {
        name: "batch-update-priority/v2",
        route: batchPriorityV2,
        path: PRIORITY_V2_ROUTE,
        body: { priority: Priority.High },
      },
      {
        name: "batch-update-status",
        route: batchStatus,
        path: BatchMutationRoute.DocumentsUpdateStatus,
        body: { status: DocumentStatus.InReview },
      },
      {
        name: "batch-update-status/v2",
        route: batchStatusV2,
        path: STATUS_V2_ROUTE,
        body: { status: DocumentStatus.InReview },
      },
    ])(
      "POST $name leaves every document unchanged when a receipt cannot be stored",
      async ({ route, path, body }) => {
        const world = await harness.seedWorld();
        const ids = [
          await harness.seedDocument(world, "Kept A"),
          await harness.seedDocument(world, "Kept B"),
        ];
        const before = await readFields(ids);
        failReceiptInserts();

        const response = await route(
          apiKeyRouteRequest("POST", path, { documentIds: ids, ...body }),
          receiptRouteParams({})
        );

        expect(response.status).toBe(500);
        expect(forcedReceiptFailures()).toBe(1);
        expect(await readFields(ids)).toEqual(before);
        expect(await countReceipts(world.organizationId)).toBe(0);
      }
    );

    it("POST batch-update-status/v2 records the moved document and a no-op for one already holding the status", async () => {
      const world = await harness.seedWorld();
      const [moved, unchanged] = [
        await harness.seedDocument(world, "Moved"),
        await harness.seedDocument(world, "Unchanged"),
      ];
      await setStatus(unchanged, DocumentStatus.InReview);

      const response = await batchStatusV2(
        apiKeyRouteRequest("POST", STATUS_V2_ROUTE, {
          documentIds: [moved, unchanged],
          status: DocumentStatus.InReview,
        }),
        receiptRouteParams({})
      );

      expect(response.status).toBe(200);
      const receipts = await readReceipts(world.organizationId);
      expect(receipts).toHaveLength(2);
      expect(receipts).toEqual(
        expect.arrayContaining([
          fieldReceipt(moved, OperationReceiptOutcome.Committed, ["status"]),
          fieldReceipt(unchanged, OperationReceiptOutcome.NoOp, []),
        ])
      );
    });

    it("POST batch-update-priority/v2 records nothing for an id it could not find", async () => {
      const world = await harness.seedWorld();
      const documentId = await harness.seedDocument(world, "Prioritized");

      const response = await batchPriorityV2(
        apiKeyRouteRequest("POST", PRIORITY_V2_ROUTE, {
          documentIds: [documentId, crypto.randomUUID()],
          priority: Priority.High,
        }),
        receiptRouteParams({})
      );

      expect(response.status).toBe(200);
      expect(await readReceipts(world.organizationId)).toEqual([
        {
          ...fieldReceipt(documentId, OperationReceiptOutcome.Committed, [
            "priority",
          ]),
          route: PRIORITY_V2_ROUTE,
        },
      ]);
    });

    it("writes no receipt with attribution-evidence-policy off", async () => {
      const world = await harness.seedWorld();
      const documentId = await harness.seedDocument(world, "Prioritized");
      turnAttributionFlagOff();

      const response = await batchPriority(
        apiKeyRouteRequest("POST", BatchMutationRoute.DocumentsUpdatePriority, {
          documentIds: [documentId],
          priority: Priority.High,
        }),
        receiptRouteParams({})
      );

      expect(response.status).toBe(200);
      expect(await readFields([documentId])).toEqual([
        {
          id: documentId,
          status: DocumentStatus.Draft,
          priority: Priority.High,
        },
      ]);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });
  }
);

function fieldReceipt(
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
    route: STATUS_V2_ROUTE,
  };
}

function readFields(ids: string[]) {
  return withDb((db) =>
    db.artifact.findMany({
      where: { id: { in: ids } },
      orderBy: { id: "asc" },
      select: { id: true, status: true, priority: true },
    })
  );
}

async function setStatus(documentId: string, status: DocumentStatus) {
  await withDb((db) =>
    db.artifact.update({
      where: { id: documentId },
      data: { status },
      select: { id: true },
    })
  );
}
