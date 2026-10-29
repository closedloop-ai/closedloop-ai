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
import { createTestProject } from "@/__tests__/utils/db-helpers";

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

import { POST as batchMove } from "@/app/documents/batch-move/route";
import { POST as batchMoveV2 } from "@/app/documents/batch-move/v2/route";

const harness = createReceiptRouteHarness();
const BATCH_MOVE_V2_ROUTE = "/documents/batch-move/v2";

/**
 * ISS-12552: an API-key batch move records one Move receipt per
 * document it wrote, in the batch's own transaction.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 document batch move receipts",
  () => {
    afterEach(() => harness.cleanup());

    it("POST batch-move leaves every document in place when a receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      const target = await createTestProject(
        world.organizationId,
        world.userId
      );
      const ids = [
        await harness.seedDocument(world, "Kept A"),
        await harness.seedDocument(world, "Kept B"),
      ];
      failReceiptInserts();

      const response = await batchMove(
        apiKeyRouteRequest("POST", BatchMutationRoute.DocumentsMove, {
          documentIds: ids,
          targetProjectId: target,
        }),
        receiptRouteParams({})
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await countInProject(ids, world.projectId)).toBe(2);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("POST batch-move/v2 leaves every document in place when a receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      const target = await createTestProject(
        world.organizationId,
        world.userId
      );
      const ids = [
        await harness.seedDocument(world, "Kept A"),
        await harness.seedDocument(world, "Kept B"),
      ];
      failReceiptInserts();

      const response = await batchMoveV2(
        apiKeyRouteRequest("POST", BATCH_MOVE_V2_ROUTE, {
          documentIds: ids,
          targetProjectId: target,
        }),
        receiptRouteParams({})
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await countInProject(ids, world.projectId)).toBe(2);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("POST batch-move/v2 records a move per moved document and none for a missing id", async () => {
      const world = await harness.seedWorld();
      const target = await createTestProject(
        world.organizationId,
        world.userId
      );
      const documentId = await harness.seedDocument(world, "Moved");

      const response = await batchMoveV2(
        apiKeyRouteRequest("POST", BATCH_MOVE_V2_ROUTE, {
          documentIds: [documentId, crypto.randomUUID()],
          targetProjectId: target,
        }),
        receiptRouteParams({})
      );

      expect(response.status).toBe(200);
      expect(await countInProject([documentId], target)).toBe(1);
      expect(await readReceipts(world.organizationId)).toEqual([
        {
          operationKind: OperationKind.Move,
          outcome: OperationReceiptOutcome.Committed,
          source: OperationSource.Api,
          targetArtifactId: documentId,
          createdArtifactId: null,
          changedFields: ["projectId", "sortOrder"],
          route: BATCH_MOVE_V2_ROUTE,
        },
      ]);
    });

    it("writes no receipt with attribution-evidence-policy off", async () => {
      const world = await harness.seedWorld();
      const target = await createTestProject(
        world.organizationId,
        world.userId
      );
      const documentId = await harness.seedDocument(world, "Moved");
      turnAttributionFlagOff();

      const response = await batchMove(
        apiKeyRouteRequest("POST", BatchMutationRoute.DocumentsMove, {
          documentIds: [documentId],
          targetProjectId: target,
        }),
        receiptRouteParams({})
      );

      expect(response.status).toBe(200);
      expect(await countInProject([documentId], target)).toBe(1);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });
  }
);

function countInProject(ids: string[], projectId: string): Promise<number> {
  return withDb((db) =>
    db.artifact.count({ where: { id: { in: ids }, projectId } })
  );
}
