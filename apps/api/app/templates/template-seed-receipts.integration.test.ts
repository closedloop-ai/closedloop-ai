import {
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import { DocumentType } from "@repo/api/src/types/document";
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

import { POST as seedTemplates } from "@/app/templates/seed/route";

const harness = createReceiptRouteHarness();
const ROUTE = "/templates/seed";

/**
 * ISS-12552: an API-key template seed records an
 * organization write receipt in the seed transaction.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 template seed receipts",
  () => {
    afterEach(() => harness.cleanup());

    it("POST /templates/seed seeds nothing when its receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      failReceiptInserts();

      const response = await seedTemplates(
        apiKeyRouteRequest("POST", ROUTE),
        receiptRouteParams({})
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await countTemplates(world.organizationId)).toBe(0);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("POST /templates/seed records the seed, then an already-seeded organization as a no-op", async () => {
      const world = await harness.seedWorld();
      const send = () =>
        seedTemplates(
          apiKeyRouteRequest("POST", ROUTE),
          receiptRouteParams({})
        );

      const statuses = [(await send()).status, (await send()).status];

      expect(statuses).toEqual([200, 200]);
      expect(await countTemplates(world.organizationId)).toBe(1);
      expect(await readReceipts(world.organizationId)).toEqual(
        [OperationReceiptOutcome.Committed, OperationReceiptOutcome.NoOp].map(
          (outcome) => ({
            operationKind: OperationKind.OrganizationWrite,
            outcome,
            source: OperationSource.Api,
            targetArtifactId: null,
            createdArtifactId: null,
            changedFields: [],
            route: ROUTE,
          })
        )
      );
    });

    it("POST /templates/seed writes no receipt with attribution-evidence-policy off", async () => {
      const world = await harness.seedWorld();
      turnAttributionFlagOff();

      const response = await seedTemplates(
        apiKeyRouteRequest("POST", ROUTE),
        receiptRouteParams({})
      );

      expect(response.status).toBe(200);
      expect(await countTemplates(world.organizationId)).toBe(1);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });
  }
);

function countTemplates(organizationId: string): Promise<number> {
  return withDb((db) =>
    db.artifact.count({
      where: { organizationId, templateForType: DocumentType.Prd },
    })
  );
}
