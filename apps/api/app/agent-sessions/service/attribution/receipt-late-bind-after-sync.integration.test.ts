/**
 * ISS-12552: a receipt whose late bind could not see its claim, or
 * failed, still binds once the claim's sync commits, against a real Postgres.
 */
import { OperationEvidenceOutcome } from "@repo/api/src/types/attribution-evidence";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteReceipts,
  type EvidenceFixture,
  evidenceRows,
  operationEvidence,
  seedEvidenceFixture,
  syncClaims,
  TRANSACTION_OPTIONS,
  updateClaim,
  writeReceipt,
} from "@/__tests__/support/agent-sessions/attribution/operation-evidence.test-helpers";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import { bindAwaitingClaimForReceipt } from "@/lib/operation-receipts/bind-awaiting-claim";
import { persistSessionOperationEvidence } from "./persist-operation-evidence";
import { settleCommittedSessionEvidence } from "./settle-committed-session-evidence";

const flag = vi.hoisted(() => ({ offOrganizationIds: new Set<string>() }));

/** The attribution flag is on unless a test turns it off for an organization. */
vi.mock("@/lib/attribution-evidence-policy-feature", () => ({
  isAttributionEvidenceEnabledForOrganization: vi.fn(
    async (organizationId: string) =>
      !flag.offOrganizationIds.has(organizationId)
  ),
  evaluateAttributionEvidenceForOrganization: vi.fn(
    async (organizationId: string) =>
      !flag.offOrganizationIds.has(organizationId)
  ),
}));

const tracker = createCommittedTestOrganizationTracker();
const organizationIds: string[] = [];

describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 late binds after the claim's sync commits",
  () => {
    afterEach(async () => {
      flag.offOrganizationIds.clear();
      await deleteReceipts(organizationIds.splice(0));
      await tracker.cleanup();
    });

    it("binds a receipt that committed while the claim's sync transaction was open, once the sync commits", async () => {
      const fixture = await seed();
      const claims = [updateClaim("toolu_raced", fixture.documentId)];
      // Runs outside the sync transaction's async context, so it commits on
      // its own connection while that transaction is still open.
      const receiptWrite = deferred();
      const written = receiptWrite.promise.then(async () => {
        const receiptId = await writeReceipt(fixture, {
          clientCallId: "toolu_raced",
        });
        await bindAwaitingClaimForReceipt(receiptId, fixture.organizationId);
        return receiptId;
      });

      await withDb.tx(async (tx) => {
        await persistSessionOperationEvidence(tx, {
          organizationId: fixture.organizationId,
          agentSessionId: fixture.sessionId,
          evidence: operationEvidence(claims),
          fresh: true,
        });
        receiptWrite.resolve();
        await written;
      }, TRANSACTION_OPTIONS);
      const receiptId = await written;
      expect(await evidenceRows(fixture.sessionId)).toEqual([
        expect.objectContaining({
          receiptId: null,
          outcome: OperationEvidenceOutcome.AwaitingReceipt,
        }),
      ]);

      await settleCommittedSessionEvidence(fixture.organizationId, [
        fixture.sessionId,
      ]);

      expect(await evidenceRows(fixture.sessionId)).toEqual([
        expect.objectContaining({
          receiptId,
          outcome: OperationEvidenceOutcome.Committed,
        }),
      ]);
    });

    it("binds nothing after the sync commits for an organization the flag is off for", async () => {
      const fixture = await seed();
      await syncClaims(fixture.sessionId, fixture.organizationId, [
        updateClaim("toolu_off", fixture.documentId),
      ]);
      await writeReceipt(fixture, { clientCallId: "toolu_off" });
      flag.offOrganizationIds.add(fixture.organizationId);

      await settleCommittedSessionEvidence(fixture.organizationId, [
        fixture.sessionId,
      ]);

      expect(await evidenceRows(fixture.sessionId)).toEqual([
        expect.objectContaining({
          receiptId: null,
          outcome: OperationEvidenceOutcome.AwaitingReceipt,
        }),
      ]);
    });

    it("binds a receipt whose late bind failed when the session next syncs", async () => {
      const fixture = await seed();
      const claims = [updateClaim("toolu_failed_bind", fixture.documentId)];
      await syncClaims(fixture.sessionId, fixture.organizationId, claims);
      // The write committed; its late bind threw, so nothing bound it.
      const receiptId = await writeReceipt(fixture, {
        clientCallId: "toolu_failed_bind",
      });

      await syncClaims(fixture.sessionId, fixture.organizationId, claims);

      expect(await evidenceRows(fixture.sessionId)).toEqual([
        expect.objectContaining({
          receiptId,
          outcome: OperationEvidenceOutcome.Committed,
        }),
      ]);
    });
  }
);

async function seed(): Promise<EvidenceFixture> {
  const fixture = await seedEvidenceFixture(tracker);
  organizationIds.push(fixture.organizationId);
  return fixture;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  const resolvers: (() => void)[] = [];
  const promise = new Promise<void>((settle) => {
    resolvers.push(settle);
  });
  return { promise, resolve: () => resolvers[0]?.() };
}
