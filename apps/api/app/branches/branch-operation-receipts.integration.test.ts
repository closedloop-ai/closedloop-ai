import { randomUUID } from "node:crypto";
import {
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import { Priority } from "@repo/api/src/types/common";
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
import { seedBranch as seedBranchRow } from "@/__tests__/utils/branch-identity-sql-fixture";

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
vi.mock(
  "@/app/documents/single-priority-side-effects",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    emitSinglePrioritySideEffects: vi.fn(),
  })
);

import {
  DELETE as deleteBranch,
  PATCH as patchBranch,
} from "@/app/branches/[id]/route";

const harness = createReceiptRouteHarness();
type World = Awaited<ReturnType<typeof harness.seedWorld>>;
const BRANCH_ROUTE = "/branches/[id]";

/**
 * ISS-12552: an API-key branch priority write or branch delete
 * records its receipt in the write's own transaction.
 */
describe.skipIf(!keys().DATABASE_URL)("ISS-12552 branch write receipts", () => {
  afterEach(() => harness.cleanup());

  it("PATCH rolls the priority back when its receipt cannot be stored", async () => {
    const world = await harness.seedWorld();
    const branchId = await seedBranch(world);
    failReceiptInserts();

    const response = await sendPriority(branchId, Priority.Urgent);

    expect(response.status).toBe(500);
    expect(forcedReceiptFailures()).toBe(1);
    expect(await readPriority(branchId)).toBeNull();
    expect(await countReceipts(world.organizationId)).toBe(0);
  });

  it("DELETE keeps the branch when its receipt cannot be stored", async () => {
    const world = await harness.seedWorld();
    const branchId = await seedBranch(world);
    failReceiptInserts();

    const response = await sendDelete(branchId);

    expect(response.status).toBe(500);
    expect(forcedReceiptFailures()).toBe(1);
    expect(await branchExists(branchId)).toBe(true);
    expect(await countReceipts(world.organizationId)).toBe(0);
  });

  it("records a priority update, a repeat as a no-op, and a delete naming the branch", async () => {
    const world = await harness.seedWorld();
    const branchId = await seedBranch(world);

    const statuses = [
      (await sendPriority(branchId, Priority.Urgent)).status,
      (await sendPriority(branchId, Priority.Urgent)).status,
      (await sendDelete(branchId)).status,
    ];

    expect(statuses).toEqual([200, 200, 200]);
    expect(await branchExists(branchId)).toBe(false);
    const receipt = {
      source: OperationSource.Api,
      targetArtifactId: branchId,
      createdArtifactId: null,
      route: BRANCH_ROUTE,
    };
    expect(await readReceipts(world.organizationId)).toEqual([
      {
        ...receipt,
        operationKind: OperationKind.UpdateFields,
        outcome: OperationReceiptOutcome.Committed,
        changedFields: ["priority"],
      },
      {
        ...receipt,
        operationKind: OperationKind.UpdateFields,
        outcome: OperationReceiptOutcome.NoOp,
        changedFields: [],
      },
      {
        ...receipt,
        operationKind: OperationKind.Delete,
        outcome: OperationReceiptOutcome.Committed,
        changedFields: [],
      },
    ]);
  });

  it("writes no receipt with attribution-evidence-policy off", async () => {
    const world = await harness.seedWorld();
    const branchId = await seedBranch(world);
    turnAttributionFlagOff();

    const statuses = [
      (await sendPriority(branchId, Priority.Low)).status,
      (await sendDelete(branchId)).status,
    ];

    expect(statuses).toEqual([200, 200]);
    expect(await branchExists(branchId)).toBe(false);
    expect(await countReceipts(world.organizationId)).toBe(0);
  });
});

function sendPriority(branchId: string, priority: Priority) {
  return patchBranch(
    apiKeyRouteRequest("PATCH", `/branches/${branchId}`, { priority }),
    receiptRouteParams({ id: branchId })
  );
}

function sendDelete(branchId: string) {
  return deleteBranch(
    apiKeyRouteRequest("DELETE", `/branches/${branchId}`),
    receiptRouteParams({ id: branchId })
  );
}

function seedBranch(world: World): Promise<string> {
  return seedBranchRow(
    world.organizationId,
    `receipt-${randomUUID().slice(0, 8)}`,
    { firstPushedAt: null }
  );
}

async function readPriority(branchId: string) {
  const row = await withDb((db) =>
    db.artifact.findUniqueOrThrow({
      where: { id: branchId },
      select: { priority: true },
    })
  );
  return row.priority;
}

async function branchExists(branchId: string): Promise<boolean> {
  const count = await withDb((db) =>
    db.artifact.count({ where: { id: branchId } })
  );
  return count > 0;
}
