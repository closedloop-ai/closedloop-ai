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

import { POST as batchFavoritesV2 } from "@/app/artifacts/favorites/batch/v2/route";

const harness = createReceiptRouteHarness();
const ROUTE = "/artifacts/favorites/batch/v2";

/**
 * ISS-12552: an API-key batch favorite change records one
 * SettingsWrite receipt per artifact it found, in the batch's own
 * transaction. An artifact already in the requested state is a no-op.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 artifact batch favorite receipts",
  () => {
    afterEach(() => harness.cleanup());

    it("leaves every favorite unchanged when a receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      const ids = [
        await harness.seedDocument(world, "Kept A"),
        await harness.seedDocument(world, "Kept B"),
      ];
      failReceiptInserts();

      const response = await batchFavoritesV2(
        apiKeyRouteRequest("POST", ROUTE, { artifactIds: ids, favorite: true }),
        receiptRouteParams({})
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await favoritedIds(world.userId)).toEqual([]);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it.each([
      { favorite: true, movedStartsFavorited: false },
      { favorite: false, movedStartsFavorited: true },
    ])(
      "records the artifact whose favorite moved and a no-op for one already in that state (favorite: $favorite)",
      async ({ favorite, movedStartsFavorited }) => {
        const world = await harness.seedWorld();
        const moved = await harness.seedDocument(world, "Moved");
        const unchanged = await harness.seedDocument(world, "Unchanged");
        const startFavorited = movedStartsFavorited ? moved : unchanged;
        await addFavorite(world.userId, startFavorited);

        const response = await batchFavoritesV2(
          apiKeyRouteRequest("POST", ROUTE, {
            artifactIds: [moved, unchanged, crypto.randomUUID()],
            favorite,
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
            favoriteReceipt(moved, OperationReceiptOutcome.Committed),
            favoriteReceipt(unchanged, OperationReceiptOutcome.NoOp),
          ])
        );
      }
    );

    it("writes no receipt with attribution-evidence-policy off", async () => {
      const world = await harness.seedWorld();
      const artifactId = await harness.seedDocument(world, "Favorited");
      turnAttributionFlagOff();

      const response = await batchFavoritesV2(
        apiKeyRouteRequest("POST", ROUTE, {
          artifactIds: [artifactId],
          favorite: true,
        }),
        receiptRouteParams({})
      );

      expect(response.status).toBe(200);
      expect(await favoritedIds(world.userId)).toEqual([artifactId]);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });
  }
);

function favoriteReceipt(artifactId: string, outcome: OperationReceiptOutcome) {
  return {
    operationKind: OperationKind.SettingsWrite,
    outcome,
    source: OperationSource.Api,
    targetArtifactId: artifactId,
    createdArtifactId: null,
    changedFields: [],
    route: ROUTE,
  };
}

async function favoritedIds(userId: string): Promise<string[]> {
  const rows = await withDb((db) =>
    db.favoriteArtifact.findMany({
      where: { userId },
      orderBy: { artifactId: "asc" },
      select: { artifactId: true },
    })
  );
  return rows.map((row) => row.artifactId);
}

async function addFavorite(userId: string, artifactId: string) {
  await withDb((db) =>
    db.favoriteArtifact.create({
      data: { userId, artifactId },
      select: { artifactId: true },
    })
  );
}
