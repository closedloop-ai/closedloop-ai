import {
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import { DesktopProvisioningPlatform } from "@repo/api/src/types/electron";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { countTransactions } from "@/__tests__/support/lib/transaction-count.test-helpers";
import {
  stubTrustedOriginEnv,
  TRUSTED_APP_ORIGIN,
} from "@/__tests__/utils/trusted-origin.test-helpers";

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
vi.mock("@/lib/desktop-managed-pop-provisioning", () => ({
  isDesktopManagedPopPlatformSupported: () => true,
  isDesktopManagedPopProvisioningEnabled: async () => true,
}));

import { POST as createProvisioningAttempt } from "@/app/desktop/provisioning-attempt/route";

const harness = createReceiptRouteHarness();
const PROVISIONING_ROUTE = "/desktop/provisioning-attempt";

/**
 * ISS-12552: an API-key provisioning attempt records one
 * settings receipt in the transaction that stores the attempt.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 provisioning attempt receipts",
  () => {
    beforeEach(() => stubTrustedOriginEnv());
    afterEach(async () => {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
      await harness.cleanup();
    });

    it("rolls the attempt back when its receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      failReceiptInserts();

      const response = await createProvisioningAttempt(
        provisioningRequest(),
        receiptRouteParams({})
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await countAttempts(world.userId)).toBe(0);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("records a committed settings receipt for a new attempt", async () => {
      const world = await harness.seedWorld();

      const response = await createProvisioningAttempt(
        provisioningRequest(),
        receiptRouteParams({})
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.data).toMatchObject({
        operationReceipt: { outcome: OperationReceiptOutcome.Committed },
      });
      expect(await countAttempts(world.userId)).toBe(1);
      expect(await readReceipts(world.organizationId)).toEqual([
        {
          operationKind: OperationKind.SettingsWrite,
          outcome: OperationReceiptOutcome.Committed,
          source: OperationSource.Api,
          targetArtifactId: null,
          createdArtifactId: null,
          changedFields: [],
          route: PROVISIONING_ROUTE,
        },
      ]);
    });

    it("writes no receipt with attribution-evidence-policy off", async () => {
      const world = await harness.seedWorld();
      turnAttributionFlagOff();

      const response = await createProvisioningAttempt(
        provisioningRequest(),
        receiptRouteParams({})
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.data).not.toHaveProperty("operationReceipt");
      expect(await countAttempts(world.userId)).toBe(1);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("with the flag off the attempt opens no transaction, as on main", async () => {
      const world = await harness.seedWorld();
      turnAttributionFlagOff();
      const transactions = countTransactions();

      const response = await createProvisioningAttempt(
        provisioningRequest(),
        receiptRouteParams({})
      );

      expect(response.status).toBe(200);
      expect(transactions.opened).toBe(0);
      expect(await countAttempts(world.userId)).toBe(1);
    });
  }
);

function provisioningRequest() {
  return apiKeyRouteRequest("POST", PROVISIONING_ROUTE, {
    platform: DesktopProvisioningPlatform.Darwin,
    webAppOrigin: TRUSTED_APP_ORIGIN,
  });
}

function countAttempts(userId: string): Promise<number> {
  return withDb((db) =>
    db.desktopOnboardingAttempt.count({ where: { userId } })
  );
}
