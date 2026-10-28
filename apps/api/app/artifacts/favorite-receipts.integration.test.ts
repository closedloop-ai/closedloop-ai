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

import {
  POST as favorite,
  DELETE as unfavorite,
} from "@/app/artifacts/[id]/favorite/route";

const harness = createReceiptRouteHarness();
const FAVORITE_ROUTE = "/artifacts/[id]/favorite";

/**
 * ISS-12552: an API-key favorite records a receipt in the
 * favorite's own transaction.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 artifact favorite receipts",
  () => {
    afterEach(() => harness.cleanup());

    it("POST rolls the favorite back when its receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      const artifactId = await harness.seedDocument(world, "Favorite");
      failReceiptInserts();

      const response = await favorite(
        apiKeyRouteRequest("POST", `/artifacts/${artifactId}/favorite`),
        receiptRouteParams({ id: artifactId })
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await countFavorites(world.userId)).toBe(0);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("DELETE keeps the favorite when its receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      const artifactId = await harness.seedDocument(world, "Favorite");
      await seedFavorite(world.userId, artifactId);
      failReceiptInserts();

      const response = await unfavorite(
        apiKeyRouteRequest("DELETE", `/artifacts/${artifactId}/favorite`),
        receiptRouteParams({ id: artifactId })
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await countFavorites(world.userId)).toBe(1);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("records a settings write naming the artifact, and a repeat as a no-op", async () => {
      const world = await harness.seedWorld();
      const artifactId = await harness.seedDocument(world, "Favorite");
      const post = () =>
        favorite(
          apiKeyRouteRequest("POST", `/artifacts/${artifactId}/favorite`),
          receiptRouteParams({ id: artifactId })
        );

      const statuses = [(await post()).status, (await post()).status];

      expect(statuses).toEqual([200, 200]);
      expect(await readReceipts(world.organizationId)).toEqual(
        [OperationReceiptOutcome.Committed, OperationReceiptOutcome.NoOp].map(
          (outcome) => ({
            operationKind: OperationKind.SettingsWrite,
            outcome,
            source: OperationSource.Api,
            targetArtifactId: artifactId,
            createdArtifactId: null,
            changedFields: [],
            route: FAVORITE_ROUTE,
          })
        )
      );
    });

    it("writes no receipt with attribution-evidence-policy off", async () => {
      const world = await harness.seedWorld();
      const artifactId = await harness.seedDocument(world, "Favorite");
      turnAttributionFlagOff();

      const response = await favorite(
        apiKeyRouteRequest("POST", `/artifacts/${artifactId}/favorite`),
        receiptRouteParams({ id: artifactId })
      );

      expect(response.status).toBe(200);
      expect(await countFavorites(world.userId)).toBe(1);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });
  }
);

function countFavorites(userId: string): Promise<number> {
  return withDb((db) => db.favoriteArtifact.count({ where: { userId } }));
}

async function seedFavorite(userId: string, artifactId: string) {
  await withDb((db) =>
    db.favoriteArtifact.create({
      data: { userId, artifactId },
      select: { id: true },
    })
  );
}
