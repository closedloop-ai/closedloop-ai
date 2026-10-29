/**
 * ISS-12552: a batch route records several receipts under one MCP call, and
 * `settle` gives every one of them its late bind, so a claim already waiting
 * on any receipt of the batch binds to that receipt, against a real Postgres.
 */
import {
  OperationEvidenceOutcome,
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
  parseOperationId,
} from "@repo/api/src/types/attribution-evidence";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteReceipts,
  EVIDENCE_REQUESTED,
  evidenceRows,
  seedEvidenceFixture,
  syncClaims,
  updateClaim,
} from "@/__tests__/support/agent-sessions/attribution/operation-evidence.test-helpers";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import { createRecorderForRequest } from "./operation-receipt-recorder";

vi.mock("@/lib/attribution-evidence-policy-feature", () => ({
  isAttributionEvidenceEnabledForOrganization: vi.fn(async () => true),
  evaluateAttributionEvidenceForOrganization: vi.fn(async () => true),
}));

const CALL_ID = "toolu_01BatchSettle";
const tracker = createCommittedTestOrganizationTracker();
const organizationIds: string[] = [];

describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 batch settle late-binds every receipt",
  () => {
    afterEach(async () => {
      await deleteReceipts(organizationIds.splice(0));
      await tracker.cleanup();
    });

    it("binds a waiting claim to the batch receipt it matches, not only the last one", async () => {
      const fixture = await seedEvidenceFixture(tracker);
      organizationIds.push(fixture.organizationId);
      await syncClaims(fixture.sessionId, fixture.organizationId, [
        updateClaim(CALL_ID, fixture.documentId),
      ]);
      const recorder = createRecorderForRequest({
        organizationId: fixture.organizationId,
        principalUserId: fixture.userId,
        source: OperationSource.Mcp,
        clientCallId: CALL_ID,
        requestedAt: EVIDENCE_REQUESTED,
      });
      const receiptIds = await withDb.tx(async (tx) => {
        const ids: string[] = [];
        for (const operationKind of [
          OperationKind.UpdateFields,
          OperationKind.Tag,
          OperationKind.Tag,
        ]) {
          await recorder.record(tx, {
            operationKind,
            outcome: OperationReceiptOutcome.Committed,
            targetArtifactId: fixture.documentId,
            changedFields: ["fileName"],
          });
          ids.push(parseOperationId(recorder.receipt?.operationId ?? "") ?? "");
        }
        return ids;
      });

      await recorder.settle();

      expect(new Set(receiptIds).size).toBe(3);
      expect(await evidenceRows(fixture.sessionId)).toEqual([
        expect.objectContaining({
          providerCallId: CALL_ID,
          receiptId: receiptIds[0],
          outcome: OperationEvidenceOutcome.Committed,
        }),
      ]);
    });
  }
);
