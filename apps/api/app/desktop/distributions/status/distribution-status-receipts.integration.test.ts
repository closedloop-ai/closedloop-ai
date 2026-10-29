import { randomUUID } from "node:crypto";
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import {
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import {
  CatalogItemScope,
  CatalogItemSource,
  DistributionMode,
  DistributionTargetingType,
  DistributionTargetStatusValue,
} from "@repo/api/src/types/distribution";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type DesktopReceiptWorld,
  seedOwnedComputeTarget,
} from "@/__tests__/support/desktop/desktop-sync-receipt.test-helpers";
import {
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

import { POST as reportStatus } from "@/app/desktop/distributions/status/route";

const harness = createReceiptRouteHarness();
const STATUS_ROUTE = "/desktop/distributions/status";

/**
 * ISS-12552: an API-key distribution status report records one
 * Desktop sync receipt in the transaction that upserts its reports.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 distribution status receipts",
  () => {
    afterEach(() => harness.cleanup());

    it("rolls the reports back when the receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      const computeTargetId = await seedOwnedComputeTarget(world);
      const distributionId = await seedDistribution(world);
      failReceiptInserts();

      const response = await reportStatus(
        statusRequest(computeTargetId, [distributionId]),
        receiptRouteParams({})
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await countStatuses(computeTargetId)).toBe(0);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("records one committed receipt for a batch of reports", async () => {
      const world = await harness.seedWorld();
      const computeTargetId = await seedOwnedComputeTarget(world);
      const first = await seedDistribution(world);
      const second = await seedDistribution(world);

      const response = await reportStatus(
        statusRequest(computeTargetId, [first, second]),
        receiptRouteParams({})
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.data).toMatchObject({
        accepted: 2,
        operationReceipt: { outcome: OperationReceiptOutcome.Committed },
      });
      expect(await countStatuses(computeTargetId)).toBe(2);
      expect(await readReceipts(world.organizationId)).toEqual([
        statusReceipt(OperationReceiptOutcome.Committed),
      ]);
    });

    it("records a no-op when every report names a foreign distribution", async () => {
      const world = await harness.seedWorld();
      const computeTargetId = await seedOwnedComputeTarget(world);

      const response = await reportStatus(
        statusRequest(computeTargetId, [randomUUID()]),
        receiptRouteParams({})
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.data).toMatchObject({
        accepted: 0,
        operationReceipt: { outcome: OperationReceiptOutcome.NoOp },
      });
      expect(await readReceipts(world.organizationId)).toEqual([
        statusReceipt(OperationReceiptOutcome.NoOp),
      ]);
    });

    it("writes no receipt with attribution-evidence-policy off", async () => {
      const world = await harness.seedWorld();
      const computeTargetId = await seedOwnedComputeTarget(world);
      const distributionId = await seedDistribution(world);
      turnAttributionFlagOff();

      const response = await reportStatus(
        statusRequest(computeTargetId, [distributionId]),
        receiptRouteParams({})
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.data).toEqual({ accepted: 1 });
      expect(await countStatuses(computeTargetId)).toBe(1);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });
  }
);

function statusReceipt(outcome: OperationReceiptOutcome) {
  return {
    operationKind: OperationKind.DesktopSync,
    outcome,
    source: OperationSource.Api,
    targetArtifactId: null,
    createdArtifactId: null,
    changedFields: [],
    route: STATUS_ROUTE,
  };
}

function statusRequest(
  computeTargetId: string,
  distributionIds: string[]
): NextRequest {
  return new NextRequest(`http://localhost:3002${STATUS_ROUTE}`, {
    method: "POST",
    body: JSON.stringify({
      computeTargetId,
      reports: distributionIds.map((distributionId) => ({
        distributionId,
        status: DistributionTargetStatusValue.Installed,
        installedVersion: "1.0.0",
      })),
    }),
    headers: { "Content-Type": "application/json" },
  });
}

async function seedDistribution(world: DesktopReceiptWorld): Promise<string> {
  return await withDb(async (db) => {
    const catalogItem = await db.catalogItem.create({
      data: {
        organizationId: world.organizationId,
        targetKind: AgentComponentKind.Plugin,
        source: CatalogItemSource.OrgCustom,
        scope: CatalogItemScope.Org,
        name: `iss12552-pack-${randomUUID()}`,
      },
      select: { id: true },
    });
    const distribution = await db.distribution.create({
      data: {
        organizationId: world.organizationId,
        catalogItemId: catalogItem.id,
        mode: DistributionMode.OptIn,
        targetingType: DistributionTargetingType.All,
      },
      select: { id: true },
    });
    return distribution.id;
  });
}

function countStatuses(computeTargetId: string): Promise<number> {
  return withDb((db) =>
    db.distributionTargetStatus.count({ where: { computeTargetId } })
  );
}
