/**
 * ISS-12552: an evidence row that gives its receipt up keeps nothing
 * the receipt decided, against a real Postgres.
 */
import { OperationEvidenceOutcome } from "@repo/api/src/types/attribution-evidence";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  copiesOfFixtureSession,
  deleteReceipts,
  EVIDENCE_INVOKED,
  type EvidenceFixture,
  evidenceRows,
  ownerSession,
  seedEvidenceFixture,
  syncClaims,
  updateClaim,
  writeReceipt,
} from "@/__tests__/support/agent-sessions/attribution/operation-evidence.test-helpers";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import { bindAwaitingClaimForReceipt } from "@/lib/operation-receipts/bind-awaiting-claim";

/** The organization's attribution flag is on. */
vi.mock("@/lib/attribution-evidence-policy-feature", () => ({
  isAttributionEvidenceEnabledForOrganization: vi.fn(async () => true),
  evaluateAttributionEvidenceForOrganization: vi.fn(async () => true),
}));

const tracker = createCommittedTestOrganizationTracker();
const organizationIds: string[] = [];

describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 a released receipt's evidence row",
  () => {
    afterEach(async () => {
      await deleteReceipts(organizationIds.splice(0));
      await tracker.cleanup();
    });

    it("drops the receipt's target, changed fields and version, and keeps the claim's own facts", async () => {
      const fixture = await seed();
      const fork = await ownerSession(fixture, "fork");
      await writeReceipt(fixture, {
        clientCallId: "toolu_shared",
        versionNumber: 4,
        changedFields: ["fileName", "status"],
      });
      await syncClaims(fork, fixture.organizationId, [
        updateClaim("toolu_shared", fixture.documentId, {
          invokedAt: "2026-10-16T12:30:00.000Z",
          resultAt: "2026-10-16T12:30:05.000Z",
        }),
      ]);
      const [held] = await evidenceRows(fork);
      expect(held).toMatchObject({
        targetArtifactId: fixture.documentId,
        versionNumber: 4,
        changedFields: ["fileName", "status"],
      });

      await syncClaims(fixture.sessionId, fixture.organizationId, [
        updateClaim("toolu_shared", fixture.documentId),
      ]);

      expect(await evidenceRows(fork)).toEqual([
        {
          ...held,
          receiptId: null,
          contestedReceiptId: null,
          outcome: OperationEvidenceOutcome.DuplicateInLineage,
          relationshipKind: expect.any(String),
          unresolvedReason: expect.any(String),
          targetArtifactId: null,
          effectiveAt: null,
          changedFields: [],
          versionNumber: null,
        },
      ]);
    });

    it("keeps the target a copy's own call named when the copy never held the receipt", async () => {
      const fixture = await seed();
      const { canonical, other } = await copiesOfFixtureSession(fixture);
      const claim = updateClaim("toolu_copied", fixture.documentId);
      await syncClaims(canonical, fixture.organizationId, [claim]);
      await syncClaims(other, fixture.organizationId, [claim]);
      const late = await writeReceipt(fixture, {
        clientCallId: "toolu_copied",
        versionNumber: 2,
      });

      await bindAwaitingClaimForReceipt(late, fixture.organizationId);

      const rows = [
        ...(await evidenceRows(canonical)),
        ...(await evidenceRows(other)),
      ];
      const released = rows.find((row) => row.receiptId === null);
      expect(rows.filter((row) => row.receiptId === late)).toHaveLength(1);
      expect(released).toMatchObject({
        outcome: OperationEvidenceOutcome.DuplicateInLineage,
        targetArtifactId: fixture.documentId,
        changedFields: [],
        versionNumber: null,
        invokedAt: new Date(EVIDENCE_INVOKED),
      });
    });
  }
);

async function seed(): Promise<EvidenceFixture> {
  const fixture = await seedEvidenceFixture(tracker);
  organizationIds.push(fixture.organizationId);
  return fixture;
}
