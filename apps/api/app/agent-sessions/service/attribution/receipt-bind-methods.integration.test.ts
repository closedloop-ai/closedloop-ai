/**
 * ISS-12552: the fingerprint fallback binds a
 * receipt only when one session's claim matches it, and the comparison report
 * counts fingerprint binds apart from call-id and operation-id binds, against
 * a real Postgres.
 */
import {
  OperationEvidenceOutcome,
  OperationKind,
} from "@repo/api/src/types/attribution-evidence";
import {
  type OperationClaim,
  OperationClaimSource,
} from "@repo/api/src/types/operation-claims";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteReceipts,
  EVIDENCE_INVOKED,
  EVIDENCE_RESULT,
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
import { buildAttributionComparisonReport } from "./attribution-comparison";

/** The organization's attribution flag is on. */
vi.mock("@/lib/attribution-evidence-policy-feature", () => ({
  isAttributionEvidenceEnabledForOrganization: vi.fn(async () => true),
  evaluateAttributionEvidenceForOrganization: vi.fn(async () => true),
}));

const tracker = createCommittedTestOrganizationTracker();
const organizationIds: string[] = [];
const FINGERPRINT = "e".repeat(64);

describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 how a receipt is joined to its claim",
  () => {
    afterEach(async () => {
      await deleteReceipts(organizationIds.splice(0));
      await tracker.cleanup();
    });

    it("binds no fingerprint receipt two of the owner's sessions match, at sync", async () => {
      const fixture = await seed();
      const other = await ownerSession(fixture, "other");
      const receiptId = await writeReceipt(fixture, {
        requestFingerprint: FINGERPRINT,
      });

      await syncClaims(fixture.sessionId, fixture.organizationId, [
        fingerprintClaim(fixture, "first"),
      ]);
      await syncClaims(other, fixture.organizationId, [
        fingerprintClaim(fixture, "second"),
      ]);

      for (const session of [fixture.sessionId, other]) {
        expect(await evidenceRows(session)).toEqual([
          expect.objectContaining(contested(receiptId)),
        ]);
      }
    });

    it("binds no fingerprint receipt a waiting claim in another session also matches, at sync", async () => {
      const fixture = await seed();
      const other = await ownerSession(fixture, "other");
      await syncClaims(fixture.sessionId, fixture.organizationId, [
        fingerprintClaim(fixture, "first"),
      ]);
      // Written without the late bind, as when it raced the first sync.
      const receiptId = await writeReceipt(fixture, {
        requestFingerprint: FINGERPRINT,
      });

      await syncClaims(other, fixture.organizationId, [
        fingerprintClaim(fixture, "second"),
      ]);

      for (const session of [fixture.sessionId, other]) {
        expect(await evidenceRows(session)).toEqual([
          expect.objectContaining(contested(receiptId)),
        ]);
      }
    });

    it("binds no late fingerprint receipt two of the owner's sessions match", async () => {
      const fixture = await seed();
      const other = await ownerSession(fixture, "other");
      await syncClaims(fixture.sessionId, fixture.organizationId, [
        fingerprintClaim(fixture, "first"),
      ]);
      await syncClaims(other, fixture.organizationId, [
        fingerprintClaim(fixture, "second"),
      ]);
      const receiptId = await writeReceipt(fixture, {
        requestFingerprint: FINGERPRINT,
      });

      await bindAwaitingClaimForReceipt(receiptId, fixture.organizationId);

      for (const session of [fixture.sessionId, other]) {
        expect(await evidenceRows(session)).toEqual([
          expect.objectContaining(contested(receiptId)),
        ]);
      }
    });

    it("never late-binds a receipt to a shell claim", async () => {
      const fixture = await seed();
      await syncClaims(fixture.sessionId, fixture.organizationId, [
        {
          ...shellClaim("toolu_shell_waiting", []),
          operationKind: OperationKind.UpdateFields,
        },
      ]);
      const receiptId = await writeReceipt(fixture, {
        clientCallId: "toolu_shell_waiting",
      });

      await bindAwaitingClaimForReceipt(receiptId, fixture.organizationId);

      expect(await evidenceRows(fixture.sessionId)).toEqual([
        expect.objectContaining({
          receiptId: null,
          outcome: OperationEvidenceOutcome.AwaitingReceipt,
        }),
      ]);
    });

    it("counts call-id, operation-id and fingerprint binds apart in the comparison report", async () => {
      const fixture = await seed();
      const byCallId = await writeReceipt(fixture, {
        clientCallId: "toolu_called",
      });
      const printed = await writeReceipt(fixture, {});
      await writeReceipt(fixture, { requestFingerprint: FINGERPRINT });

      await syncClaims(fixture.sessionId, fixture.organizationId, [
        updateClaim("toolu_called", fixture.documentId),
        shellClaim("toolu_shell", [`clop_${printed}`]),
        fingerprintClaim(fixture, "only"),
      ]);
      const report = await buildAttributionComparisonReport({
        organizationIds: [fixture.organizationId],
      });

      expect(
        (await evidenceRows(fixture.sessionId)).filter(
          (row) => row.receiptId !== null
        )
      ).toHaveLength(3);
      expect(byCallId).not.toBe(printed);
      expect(
        report.organizations[fixture.organizationId]?.receiptBinds
      ).toEqual({ callId: 1, operationId: 1, fingerprint: 1 });
    });
  }
);

async function seed(): Promise<EvidenceFixture> {
  const fixture = await seedEvidenceFixture(tracker);
  organizationIds.push(fixture.organizationId);
  return fixture;
}

/** A write whose call id is unknown, so only its fingerprint can join it. */
function fingerprintClaim(
  fixture: EvidenceFixture,
  label: string
): OperationClaim {
  return updateClaim(label, fixture.documentId, {
    claimKey: `claude:fingerprint-${label}`,
    providerCallId: undefined,
    requestFingerprint: FINGERPRINT,
  });
}

function shellClaim(callId: string, operationIds: string[]): OperationClaim {
  return {
    claimKey: `claude:${callId}`,
    providerCallId: callId,
    source: OperationClaimSource.Shell,
    operationIds,
    invokedAt: EVIDENCE_INVOKED,
    resultAt: EVIDENCE_RESULT,
  };
}

function contested(receiptId: string) {
  return {
    receiptId: null,
    contestedReceiptId: receiptId,
    outcome: OperationEvidenceOutcome.Ambiguous,
  };
}
