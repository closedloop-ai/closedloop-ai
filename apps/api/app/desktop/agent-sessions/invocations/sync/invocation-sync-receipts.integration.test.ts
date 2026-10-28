import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
  AgentComponentInvocationSyncAckState,
  type AgentComponentInvocationSyncItem,
  AgentComponentInvocationSyncRejectReason,
} from "@repo/api/src/types/agent-component-invocation";
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
import {
  computeAgentComponentInvocationGenerationId,
  prepareAgentComponentInvocationSyncParts,
} from "../../../../../../desktop/src/main/agent-sync/agent-component-invocation-sync-payload.js";

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

import { POST as syncInvocations } from "@/app/desktop/agent-sessions/invocations/sync/route";
import { desktopAgentComponentInvocationsSyncService } from "@/app/desktop/agent-sessions/invocations/sync/service";

const harness = createReceiptRouteHarness();
const INVOCATIONS_ROUTE = "/desktop/agent-sessions/invocations/sync";
const SESSION_ID = "iss12552-invocation-session";

/**
 * ISS-12552: an API-key invocation part records one Desktop
 * sync receipt in the part's own ingest transaction.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 invocation sync receipts",
  () => {
    afterEach(async () => {
      vi.restoreAllMocks();
      await harness.cleanup();
    });

    it("rolls the part back when its receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      const computeTargetId = await seedOwnedComputeTarget(world);
      const sessionArtifactId = await seedSyncedSession(
        world,
        computeTargetId,
        SESSION_ID
      );
      failReceiptInserts();

      const response = await syncInvocations(
        invocationRequest(computeTargetId),
        receiptRouteParams({})
      );
      const body = await response.json();

      // The lane's contract answers an ingest that threw with a refused ack,
      // not a 500, so the desktop retries the part.
      expect(response.status).toBe(200);
      expect(body.data).toMatchObject({
        accepted: false,
        reason: AgentComponentInvocationSyncRejectReason.IngestionFailed,
      });
      expect(forcedReceiptFailures()).toBe(1);
      expect(await countGenerations(sessionArtifactId)).toBe(0);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("records a committed Desktop sync receipt for an accepted part", async () => {
      const world = await harness.seedWorld();
      const computeTargetId = await seedOwnedComputeTarget(world);
      const sessionArtifactId = await seedSyncedSession(
        world,
        computeTargetId,
        SESSION_ID
      );

      const response = await syncInvocations(
        invocationRequest(computeTargetId),
        receiptRouteParams({})
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.data).toMatchObject({
        accepted: true,
        state: AgentComponentInvocationSyncAckState.Activated,
        operationReceipt: { outcome: OperationReceiptOutcome.Committed },
      });
      expect(await countGenerations(sessionArtifactId)).toBe(1);
      expect(await readReceipts(world.organizationId)).toEqual([
        desktopSyncReceipt(OperationReceiptOutcome.Committed),
      ]);
    });

    it("records a no-op receipt for a part the ingest refused", async () => {
      const world = await harness.seedWorld();
      const computeTargetId = await seedOwnedComputeTarget(world);

      const response = await syncInvocations(
        invocationRequest(computeTargetId),
        receiptRouteParams({})
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.data).toMatchObject({
        accepted: false,
        reason: AgentComponentInvocationSyncRejectReason.SessionMissing,
      });
      expect(await readReceipts(world.organizationId)).toEqual([
        desktopSyncReceipt(OperationReceiptOutcome.NoOp),
      ]);
    });

    it("writes no receipt with attribution-evidence-policy off", async () => {
      const world = await harness.seedWorld();
      const computeTargetId = await seedOwnedComputeTarget(world);
      const sessionArtifactId = await seedSyncedSession(
        world,
        computeTargetId,
        SESSION_ID
      );
      turnAttributionFlagOff();

      const response = await syncInvocations(
        invocationRequest(computeTargetId),
        receiptRouteParams({})
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.data).toMatchObject({ accepted: true });
      expect(body.data).not.toHaveProperty("operationReceipt");
      expect(await countGenerations(sessionArtifactId)).toBe(1);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("with the flag off the ingest is handed no record, as on main", async () => {
      const world = await harness.seedWorld();
      const computeTargetId = await seedOwnedComputeTarget(world);
      const sessionArtifactId = await seedSyncedSession(
        world,
        computeTargetId,
        SESSION_ID
      );
      turnAttributionFlagOff();
      const sync = vi.spyOn(
        desktopAgentComponentInvocationsSyncService,
        "sync"
      );

      const response = await syncInvocations(
        invocationRequest(computeTargetId),
        receiptRouteParams({})
      );

      expect(response.status).toBe(200);
      expect(sync).toHaveBeenCalledTimes(1);
      expect(sync.mock.calls[0]?.[1]).toBeUndefined();
      expect(await countGenerations(sessionArtifactId)).toBe(1);
    });
  }
);

function desktopSyncReceipt(outcome: OperationReceiptOutcome) {
  return {
    operationKind: OperationKind.DesktopSync,
    outcome,
    source: OperationSource.Api,
    targetArtifactId: null,
    createdArtifactId: null,
    changedFields: [],
    route: INVOCATIONS_ROUTE,
  };
}

function invocationRequest(computeTargetId: string) {
  const items = [item("iss12552-a", 0), item("iss12552-b", 1)];
  const [part] = prepareAgentComponentInvocationSyncParts({
    externalSessionId: SESSION_ID,
    externalGenerationId: computeAgentComponentInvocationGenerationId(
      SESSION_ID,
      items
    ),
    sourceUpdatedAt: "2026-06-12T11:05:00.000Z",
    dataRevision: 1,
    sourceSequence: 1,
    items,
  });
  if (!part) {
    throw new Error("ISS-12552 invocation fixture produced no part");
  }
  return desktopLaneRequest(INVOCATIONS_ROUTE, computeTargetId, {
    protocolVersion: part.protocolVersion,
    parts: [part],
  });
}

function item(
  externalInvocationId: string,
  sequence: number
): AgentComponentInvocationSyncItem {
  return {
    externalInvocationId,
    sourceSessionId: SESSION_ID,
    kind: AgentComponentInvocationKind.Skill,
    componentKey: "code-review",
    relationship: AgentComponentInvocationRelationship.Direct,
    invokedAt: "2026-06-12T10:15:00.000Z",
    sequence,
    anchor: {
      kind: AgentComponentInvocationAnchorKind.Event,
      eventId: `${externalInvocationId}-event`,
    },
    status: AgentComponentInvocationAttributionStatus.Unresolved,
    evidenceClass: AgentComponentInvocationEvidenceClass.None,
  };
}

function countGenerations(agentSessionId: string): Promise<number> {
  return withDb((db) =>
    db.agentComponentInvocationGeneration.count({ where: { agentSessionId } })
  );
}
