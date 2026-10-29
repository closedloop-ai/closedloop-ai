import {
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import { GitHubBackfillMode } from "@repo/api/src/types/github";
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
import { receiptRouteState } from "@/__tests__/support/lib/operation-receipt-route.test-mocks";

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

import { POST as backfill } from "@/app/integrations/github/backfill/route";
import {
  BACKFILL_RUN_GATE_SETTINGS_KEY,
  BACKFILL_SETTINGS_KEY,
} from "@/app/integrations/github/backfill-service";
import { isRecord } from "@/lib/type-guards";

const harness = createReceiptRouteHarness();
const ROUTE = "/integrations/github/backfill";

/**
 * ISS-12552: an API-key backfill apply records an organization
 * write receipt in the lease claim's transaction; a dry run records none.
 */
describe.skipIf(!keys().DATABASE_URL)("ISS-12552 backfill receipts", () => {
  afterEach(() => harness.cleanup());

  it("POST /integrations/github/backfill apply records one organization write", async () => {
    const world = await harness.seedWorld();

    const response = await backfill(
      backfillRequest(GitHubBackfillMode.Apply),
      receiptRouteParams({})
    );

    expect(response.status).toBe(202);
    expect(await readReceipts(world.organizationId)).toEqual([
      {
        operationKind: OperationKind.OrganizationWrite,
        outcome: OperationReceiptOutcome.Committed,
        source: OperationSource.Api,
        targetArtifactId: null,
        createdArtifactId: null,
        changedFields: [],
        route: ROUTE,
      },
    ]);
    // The claimed sweep runs and persists its summary, and adds no receipt.
    await Promise.all(receiptRouteState.scheduled);
    expect(
      await readSetting(world.organizationId, BACKFILL_SETTINGS_KEY)
    ).toBeDefined();
    expect(await countReceipts(world.organizationId)).toBe(1);
  });

  it("POST /integrations/github/backfill apply claims no lease and starts no sweep when its receipt cannot be stored", async () => {
    const world = await harness.seedWorld();
    failReceiptInserts();

    const response = await backfill(
      backfillRequest(GitHubBackfillMode.Apply),
      receiptRouteParams({})
    );

    expect(response.status).toBe(500);
    expect(forcedReceiptFailures()).toBe(1);
    expect(
      await readSetting(world.organizationId, BACKFILL_RUN_GATE_SETTINGS_KEY)
    ).toBeUndefined();
    // The sweep persists its summary when it finishes; with no claim it
    // never runs, so after any scheduled work settles there is none.
    await Promise.all(receiptRouteState.scheduled);
    expect(
      await readSetting(world.organizationId, BACKFILL_SETTINGS_KEY)
    ).toBeUndefined();
    expect(await countReceipts(world.organizationId)).toBe(0);
  });

  it("POST /integrations/github/backfill dry run records no receipt", async () => {
    const world = await harness.seedWorld();

    const response = await backfill(
      backfillRequest(GitHubBackfillMode.DryRun),
      receiptRouteParams({})
    );

    expect(response.status).toBe(200);
    expect(await countReceipts(world.organizationId)).toBe(0);
  });

  it("POST /integrations/github/backfill apply writes no receipt with attribution-evidence-policy off", async () => {
    const world = await harness.seedWorld();
    turnAttributionFlagOff();

    const response = await backfill(
      backfillRequest(GitHubBackfillMode.Apply),
      receiptRouteParams({})
    );

    expect(response.status).toBe(202);
    expect(
      await readSetting(world.organizationId, BACKFILL_RUN_GATE_SETTINGS_KEY)
    ).toBeDefined();
    expect(await countReceipts(world.organizationId)).toBe(0);
  });
});

function backfillRequest(mode: GitHubBackfillMode) {
  return apiKeyRouteRequest("POST", ROUTE, { mode });
}

async function readSetting(
  organizationId: string,
  key: string
): Promise<unknown> {
  const organization = await withDb((db) =>
    db.organization.findUnique({
      where: { id: organizationId },
      select: { settings: true },
    })
  );
  const settings = organization?.settings;
  return isRecord(settings) ? settings[key] : undefined;
}
