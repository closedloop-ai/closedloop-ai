import { randomUUID } from "node:crypto";
import {
  AttributionRelationshipKind,
  OperationEvidenceOutcome,
  OperationKind,
} from "@repo/api/src/types/attribution-evidence";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import {
  OPERATION_EVIDENCE_EXTRACTOR_VERSION,
  type OperationClaim,
  OperationClaimSource,
  ToolResultState,
} from "@repo/api/src/types/operation-claims";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createReceiptRouteHarness,
  receiptRouteParams,
  receiptRouteRequest,
} from "@/__tests__/support/lib/operation-receipt-route.test-helpers";
import { createTestSessionDetail } from "@/__tests__/utils/db-helpers";
import { createDocumentRecord } from "@/app/documents/document-service";
import { persistSessionOperationEvidence } from "./persist-operation-evidence";

// ISS-12552: receipts are recorded only while attribution-evidence-policy is on.
vi.mock(
  "@/lib/attribution-evidence-policy-feature",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/attribution-evidence-policy-feature")
    >()),
    isAttributionEvidenceEnabledForOrganization: vi.fn(async () => true),
  })
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

import { POST as createVersion } from "@/app/documents/[id]/versions/route";

const harness = createReceiptRouteHarness();
/** Cold-start headroom; the ingest transaction sets its own budget. */
const TRANSACTION_OPTIONS = { maxWait: 5000, timeout: 20_000 };

/**
 * ISS-12552: a document whose previous version holds no content gets a
 * receipt with no before-digest on its first content save. That save moved
 * the content, so the session that made it revised the document.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 first content save classification",
  () => {
    afterEach(() => harness.cleanup());

    it("classifies the first content save onto a NULL-content version as a revision", async () => {
      const world = await harness.seedWorld();
      const documentId = await seedEmptyDocument(world);
      const sessionId = await createTestSessionDetail({
        organizationId: world.organizationId,
        userId: world.userId,
        label: "first-content",
      });
      const callId = `toolu_${randomUUID()}`;
      const invokedAt = new Date(Date.now() - 1000).toISOString();

      const response = await createVersion(
        receiptRouteRequest(
          "POST",
          `/documents/${documentId}/versions`,
          { content: "First content" },
          callId
        ),
        receiptRouteParams({ id: documentId })
      );
      expect(response.status).toBe(200);

      await syncClaim(world.organizationId, sessionId, {
        claimKey: `claude:${callId}`,
        providerCallId: callId,
        source: OperationClaimSource.ClosedloopMcp,
        toolName: "create-document-version",
        operationKind: OperationKind.CreateVersion,
        resultState: ToolResultState.Present,
        inputTargets: [{ key: "documentId", uuid: documentId }],
        invokedAt,
        resultAt: new Date(Date.now() + 5000).toISOString(),
      });

      expect(
        await withDb((db) =>
          db.agentSessionOperationEvidence.findMany({
            where: { agentSessionId: sessionId },
            select: { outcome: true, relationshipKind: true },
          })
        )
      ).toEqual([
        {
          outcome: OperationEvidenceOutcome.Committed,
          relationshipKind: AttributionRelationshipKind.Revision,
        },
      ]);
    });
  }
);

async function seedEmptyDocument(world: {
  organizationId: string;
  userId: string;
  projectId: string;
}): Promise<string> {
  const document = await withDb.tx((tx) =>
    createDocumentRecord(tx, world.organizationId, world.userId, {
      content: "",
      projectId: world.projectId,
      status: DocumentStatus.Draft,
      title: "No content yet",
      type: DocumentType.Prd,
    })
  );
  if (!document) {
    throw new Error("Failed to seed the ISS-12552 document");
  }
  // `CreateDocumentInput` requires content, so the nullable version column is
  // cleared directly to give the first version no content.
  const { count } = await withDb((db) =>
    db.documentVersion.updateMany({
      where: { documentId: document.id, version: 1 },
      data: { content: null },
    })
  );
  if (count !== 1) {
    throw new Error("Failed to clear the ISS-12552 document's first version");
  }
  return document.id;
}

async function syncClaim(
  organizationId: string,
  sessionId: string,
  claim: OperationClaim
): Promise<void> {
  await withDb.tx(
    (tx) =>
      persistSessionOperationEvidence(tx, {
        organizationId,
        agentSessionId: sessionId,
        fresh: true,
        evidence: {
          extractorVersion: OPERATION_EVIDENCE_EXTRACTOR_VERSION,
          digest: "f".repeat(64),
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
    TRANSACTION_OPTIONS
  );
}
