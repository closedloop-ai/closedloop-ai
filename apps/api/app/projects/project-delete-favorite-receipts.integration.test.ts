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
  POST as favoriteProject,
  DELETE as unfavoriteProject,
} from "@/app/projects/[id]/favorite/route";
import { DELETE as deleteProject } from "@/app/projects/[id]/route";

const harness = createReceiptRouteHarness();

/**
 * ISS-12552: an API-key project delete or project favorite
 * records its receipt in the write's own transaction.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 project delete and favorite receipts",
  () => {
    afterEach(() => harness.cleanup());

    it("DELETE /projects/[id] keeps the project when its receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      failReceiptInserts();

      const response = await sendDelete(world.projectId);

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await projectExists(world.projectId)).toBe(true);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("POST /projects/[id]/favorite rolls the favorite back when its receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      failReceiptInserts();

      const response = await sendFavorite(world.projectId);

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await countFavorites(world.userId)).toBe(0);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("DELETE /projects/[id]/favorite keeps the favorite when its receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      await sendFavorite(world.projectId);
      await withDb((db) =>
        db.artifactOperationReceipt.deleteMany({
          where: { organizationId: world.organizationId },
        })
      );
      failReceiptInserts();

      const response = await sendUnfavorite(world.projectId);

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await countFavorites(world.userId)).toBe(1);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("records favorite settings writes, a repeat as a no-op, and the delete as a project write", async () => {
      const world = await harness.seedWorld();

      const statuses = [
        (await sendFavorite(world.projectId)).status,
        (await sendFavorite(world.projectId)).status,
        (await sendUnfavorite(world.projectId)).status,
        (await sendDelete(world.projectId)).status,
      ];

      expect(statuses).toEqual([200, 200, 200, 200]);
      expect(await projectExists(world.projectId)).toBe(false);
      const receipt = {
        source: OperationSource.Api,
        targetArtifactId: null,
        createdArtifactId: null,
        changedFields: [],
      };
      const favoriteRoute = "/projects/[id]/favorite";
      expect(await readReceipts(world.organizationId)).toEqual([
        {
          ...receipt,
          operationKind: OperationKind.SettingsWrite,
          outcome: OperationReceiptOutcome.Committed,
          route: favoriteRoute,
        },
        {
          ...receipt,
          operationKind: OperationKind.SettingsWrite,
          outcome: OperationReceiptOutcome.NoOp,
          route: favoriteRoute,
        },
        {
          ...receipt,
          operationKind: OperationKind.SettingsWrite,
          outcome: OperationReceiptOutcome.Committed,
          route: favoriteRoute,
        },
        {
          ...receipt,
          operationKind: OperationKind.ProjectWrite,
          outcome: OperationReceiptOutcome.Committed,
          route: "/projects/[id]",
        },
      ]);
    });

    it("answers a repeat favorite and unfavorite with the same success and state as the first", async () => {
      const world = await harness.seedWorld();
      turnAttributionFlagOff();

      const added = [
        await sendFavorite(world.projectId),
        await sendFavorite(world.projectId),
      ];
      const addedBodies = await Promise.all(added.map((r) => r.json()));
      const favoritesAfterAdd = await countFavorites(world.userId);
      const removed = [
        await sendUnfavorite(world.projectId),
        await sendUnfavorite(world.projectId),
      ];
      const removedBodies = await Promise.all(removed.map((r) => r.json()));

      expect(added.map((r) => r.status)).toEqual([200, 200]);
      expect(addedBodies).toEqual([
        { success: true, data: { favorited: true } },
        { success: true, data: { favorited: true } },
      ]);
      expect(favoritesAfterAdd).toBe(1);
      expect(removed.map((r) => r.status)).toEqual([200, 200]);
      expect(removedBodies).toEqual([
        { success: true, data: { favorited: false } },
        { success: true, data: { favorited: false } },
      ]);
      expect(await countFavorites(world.userId)).toBe(0);
    });

    it("writes no receipt with attribution-evidence-policy off", async () => {
      const world = await harness.seedWorld();
      turnAttributionFlagOff();

      const statuses = [
        (await sendFavorite(world.projectId)).status,
        (await sendDelete(world.projectId)).status,
      ];

      expect(statuses).toEqual([200, 200]);
      expect(await projectExists(world.projectId)).toBe(false);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });
  }
);

function sendDelete(projectId: string) {
  return deleteProject(
    apiKeyRouteRequest("DELETE", `/projects/${projectId}`),
    receiptRouteParams({ id: projectId })
  );
}

function sendFavorite(projectId: string) {
  return favoriteProject(
    apiKeyRouteRequest("POST", `/projects/${projectId}/favorite`),
    receiptRouteParams({ id: projectId })
  );
}

function sendUnfavorite(projectId: string) {
  return unfavoriteProject(
    apiKeyRouteRequest("DELETE", `/projects/${projectId}/favorite`),
    receiptRouteParams({ id: projectId })
  );
}

async function projectExists(projectId: string): Promise<boolean> {
  const count = await withDb((db) =>
    db.project.count({ where: { id: projectId } })
  );
  return count > 0;
}

function countFavorites(userId: string): Promise<number> {
  return withDb((db) => db.favoriteProject.count({ where: { userId } }));
}
