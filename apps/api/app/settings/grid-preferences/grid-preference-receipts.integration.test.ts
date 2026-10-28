import {
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import {
  GridPreferenceGridKey,
  GridPreferenceKind,
  GridPreferenceScopeKey,
} from "@repo/api/src/types/grid-preferences";
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

import {
  DELETE as resetPreference,
  POST as upsertPreference,
} from "@/app/settings/grid-preferences/route";

const harness = createReceiptRouteHarness();
const GRID_PREFERENCES_ROUTE = "/settings/grid-preferences";
const NO_PARAMS = receiptRouteParams({});
const SELECTOR = {
  gridKey: GridPreferenceGridKey.Sessions,
  preferenceKind: GridPreferenceKind.ViewState,
  scopeKey: GridPreferenceScopeKey.Default,
};
const RESET_PATH = `${GRID_PREFERENCES_ROUTE}?${new URLSearchParams(SELECTOR)}`;

/**
 * ISS-12552: an API-key grid preference write records a
 * settings receipt in the write's own transaction.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 grid preference receipts",
  () => {
    afterEach(() => harness.cleanup());

    it("POST stores no preference when its receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      failReceiptInserts();

      const response = await upsert();

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await readStoredPreference(world.userId)).toBeNull();
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("DELETE keeps the preference when its receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      await seedPreference(world);
      failReceiptInserts();

      const response = await resetPreference(
        apiKeyRouteRequest("DELETE", RESET_PATH),
        NO_PARAMS
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await readStoredPreference(world.userId)).toEqual({
        deletedAt: null,
        revision: 1,
      });
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("records a stored preference, its reset, and a repeat reset as a no-op", async () => {
      const world = await harness.seedWorld();
      const reset = () =>
        resetPreference(apiKeyRouteRequest("DELETE", RESET_PATH), NO_PARAMS);

      const statuses = [
        (await upsert()).status,
        (await reset()).status,
        (await reset()).status,
      ];

      expect(statuses).toEqual([200, 200, 200]);
      expect(await readReceipts(world.organizationId)).toEqual(
        [
          OperationReceiptOutcome.Committed,
          OperationReceiptOutcome.Committed,
          OperationReceiptOutcome.NoOp,
        ].map((outcome) => ({
          operationKind: OperationKind.SettingsWrite,
          outcome,
          source: OperationSource.Api,
          targetArtifactId: null,
          createdArtifactId: null,
          changedFields: [],
          route: GRID_PREFERENCES_ROUTE,
        }))
      );
    });

    it("writes no receipt with attribution-evidence-policy off", async () => {
      const world = await harness.seedWorld();
      turnAttributionFlagOff();

      const response = await upsert();

      expect(response.status).toBe(200);
      expect(await readStoredPreference(world.userId)).toEqual({
        deletedAt: null,
        revision: 1,
      });
      expect(await countReceipts(world.organizationId)).toBe(0);
    });
  }
);

/**
 * ISS-12552: flag-off behavior equals main for grid preference writes. With
 * `attribution-evidence-policy` off, or for a session caller, the statement
 * and any conflict read run outside a transaction.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 grid preference writes match main with attribution evidence off",
  () => {
    afterEach(async () => {
      vi.restoreAllMocks();
      await harness.cleanup();
    });

    it("POST stores the preference outside any transaction, for an API-key caller", async () => {
      const world = await harness.seedWorld();
      turnAttributionFlagOff();
      const transactions = countTransactions();

      const response = await upsert();

      expect(response.status).toBe(200);
      expect((await response.json()).data).not.toHaveProperty(
        "operationReceipt"
      );
      expect(transactions.opened).toBe(0);
      expect(await readStoredPreference(world.userId)).toEqual({
        deletedAt: null,
        revision: 1,
      });
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("POST stores the preference outside any transaction, for a session caller", async () => {
      const world = await harness.seedWorld();
      useSessionCaller();
      const transactions = countTransactions();

      const response = await upsert();

      expect(response.status).toBe(200);
      expect(transactions.opened).toBe(0);
      expect(await readStoredPreference(world.userId)).toEqual({
        deletedAt: null,
        revision: 1,
      });
    });

    it("DELETE resets the preference outside any transaction", async () => {
      const world = await harness.seedWorld();
      await seedPreference(world);
      turnAttributionFlagOff();
      const transactions = countTransactions();

      const response = await resetPreference(
        apiKeyRouteRequest("DELETE", RESET_PATH),
        NO_PARAMS
      );

      expect(response.status).toBe(200);
      expect(transactions.opened).toBe(0);
      expect(
        (await readStoredPreference(world.userId))?.deletedAt
      ).not.toBeNull();
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("a stale DELETE answers 409 with the stored row, read outside any transaction", async () => {
      const world = await harness.seedWorld();
      await seedPreference(world);
      turnAttributionFlagOff();
      const transactions = countTransactions();

      const response = await resetPreference(
        apiKeyRouteRequest(
          "DELETE",
          `${RESET_PATH}&${new URLSearchParams({ expectedRevision: "7" })}`
        ),
        NO_PARAMS
      );

      expect(response.status).toBe(409);
      expect(transactions.opened).toBe(0);
      expect(await readStoredPreference(world.userId)).toEqual({
        deletedAt: null,
        revision: 1,
      });
    });
  }
);

function upsert() {
  return upsertPreference(
    apiKeyRouteRequest("POST", GRID_PREFERENCES_ROUTE, {
      ...SELECTOR,
      value: { columns: ["name"] },
    }),
    NO_PARAMS
  );
}

function readStoredPreference(userId: string) {
  return withDb((db) =>
    db.gridPreference.findFirst({
      where: { userId, ...SELECTOR },
      select: { deletedAt: true, revision: true },
    })
  );
}

async function seedPreference(world: {
  organizationId: string;
  userId: string;
}): Promise<void> {
  await withDb((db) =>
    db.gridPreference.create({
      data: {
        organizationId: world.organizationId,
        userId: world.userId,
        ...SELECTOR,
        value: { columns: ["name"] },
      },
      select: { id: true },
    })
  );
}
