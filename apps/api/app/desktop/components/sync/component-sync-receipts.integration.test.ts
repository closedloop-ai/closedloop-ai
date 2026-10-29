import { randomUUID } from "node:crypto";
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import {
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  desktopLaneRequest,
  seedOwnedComputeTarget,
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
import { AGENT_COMPONENT_SYNC_SCHEMA_VERSION } from "@/lib/desktop-agent-sessions-schema";

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

import { POST as syncComponents } from "@/app/desktop/components/sync/route";

const harness = createReceiptRouteHarness();
const COMPONENTS_ROUTE = "/desktop/components/sync";

/**
 * ISS-12552: an API-key component sync records one Desktop sync
 * receipt per inventory write, each in that write's own transaction.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 component sync receipts",
  () => {
    afterEach(async () => {
      vi.restoreAllMocks();
      await harness.cleanup();
    });

    it("rolls a component back when its receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      const computeTargetId = await seedOwnedComputeTarget(world);
      failReceiptInserts();

      const response = await syncComponents(
        componentsRequest(computeTargetId, [skill("rollback")]),
        receiptRouteParams({})
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await countComponents(computeTargetId)).toBe(0);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("records one receipt per component and one for the variant rows", async () => {
      const world = await harness.seedWorld();
      const computeTargetId = await seedOwnedComputeTarget(world);
      const withVariant = {
        ...skill("varied"),
        variants: [{ contentHash: "b".repeat(64), content: "OLDER BODY" }],
      };

      const response = await syncComponents(
        componentsRequest(computeTargetId, [
          skill("first"),
          skill("second"),
          withVariant,
        ]),
        receiptRouteParams({})
      );

      expect(response.status).toBe(200);
      expect(await countComponents(computeTargetId)).toBe(3);
      expect(await readReceipts(world.organizationId)).toEqual(
        Array.from({ length: 4 }, () => ({
          operationKind: OperationKind.DesktopSync,
          outcome: OperationReceiptOutcome.Committed,
          source: OperationSource.Api,
          targetArtifactId: null,
          createdArtifactId: null,
          changedFields: [],
          route: COMPONENTS_ROUTE,
        }))
      );
    });

    it("writes no receipt with attribution-evidence-policy off", async () => {
      const world = await harness.seedWorld();
      const computeTargetId = await seedOwnedComputeTarget(world);
      turnAttributionFlagOff();

      const response = await syncComponents(
        componentsRequest(computeTargetId, [skill("first"), skill("second")]),
        receiptRouteParams({})
      );

      expect(response.status).toBe(200);
      expect(await countComponents(computeTargetId)).toBe(2);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("with the flag off components write on the bare client, as on main", async () => {
      const world = await harness.seedWorld();
      const computeTargetId = await seedOwnedComputeTarget(world);
      turnAttributionFlagOff();
      const transactions = countTransactions();

      const response = await syncComponents(
        componentsRequest(computeTargetId, [skill("first"), skill("second")]),
        receiptRouteParams({})
      );

      expect(response.status).toBe(200);
      // Main's only transaction here is the invocation relink after the
      // inventory; no component opens one of its own. Counted as calls: the
      // fan-out runs components concurrently, so `opened` would undercount.
      expect(transactions.calls).toBe(1);
      expect(await countComponents(computeTargetId)).toBe(2);
    });
  }
);

function skill(key: string) {
  return {
    externalId: `skill::iss12552-${key}`,
    componentKind: AgentComponentKind.Skill,
    harness: "claude-code",
    name: key,
    componentKey: `iss12552-${key}`,
    content: `# ${key}`,
    contentHash: `${key}`.padEnd(64, "a"),
  };
}

function componentsRequest(
  computeTargetId: string,
  components: Record<string, unknown>[]
) {
  return desktopLaneRequest(COMPONENTS_ROUTE, computeTargetId, {
    schemaVersion: AGENT_COMPONENT_SYNC_SCHEMA_VERSION,
    batchId: randomUUID(),
    syncMode: AgentSessionSyncMode.Incremental,
    componentCount: components.length,
    components,
  });
}

function countComponents(computeTargetId: string): Promise<number> {
  return withDb((db) =>
    db.agentComponent.count({ where: { computeTargetId } })
  );
}
