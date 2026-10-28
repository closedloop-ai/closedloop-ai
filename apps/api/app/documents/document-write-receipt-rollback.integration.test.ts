import {
  OperationEvidenceOutcome,
  OperationKind,
} from "@repo/api/src/types/attribution-evidence";
import { DocumentType } from "@repo/api/src/types/document";
import {
  OPERATION_EVIDENCE_EXTRACTOR_VERSION,
  OperationClaimSource,
  ToolResultState,
} from "@repo/api/src/types/operation-claims";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  countReceipts,
  createReceiptRouteHarness,
  failReceiptInserts,
  forcedReceiptFailures,
  receiptRouteParams,
  receiptRouteRequest,
} from "@/__tests__/support/lib/operation-receipt-route.test-helpers";
import { createTestSessionDetail } from "@/__tests__/utils/db-helpers";

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
/** The flag is on for receipts and binding (PRD-800); the link sync reads it as off. */
vi.mock("@/lib/attribution-evidence-policy-feature", () => ({
  isAttributionEvidenceEnabledForOrganization: vi.fn(async () => true),
  evaluateAttributionEvidenceForOrganization: vi.fn(async () => false),
}));

import { persistSessionOperationEvidence } from "@/app/agent-sessions/service/attribution/persist-operation-evidence";
import { PUT as updateDocument } from "@/app/documents/[id]/route";
import { POST as createVersion } from "@/app/documents/[id]/versions/route";
import { POST as createDocument } from "@/app/documents/route";

const harness = createReceiptRouteHarness();

/**
 * ISS-12552: a document write and its operation receipt share one
 * transaction, so a receipt that cannot be stored leaves no write behind.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 document writes roll back with their receipt",
  () => {
    afterEach(() => harness.cleanup());

    it("POST /documents leaves no document", async () => {
      const world = await harness.seedWorld();
      failReceiptInserts();

      const response = await createDocument(
        receiptRouteRequest("POST", "/documents", {
          type: DocumentType.Prd,
          title: "Rolled back",
          content: "Never stored",
          projectId: world.projectId,
        }),
        receiptRouteParams({})
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(
        await withDb((db) =>
          db.artifact.count({
            where: {
              organizationId: world.organizationId,
              name: "Rolled back",
            },
          })
        )
      ).toBe(0);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("PUT /documents/[id] keeps the document unchanged", async () => {
      const world = await harness.seedWorld();
      const documentId = await harness.seedDocument(world, "Original");
      failReceiptInserts();

      const response = await updateDocument(
        receiptRouteRequest("PUT", `/documents/${documentId}`, {
          title: "Renamed",
        }),
        receiptRouteParams({ id: documentId })
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(
        await withDb((db) =>
          db.artifact.findUniqueOrThrow({
            where: { id: documentId },
            select: { name: true },
          })
        )
      ).toEqual({ name: "Original" });
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("POST /documents/[id]/versions leaves no version", async () => {
      const world = await harness.seedWorld();
      const documentId = await harness.seedDocument(world, "Versioned");
      const versionsBefore = await countVersions(documentId);
      failReceiptInserts();

      const response = await createVersion(
        receiptRouteRequest("POST", `/documents/${documentId}/versions`, {
          content: "A version that never lands",
        }),
        receiptRouteParams({ id: documentId })
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await countVersions(documentId)).toBe(versionsBefore);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });
  }
);

describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 a write route binds the claim already waiting on its receipt",
  () => {
    afterEach(() => harness.cleanup());

    it("binds a synced claim to the receipt PUT /documents/[id] records for the same call", async () => {
      const world = await harness.seedWorld();
      const documentId = await harness.seedDocument(world, "Original");
      const agentSessionId = await createTestSessionDetail({
        organizationId: world.organizationId,
        userId: world.userId,
        label: "waiting-claim",
      });
      const callId = "toolu_waiting_update";
      await syncWaitingUpdateClaim(world, agentSessionId, documentId, callId);

      const response = await updateDocument(
        receiptRouteRequest(
          "PUT",
          `/documents/${documentId}`,
          { title: "Renamed" },
          callId
        ),
        receiptRouteParams({ id: documentId })
      );

      expect(response.status).toBe(200);
      const receipt = await withDb((db) =>
        db.artifactOperationReceipt.findFirstOrThrow({
          where: { organizationId: world.organizationId, clientCallId: callId },
          select: { id: true },
        })
      );
      expect(
        await withDb((db) =>
          db.agentSessionOperationEvidence.findMany({
            where: { agentSessionId },
            select: { receiptId: true, outcome: true },
          })
        )
      ).toEqual([
        { receiptId: receipt.id, outcome: OperationEvidenceOutcome.Committed },
      ]);
    });
  }
);

function countVersions(documentId: string): Promise<number> {
  return withDb((db) => db.documentVersion.count({ where: { documentId } }));
}

/** The ingest persist step for one session holding a write still awaiting its receipt. */
async function syncWaitingUpdateClaim(
  world: { organizationId: string },
  agentSessionId: string,
  documentId: string,
  callId: string
): Promise<void> {
  const at = new Date().toISOString();
  const claim = {
    claimKey: `claude:${callId}`,
    providerCallId: callId,
    source: OperationClaimSource.ClosedloopMcp,
    toolName: "update-document",
    operationKind: OperationKind.UpdateFields,
    resultState: ToolResultState.Present,
    inputTargets: [{ key: "documentId", uuid: documentId }],
    invokedAt: at,
    resultAt: at,
  };
  await withDb.tx(
    (tx) =>
      persistSessionOperationEvidence(tx, {
        organizationId: world.organizationId,
        agentSessionId,
        fresh: true,
        evidence: {
          extractorVersion: OPERATION_EVIDENCE_EXTRACTOR_VERSION,
          digest: "a".repeat(64),
          coverage: {
            harness: "claude",
            evidencePathSupported: true,
            closedloopMcpCalls: 1,
            shellCallsWithOperationIds: 0,
            directApiShellCommands: 0,
            unsupportedToolNames: {},
            claimsDroppedByCap: 0,
          },
          claims: [claim],
        },
      }),
    { maxWait: 5000, timeout: 20_000 }
  );
  const waiting = await withDb((db) =>
    db.agentSessionOperationEvidence.count({
      where: {
        agentSessionId,
        outcome: OperationEvidenceOutcome.AwaitingReceipt,
      },
    })
  );
  if (waiting !== 1) {
    throw new Error("expected the synced claim to await its receipt");
  }
}
