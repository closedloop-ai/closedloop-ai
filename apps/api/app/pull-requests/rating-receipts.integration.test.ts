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

import { PUT as rate } from "@/app/pull-requests/[id]/rating/route";

const harness = createReceiptRouteHarness();
type World = Awaited<ReturnType<typeof harness.seedWorld>>;

/**
 * ISS-12552: an API-key rating records its receipt in the
 * rating's own transaction.
 */
describe.skipIf(!keys().DATABASE_URL)("ISS-12552 rating receipts", () => {
  afterEach(() => harness.cleanup());

  it("PUT rolls the rating back when its receipt cannot be stored", async () => {
    const world = await harness.seedWorld();
    const branchId = await seedBranch(world);
    failReceiptInserts();

    const response = await sendRating(branchId, 4, "Solid");

    expect(response.status).toBe(500);
    expect(forcedReceiptFailures()).toBe(1);
    expect(await countRatings(branchId)).toBe(0);
    expect(await countReceipts(world.organizationId)).toBe(0);
  });

  it("records a rating, a resubmitted one as a no-op, and a changed score as committed", async () => {
    const world = await harness.seedWorld();
    const branchId = await seedBranch(world);

    const statuses = [
      (await sendRating(branchId, 4, "Solid")).status,
      (await sendRating(branchId, 4, "Solid")).status,
      (await sendRating(branchId, 5, "Solid")).status,
    ];

    expect(statuses).toEqual([200, 200, 200]);
    expect(await readReceipts(world.organizationId)).toEqual(
      [
        OperationReceiptOutcome.Committed,
        OperationReceiptOutcome.NoOp,
        OperationReceiptOutcome.Committed,
      ].map((outcome) => ({
        operationKind: OperationKind.Rate,
        outcome,
        source: OperationSource.Api,
        targetArtifactId: branchId,
        createdArtifactId: null,
        changedFields: [],
        route: "/pull-requests/[id]/rating",
      }))
    );
  });

  it("writes no receipt with attribution-evidence-policy off", async () => {
    const world = await harness.seedWorld();
    const branchId = await seedBranch(world);
    turnAttributionFlagOff();

    const response = await sendRating(branchId, 3, "Fine");

    expect(response.status).toBe(200);
    expect(await countRatings(branchId)).toBe(1);
    expect(await countReceipts(world.organizationId)).toBe(0);
  });
});

function sendRating(branchId: string, score: number, comment: string) {
  return rate(
    apiKeyRouteRequest("PUT", `/pull-requests/${branchId}/rating`, {
      score,
      comment,
    }),
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

function countRatings(artifactId: string): Promise<number> {
  return withDb((db) => db.artifactRating.count({ where: { artifactId } }));
}
