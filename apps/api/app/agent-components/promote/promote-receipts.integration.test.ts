import { randomUUID } from "node:crypto";
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

import { POST as promote } from "@/app/agent-components/promote/route";

const harness = createReceiptRouteHarness();
const ROUTE = "/agent-components/promote";

/**
 * ISS-12552: an API-key promotion records an organization
 * write receipt in the transaction that creates the catalog item and its
 * distribution.
 */
describe.skipIf(!keys().DATABASE_URL)("ISS-12552 promote receipts", () => {
  afterEach(() => harness.cleanup());

  it("POST /agent-components/promote creates nothing when its receipt cannot be stored", async () => {
    const world = await harness.seedWorld();
    const agentComponentId = await seedAgentComponent(world);
    failReceiptInserts();

    const response = await promote(
      apiKeyRouteRequest("POST", ROUTE, { agentComponentId }),
      receiptRouteParams({})
    );

    expect(response.status).toBe(500);
    expect(forcedReceiptFailures()).toBe(1);
    expect(await countCatalogItems(world.organizationId)).toBe(0);
    expect(await countReceipts(world.organizationId)).toBe(0);
  });

  it("POST /agent-components/promote records a repeated promotion as a no-op", async () => {
    const world = await harness.seedWorld();
    const agentComponentId = await seedAgentComponent(world);
    const send = () =>
      promote(
        apiKeyRouteRequest("POST", ROUTE, { agentComponentId }),
        receiptRouteParams({})
      );

    const statuses = [(await send()).status, (await send()).status];

    expect(statuses).toEqual([200, 200]);
    expect(await countCatalogItems(world.organizationId)).toBe(1);
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

  it("POST /agent-components/promote writes no receipt with attribution-evidence-policy off", async () => {
    const world = await harness.seedWorld();
    const agentComponentId = await seedAgentComponent(world);
    turnAttributionFlagOff();

    const response = await promote(
      apiKeyRouteRequest("POST", ROUTE, { agentComponentId }),
      receiptRouteParams({})
    );

    expect(response.status).toBe(200);
    expect(await countCatalogItems(world.organizationId)).toBe(1);
    expect(await countReceipts(world.organizationId)).toBe(0);
  });
});

function countCatalogItems(organizationId: string): Promise<number> {
  return withDb((db) => db.catalogItem.count({ where: { organizationId } }));
}

async function seedAgentComponent(world: {
  organizationId: string;
  userId: string;
}): Promise<string> {
  return await withDb(async (db) => {
    const target = await db.computeTarget.create({
      data: {
        organizationId: world.organizationId,
        userId: world.userId,
        machineName: "promote-receipt-machine",
        platform: "darwin",
      },
      select: { id: true },
    });
    const component = await db.agentComponent.create({
      data: {
        organizationId: world.organizationId,
        computeTargetId: target.id,
        componentKind: "skill",
        externalComponentId: randomUUID(),
        name: "Receipt skill",
      },
      select: { id: true },
    });
    return component.id;
  });
}
