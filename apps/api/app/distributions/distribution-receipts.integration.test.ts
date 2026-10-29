import {
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import {
  DistributionMode,
  DistributionTargetingType,
} from "@repo/api/src/types/distribution";
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
import { useSessionCaller } from "@/__tests__/support/lib/session-caller.test-helpers";
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
vi.mock(
  "@/lib/operation-receipts/operation-receipt-writer",
  async (importOriginal) =>
    (
      await import("@/__tests__/support/lib/operation-receipt-route.test-mocks")
    ).failingReceiptWriterMock(await importOriginal())
);
vi.mock("@/lib/auth/org-admin", () => ({
  requireOrgAdmin: async () => null,
  getOrgAdminStatus: async () => ({ isAdmin: true, reason: "admin" }),
}));

import {
  PATCH as updateDistribution,
  DELETE as withdrawDistribution,
} from "@/app/distributions/[id]/route";
import { POST as createDistribution } from "@/app/distributions/route";

const harness = createReceiptRouteHarness();

/**
 * ISS-12552: an API-key distribution write records an
 * organization write receipt in the write's own transaction.
 */
describe.skipIf(!keys().DATABASE_URL)("ISS-12552 distribution receipts", () => {
  afterEach(() => harness.cleanup());

  it("POST /distributions creates nothing when its receipt cannot be stored", async () => {
    const world = await harness.seedWorld();
    const catalogItemId = await seedCatalogItem(world);
    failReceiptInserts();

    const response = await createDistribution(
      createRequest(catalogItemId),
      receiptRouteParams({})
    );

    expect(response.status).toBe(500);
    expect(forcedReceiptFailures()).toBe(1);
    expect(await countDistributions(world.organizationId)).toBe(0);
    expect(await countReceipts(world.organizationId)).toBe(0);
  });

  it("POST /distributions records an organization write naming the route", async () => {
    const world = await harness.seedWorld();
    const catalogItemId = await seedCatalogItem(world);

    const response = await createDistribution(
      createRequest(catalogItemId),
      receiptRouteParams({})
    );

    expect(response.status).toBe(200);
    expect(await readReceipts(world.organizationId)).toEqual([
      organizationWrite(OperationReceiptOutcome.Committed, "/distributions"),
    ]);
  });

  it("POST /distributions writes no receipt with attribution-evidence-policy off", async () => {
    const world = await harness.seedWorld();
    const catalogItemId = await seedCatalogItem(world);
    turnAttributionFlagOff();

    const response = await createDistribution(
      createRequest(catalogItemId),
      receiptRouteParams({})
    );

    expect(response.status).toBe(200);
    expect(await countDistributions(world.organizationId)).toBe(1);
    expect(await countReceipts(world.organizationId)).toBe(0);
  });

  it("PATCH /distributions/[id] keeps the old mode when its receipt cannot be stored", async () => {
    const world = await harness.seedWorld();
    const distributionId = await seedDistribution(world);
    failReceiptInserts();

    const response = await updateDistribution(
      apiKeyRouteRequest("PATCH", `/distributions/${distributionId}`, {
        mode: DistributionMode.OptIn,
      }),
      receiptRouteParams({ id: distributionId })
    );

    expect(response.status).toBe(500);
    expect(forcedReceiptFailures()).toBe(1);
    expect((await readDistribution(distributionId))?.mode).toBe(
      DistributionMode.AutoInstall
    );
    expect(await countReceipts(world.organizationId)).toBe(0);
  });

  it("PATCH /distributions/[id] keeps the old targeting when its receipt cannot be stored", async () => {
    const world = await harness.seedWorld();
    const distributionId = await seedDistribution(world);
    failReceiptInserts();

    const response = await updateDistribution(
      apiKeyRouteRequest("PATCH", `/distributions/${distributionId}`, {
        targetingType: DistributionTargetingType.Specific,
        targetUserIds: [world.userId],
      }),
      receiptRouteParams({ id: distributionId })
    );

    expect(response.status).toBe(500);
    expect(forcedReceiptFailures()).toBe(1);
    expect((await readDistribution(distributionId))?.targetingType).toBe(
      DistributionTargetingType.All
    );
    expect(await countReceipts(world.organizationId)).toBe(0);
  });

  it("DELETE /distributions/[id] keeps the distribution live when its receipt cannot be stored", async () => {
    const world = await harness.seedWorld();
    const distributionId = await seedDistribution(world);
    failReceiptInserts();

    const response = await withdrawDistribution(
      apiKeyRouteRequest("DELETE", `/distributions/${distributionId}`),
      receiptRouteParams({ id: distributionId })
    );

    expect(response.status).toBe(500);
    expect(forcedReceiptFailures()).toBe(1);
    expect((await readDistribution(distributionId))?.withdrawnAt).toBeNull();
    expect(await countReceipts(world.organizationId)).toBe(0);
  });

  it("DELETE /distributions/[id] records a repeated withdrawal as a no-op", async () => {
    const world = await harness.seedWorld();
    const distributionId = await seedDistribution(world);
    const withdraw = () =>
      withdrawDistribution(
        apiKeyRouteRequest("DELETE", `/distributions/${distributionId}`),
        receiptRouteParams({ id: distributionId })
      );

    const statuses = [(await withdraw()).status, (await withdraw()).status];

    expect(statuses).toEqual([200, 200]);
    expect(await readReceipts(world.organizationId)).toEqual(
      [OperationReceiptOutcome.Committed, OperationReceiptOutcome.NoOp].map(
        (outcome) => organizationWrite(outcome, "/distributions/[id]")
      )
    );
  });
});

/**
 * ISS-12552: flag-off behavior equals main for distribution writes. With
 * `attribution-evidence-policy` off, or for a session caller, a create, scalar
 * update and withdrawal run their single statement as main does, with no
 * transaction.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 distribution writes match main with attribution evidence off",
  () => {
    afterEach(async () => {
      vi.restoreAllMocks();
      await harness.cleanup();
    });

    it("POST /distributions creates outside any transaction, for an API-key caller", async () => {
      const world = await harness.seedWorld();
      const catalogItemId = await seedCatalogItem(world);
      turnAttributionFlagOff();
      const transactions = countTransactions();

      const response = await createDistribution(
        createRequest(catalogItemId),
        receiptRouteParams({})
      );

      expect(response.status).toBe(200);
      expect((await response.json()).data).not.toHaveProperty(
        "operationReceipt"
      );
      expect(transactions.opened).toBe(0);
      expect(await countDistributions(world.organizationId)).toBe(1);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("POST /distributions creates outside any transaction, for a session caller", async () => {
      const world = await harness.seedWorld();
      const catalogItemId = await seedCatalogItem(world);
      useSessionCaller();
      const transactions = countTransactions();

      const response = await createDistribution(
        createRequest(catalogItemId),
        receiptRouteParams({})
      );

      expect(response.status).toBe(200);
      expect(transactions.opened).toBe(0);
      expect(await countDistributions(world.organizationId)).toBe(1);
    });

    it("PATCH /distributions/[id] updates the mode outside any transaction", async () => {
      const world = await harness.seedWorld();
      const distributionId = await seedDistribution(world);
      turnAttributionFlagOff();
      const transactions = countTransactions();

      const response = await updateDistribution(
        apiKeyRouteRequest("PATCH", `/distributions/${distributionId}`, {
          mode: DistributionMode.OptIn,
        }),
        receiptRouteParams({ id: distributionId })
      );

      expect(response.status).toBe(200);
      expect(transactions.opened).toBe(0);
      expect((await readDistribution(distributionId))?.mode).toBe(
        DistributionMode.OptIn
      );
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("DELETE /distributions/[id] withdraws outside any transaction", async () => {
      const world = await harness.seedWorld();
      const distributionId = await seedDistribution(world);
      turnAttributionFlagOff();
      const transactions = countTransactions();

      const response = await withdrawDistribution(
        apiKeyRouteRequest("DELETE", `/distributions/${distributionId}`),
        receiptRouteParams({ id: distributionId })
      );

      expect(response.status).toBe(200);
      expect(transactions.opened).toBe(0);
      expect(
        (await readDistribution(distributionId))?.withdrawnAt
      ).not.toBeNull();
      expect(await countReceipts(world.organizationId)).toBe(0);
    });
  }
);

function organizationWrite(outcome: string, route: string) {
  return {
    operationKind: OperationKind.OrganizationWrite,
    outcome,
    source: OperationSource.Api,
    targetArtifactId: null,
    createdArtifactId: null,
    changedFields: [],
    route,
  };
}

function createRequest(catalogItemId: string) {
  return apiKeyRouteRequest("POST", "/distributions", {
    catalogItemId,
    mode: DistributionMode.AutoInstall,
    targetingType: DistributionTargetingType.All,
  });
}

function countDistributions(organizationId: string): Promise<number> {
  return withDb((db) => db.distribution.count({ where: { organizationId } }));
}

function readDistribution(id: string) {
  return withDb((db) =>
    db.distribution.findUnique({
      where: { id },
      select: { mode: true, targetingType: true, withdrawnAt: true },
    })
  );
}

async function seedCatalogItem(world: {
  organizationId: string;
  userId: string;
}): Promise<string> {
  const row = await withDb((db) =>
    db.catalogItem.create({
      data: {
        organizationId: world.organizationId,
        targetKind: "skill",
        source: "org_custom",
        scope: "org",
        name: "Receipt pack",
        createdById: world.userId,
      },
      select: { id: true },
    })
  );
  return row.id;
}

async function seedDistribution(world: {
  organizationId: string;
  userId: string;
}): Promise<string> {
  const catalogItemId = await seedCatalogItem(world);
  const row = await withDb((db) =>
    db.distribution.create({
      data: {
        organizationId: world.organizationId,
        catalogItemId,
        mode: DistributionMode.AutoInstall,
        targetingType: DistributionTargetingType.All,
        createdById: world.userId,
      },
      select: { id: true },
    })
  );
  return row.id;
}
