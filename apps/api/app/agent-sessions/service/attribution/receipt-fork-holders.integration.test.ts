/**
 * ISS-12552: who keeps a receipt that two of an organization's sessions claim,
 * at sync, at receipt write and in the backfill, against a real Postgres.
 */
import {
  OperationEvidenceOutcome,
  OperationKind,
} from "@repo/api/src/types/attribution-evidence";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteReceipts,
  type EvidenceFixture,
  evidenceRows,
  ownerSession,
  seedEvidenceFixture,
  syncClaims,
  updateClaim,
  writeReceipt,
} from "@/__tests__/support/agent-sessions/attribution/operation-evidence.test-helpers";
import {
  createCommittedTestOrganizationTracker,
  createTestSessionDetail,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { bindAwaitingClaimForReceipt } from "@/lib/operation-receipts/bind-awaiting-claim";
import { runAttributionBackfill } from "./attribution-backfill";

/** The organization's attribution flag is on. */
vi.mock("@/lib/attribution-evidence-policy-feature", () => ({
  isAttributionEvidenceEnabledForOrganization: vi.fn(async () => true),
  evaluateAttributionEvidenceForOrganization: vi.fn(async () => true),
}));

const tracker = createCommittedTestOrganizationTracker();
const organizationIds: string[] = [];
/** The fixture's own session starts here (createTestSessionDetail's default). */
const SAME_START = new Date("2026-05-15T00:00:00Z");
const LATER_START = new Date("2026-05-15T01:00:00Z");
/** Within a day of the claims, so the backfill finalizes nothing. */
const BACKFILL_NOW = new Date("2026-10-16T13:00:00Z");

describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 receipts two sessions claim",
  () => {
    afterEach(async () => {
      await deleteReceipts(organizationIds.splice(0));
      await tracker.cleanup();
    });

    it("takes a receipt from another member's session that holds it, and leaves that row waiting", async () => {
      const fixture = await seed();
      const member = await createTestUser(fixture.organizationId);
      const theirs = await createTestSessionDetail({
        organizationId: fixture.organizationId,
        userId: member.id,
        label: "member",
      });
      const receiptId = await writeReceipt(fixture, {
        clientCallId: "toolu_shared",
      });
      const claim = updateClaim("toolu_shared", fixture.documentId);
      await syncClaims(theirs, fixture.organizationId, [claim]);
      // Only data drift binds a receipt to another member's session.
      await withDb((db) =>
        db.agentSessionOperationEvidence.updateMany({
          where: { agentSessionId: theirs },
          data: { receiptId, targetArtifactId: fixture.documentId },
        })
      );

      await syncClaims(fixture.sessionId, fixture.organizationId, [claim]);

      expect(await evidenceRows(fixture.sessionId)).toEqual([
        expect.objectContaining({
          receiptId,
          outcome: OperationEvidenceOutcome.Committed,
        }),
      ]);
      expect(await evidenceRows(theirs)).toEqual([
        expect.objectContaining({
          receiptId: null,
          contestedReceiptId: null,
          outcome: OperationEvidenceOutcome.AwaitingReceipt,
          targetArtifactId: null,
        }),
      ]);
    });

    it("contests a receipt a fork that started with its parent claims at the same instant, at sync and late, through resyncs", async () => {
      const fixture = await seed();
      const fork = await ownerSession(fixture, "fork", SAME_START);
      const claim = updateClaim("toolu_shared", fixture.documentId);
      const synced = await writeReceipt(fixture, {
        clientCallId: "toolu_shared",
      });
      await syncClaims(fixture.sessionId, fixture.organizationId, [claim]);
      await syncClaims(fork, fixture.organizationId, [claim]);
      await syncClaims(fork, fixture.organizationId, grown(fixture, "one"));
      await syncClaims(
        fixture.sessionId,
        fixture.organizationId,
        grown(fixture, "two")
      );

      expect(await claimRows(fixture.sessionId, fork)).toEqual([
        contested(synced),
        contested(synced),
      ]);

      const other = await seed();
      const otherFork = await ownerSession(other, "fork", SAME_START);
      const late = updateClaim("toolu_late", other.documentId);
      await syncClaims(other.sessionId, other.organizationId, [late]);
      await syncClaims(otherFork, other.organizationId, [late]);
      const lateReceipt = await writeReceipt(other, {
        clientCallId: "toolu_late",
      });

      await bindAwaitingClaimForReceipt(lateReceipt, other.organizationId);

      expect(await claimRows(other.sessionId, otherFork)).toEqual([
        contested(lateReceipt),
        contested(lateReceipt),
      ]);
    });

    it("gives a receipt to the parent over a fork that started later, whichever synced first, through resyncs", async () => {
      const fixture = await seed();
      const fork = await ownerSession(fixture, "fork", LATER_START);
      const claim = updateClaim("toolu_shared", fixture.documentId);
      const receiptId = await writeReceipt(fixture, {
        clientCallId: "toolu_shared",
      });
      await syncClaims(fork, fixture.organizationId, [claim]);
      await syncClaims(fixture.sessionId, fixture.organizationId, [claim]);
      const parentKeeps = [bound(receiptId), duplicate()];
      expect(await claimRows(fixture.sessionId, fork)).toEqual(parentKeeps);

      await syncClaims(fork, fixture.organizationId, grown(fixture, "one"));
      expect(await claimRows(fixture.sessionId, fork)).toEqual(parentKeeps);
      await syncClaims(
        fixture.sessionId,
        fixture.organizationId,
        grown(fixture, "two")
      );
      expect(await claimRows(fixture.sessionId, fork)).toEqual(parentKeeps);
    });

    it("gives a late receipt to the parent over a fork that started later", async () => {
      const fixture = await seed();
      const fork = await ownerSession(fixture, "fork", LATER_START);
      const claim = updateClaim("toolu_late", fixture.documentId);
      await syncClaims(fork, fixture.organizationId, [claim]);
      await syncClaims(fixture.sessionId, fixture.organizationId, [claim]);
      const receiptId = await writeReceipt(fixture, {
        clientCallId: "toolu_late",
      });

      await bindAwaitingClaimForReceipt(receiptId, fixture.organizationId);

      expect(await claimRows(fixture.sessionId, fork)).toEqual([
        bound(receiptId),
        duplicate(),
      ]);
    });

    it("settles a receipt the late binder missed by the same rule in the backfill", async () => {
      const fixture = await seed();
      const fork = await ownerSession(fixture, "fork", LATER_START);
      const tiedFork = await ownerSession(fixture, "tied-fork", SAME_START);
      const claim = updateClaim("toolu_missed", fixture.documentId);
      const tiedClaim = updateClaim("toolu_tied_missed", fixture.documentId);
      await syncClaims(fork, fixture.organizationId, [claim]);
      await syncClaims(fixture.sessionId, fixture.organizationId, [
        claim,
        tiedClaim,
      ]);
      await syncClaims(tiedFork, fixture.organizationId, [tiedClaim]);
      const receiptId = await writeReceipt(fixture, {
        clientCallId: "toolu_missed",
      });
      const tiedReceipt = await writeReceipt(fixture, {
        clientCallId: "toolu_tied_missed",
      });

      await runAttributionBackfill({
        organizationId: fixture.organizationId,
        now: BACKFILL_NOW,
      });

      const parent = await evidenceRows(fixture.sessionId);
      expect(parent).toEqual([
        expect.objectContaining({
          claimKey: "claude:toolu_missed",
          receiptId,
        }),
        expect.objectContaining({
          claimKey: "claude:toolu_tied_missed",
          ...contested(tiedReceipt),
        }),
      ]);
      expect(await evidenceRows(fork)).toEqual([
        expect.objectContaining(duplicate()),
      ]);
      expect(await evidenceRows(tiedFork)).toEqual([
        expect.objectContaining(contested(tiedReceipt)),
      ]);
    });
  }
);

async function seed(): Promise<EvidenceFixture> {
  const fixture = await seedEvidenceFixture(tracker);
  organizationIds.push(fixture.organizationId);
  return fixture;
}

/** The claims with a read added, so the resync carries a new digest. */
function grown(fixture: EvidenceFixture, label: string) {
  return [
    updateClaim("toolu_shared", fixture.documentId),
    updateClaim(`toolu_read_${label}`, fixture.documentId, {
      toolName: "get-document",
      operationKind: OperationKind.Read,
    }),
  ];
}

/** Each session's write claim, as its receipt binding reads. */
async function claimRows(...sessionIds: string[]) {
  const rows: {
    receiptId: string | null;
    contestedReceiptId: string | null;
    outcome: string;
  }[] = [];
  for (const sessionId of sessionIds) {
    for (const row of await evidenceRows(sessionId)) {
      if (row.operationKind === OperationKind.UpdateFields) {
        rows.push({
          receiptId: row.receiptId,
          contestedReceiptId: row.contestedReceiptId,
          outcome: row.outcome,
        });
      }
    }
  }
  return rows;
}

function contested(receiptId: string) {
  return {
    receiptId: null,
    contestedReceiptId: receiptId,
    outcome: OperationEvidenceOutcome.Ambiguous,
  };
}

function bound(receiptId: string) {
  return {
    receiptId,
    contestedReceiptId: null,
    outcome: OperationEvidenceOutcome.Committed,
  };
}

function duplicate() {
  return {
    receiptId: null,
    contestedReceiptId: null,
    outcome: OperationEvidenceOutcome.DuplicateInLineage,
  };
}
