/**
 * ISS-12552 (PRD-800 "Writes made outside the Closedloop MCP"): an
 * API-key write with no artifact target records a receipt named for what it
 * wrote. The backfill binds nothing to it and makes no evidence from it, and
 * the comparison report counts it with the other API-key writes, by route.
 * The receipts come from the real routes, so the route each one is counted
 * under is the one the recorder stamped.
 */
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
  createReceiptRouteHarness,
  readReceipts,
  receiptRouteParams,
} from "@/__tests__/support/lib/operation-receipt-route.test-helpers";
import { createTestSessionDetail } from "@/__tests__/utils/db-helpers";

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

import { POST as upsertGridPreference } from "@/app/settings/grid-preferences/route";
import { POST as createTag } from "@/app/tags/route";
import { runAttributionBackfill } from "./attribution-backfill";
import { buildAttributionComparisonReport } from "./attribution-comparison";

const harness = createReceiptRouteHarness();
const organizationIds: string[] = [];
const TAGS_ROUTE = "/tags";
const SETTINGS_ROUTE = "/settings/grid-preferences";

describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 machine-write receipts",
  () => {
    afterEach(async () => {
      const ids = organizationIds.splice(0);
      await withDb(async (db) => {
        await db.tag.deleteMany({ where: { organizationId: { in: ids } } });
        await db.attributionBackfillRun.deleteMany({
          where: { organizationId: { in: ids } },
        });
      });
      await harness.cleanup();
    });

    it("gives a machine write no evidence and counts it in API-key writes by route", async () => {
      const world = await harness.seedWorld();
      organizationIds.push(world.organizationId);
      await createTestSessionDetail({
        organizationId: world.organizationId,
        userId: world.userId,
        label: "machine-writes",
      });
      const statuses = [
        (await postTag("Machine one")).status,
        (await postTag("Machine two")).status,
        (await postGridPreference()).status,
      ];
      expect(statuses).toEqual([200, 200, 200]);
      expect(await readReceipts(world.organizationId)).toEqual([
        machineReceipt(OperationKind.OrganizationWrite, TAGS_ROUTE),
        machineReceipt(OperationKind.OrganizationWrite, TAGS_ROUTE),
        machineReceipt(OperationKind.SettingsWrite, SETTINGS_ROUTE),
      ]);

      const backfill = await runAttributionBackfill({
        organizationId: world.organizationId,
      });
      const report = await buildAttributionComparisonReport({
        organizationIds: [world.organizationId],
      });

      expect(backfill.counts).toMatchObject({ bound: 0, corroborated: 0 });
      expect(
        await withDb((db) =>
          db.agentSessionOperationEvidence.count({
            where: { organizationId: world.organizationId },
          })
        )
      ).toBe(0);
      expect(report.organizations[world.organizationId]?.apiKeyWrites).toEqual({
        total: 3,
        attributed: 0,
        unattributed: 3,
        byRoute: {
          [TAGS_ROUTE]: { total: 2, attributed: 0, unattributed: 2 },
          [SETTINGS_ROUTE]: { total: 1, attributed: 0, unattributed: 1 },
        },
      });
    });
  }
);

function postTag(name: string) {
  return createTag(
    apiKeyRouteRequest("POST", TAGS_ROUTE, { name }),
    receiptRouteParams({})
  );
}

function postGridPreference() {
  return upsertGridPreference(
    apiKeyRouteRequest("POST", SETTINGS_ROUTE, {
      gridKey: GridPreferenceGridKey.Sessions,
      preferenceKind: GridPreferenceKind.ViewState,
      scopeKey: GridPreferenceScopeKey.Default,
      value: { columns: ["name"] },
    }),
    receiptRouteParams({})
  );
}

/** A committed receipt for a write that targets no artifact. */
function machineReceipt(operationKind: OperationKind, route: string) {
  return {
    operationKind,
    outcome: OperationReceiptOutcome.Committed,
    source: OperationSource.Api,
    targetArtifactId: null,
    createdArtifactId: null,
    changedFields: [],
    route,
  };
}
