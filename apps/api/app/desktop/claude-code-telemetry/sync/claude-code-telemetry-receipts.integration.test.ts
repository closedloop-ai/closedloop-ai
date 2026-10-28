import {
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import { DESKTOP_CLAUDE_CODE_TELEMETRY_SYNC_PROTOCOL_VERSION } from "@repo/api/src/types/desktop-claude-code-telemetry-sync";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  desktopLaneRequest,
  seedOwnedComputeTarget,
  seedSyncedSession,
} from "@/__tests__/support/desktop/desktop-sync-receipt.test-helpers";
import {
  countReceipts,
  createReceiptRouteHarness,
  failReceiptInserts,
  forcedReceiptFailures,
  readReceipts,
  receiptRouteParams,
  turnAttributionFlagOff,
} from "@/__tests__/support/lib/operation-receipt-route.test-helpers";
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

import { POST as syncTelemetry } from "@/app/desktop/claude-code-telemetry/sync/route";

const harness = createReceiptRouteHarness();
const TELEMETRY_ROUTE = "/desktop/claude-code-telemetry/sync";
const SESSION_ID = "iss12552-telemetry-session";

/**
 * ISS-12552: an API-key Claude Code telemetry delivery records
 * one telemetry receipt in the delivery's own transaction.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 Claude Code telemetry receipts",
  () => {
    afterEach(async () => {
      vi.restoreAllMocks();
      await harness.cleanup();
    });

    it("rolls the delivery back when its receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      const computeTargetId = await seedOwnedComputeTarget(world);
      const artifactId = await seedSyncedSession(
        world,
        computeTargetId,
        SESSION_ID
      );
      failReceiptInserts();

      const response = await syncTelemetry(
        telemetryRequest(computeTargetId, SESSION_ID),
        receiptRouteParams({})
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await countWrittenTelemetry(computeTargetId, artifactId)).toEqual({
        sessions: 0,
        components: 0,
        counters: 0,
      });
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("records a committed delivery, and one that stored nothing as a no-op", async () => {
      const world = await harness.seedWorld();
      const computeTargetId = await seedOwnedComputeTarget(world);
      const artifactId = await seedSyncedSession(
        world,
        computeTargetId,
        SESSION_ID
      );

      const written = await syncTelemetry(
        telemetryRequest(computeTargetId, SESSION_ID),
        receiptRouteParams({})
      );
      const unsynced = await syncTelemetry(
        telemetryRequest(computeTargetId, "iss12552-not-synced-yet", []),
        receiptRouteParams({})
      );

      expect([written.status, unsynced.status]).toEqual([200, 200]);
      expect((await written.json()).data).toMatchObject({
        accepted: true,
        operationReceipt: { outcome: OperationReceiptOutcome.Committed },
      });
      expect((await unsynced.json()).data).toMatchObject({ accepted: false });
      expect(await countWrittenTelemetry(computeTargetId, artifactId)).toEqual({
        sessions: 1,
        components: 1,
        counters: 1,
      });
      expect(await readReceipts(world.organizationId)).toEqual(
        [OperationReceiptOutcome.Committed, OperationReceiptOutcome.NoOp].map(
          (outcome) => ({
            operationKind: OperationKind.Telemetry,
            outcome,
            source: OperationSource.Api,
            targetArtifactId: null,
            createdArtifactId: null,
            changedFields: [],
            route: TELEMETRY_ROUTE,
          })
        )
      );
    });

    it("writes no receipt with attribution-evidence-policy off", async () => {
      const world = await harness.seedWorld();
      const computeTargetId = await seedOwnedComputeTarget(world);
      const artifactId = await seedSyncedSession(
        world,
        computeTargetId,
        SESSION_ID
      );
      turnAttributionFlagOff();

      const response = await syncTelemetry(
        telemetryRequest(computeTargetId, SESSION_ID),
        receiptRouteParams({})
      );

      expect(response.status).toBe(200);
      expect(await countWrittenTelemetry(computeTargetId, artifactId)).toEqual({
        sessions: 1,
        components: 1,
        counters: 1,
      });
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("with the flag off a delivery opens no transaction, as on main", async () => {
      const world = await harness.seedWorld();
      const computeTargetId = await seedOwnedComputeTarget(world);
      const artifactId = await seedSyncedSession(
        world,
        computeTargetId,
        SESSION_ID
      );
      turnAttributionFlagOff();
      const transactions = countTransactions();

      const response = await syncTelemetry(
        telemetryRequest(computeTargetId, SESSION_ID),
        receiptRouteParams({})
      );

      expect(response.status).toBe(200);
      expect(transactions.opened).toBe(0);
      expect(await countWrittenTelemetry(computeTargetId, artifactId)).toEqual({
        sessions: 1,
        components: 1,
        counters: 1,
      });
    });
  }
);

function telemetryRequest(
  computeTargetId: string,
  externalSessionId: string,
  dropCounters = [
    {
      harness: "claude",
      reason: "normalizer_unusable",
      droppedCount: "7",
      firstObservedAt: "2026-09-20T00:00:00.000Z",
      lastObservedAt: "2026-09-21T00:00:00.000Z",
    },
  ]
) {
  return desktopLaneRequest(TELEMETRY_ROUTE, computeTargetId, {
    protocolVersion: DESKTOP_CLAUDE_CODE_TELEMETRY_SYNC_PROTOCOL_VERSION,
    session: {
      externalSessionId,
      harness: "claude",
      costEventCount: 3,
      components: [
        {
          attributionKey: "skill:code-review",
          attributionSource: "otel",
          skillName: "code-review",
          costEventCount: 3,
        },
      ],
    },
    dropCounters,
  });
}

async function countWrittenTelemetry(
  computeTargetId: string,
  artifactId: string
) {
  const [sessions, components, counters] = await withDb((db) =>
    Promise.all([
      db.claudeCodeSessionTelemetry.count({ where: { artifactId } }),
      db.claudeCodeComponentTelemetry.count({ where: { artifactId } }),
      db.claudeCodeSignalDropCounter.count({ where: { computeTargetId } }),
    ])
  );
  return { sessions, components, counters };
}
