/**
 * ISS-12552: a shell claim whose printed operation id never binds is
 * finalized a day after its call, as an MCP write is, so its session's resync
 * with the same digest is a no-op, against a real Postgres.
 */
import { OperationEvidenceOutcome } from "@repo/api/src/types/attribution-evidence";
import { OperationClaimSource } from "@repo/api/src/types/operation-claims";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteReceipts,
  EVIDENCE_INVOKED,
  EVIDENCE_RESULT,
  type EvidenceFixture,
  evidenceRows,
  seedEvidenceFixture,
  syncClaims,
} from "@/__tests__/support/agent-sessions/attribution/operation-evidence.test-helpers";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import { runAttributionBackfill } from "./attribution-backfill";

/** The organization's attribution flag is on. */
vi.mock("@/lib/attribution-evidence-policy-feature", () => ({
  isAttributionEvidenceEnabledForOrganization: vi.fn(async () => true),
  evaluateAttributionEvidenceForOrganization: vi.fn(async () => true),
}));

const tracker = createCommittedTestOrganizationTracker();
const organizationIds: string[] = [];
const DIGEST = "d".repeat(64);
/** A day and an hour after the call. */
const DAY_LATER = new Date(Date.parse(EVIDENCE_INVOKED) + 25 * 60 * 60_000);
/** An unknown operation id: it never names a receipt. */
const UNKNOWN_OPERATION_ID = "clop_01a16100-0000-7000-8000-000000000000";

describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 a shell claim that never binds",
  () => {
    afterEach(async () => {
      await deleteReceipts(organizationIds.splice(0));
      await tracker.cleanup();
    });

    it("is finalized a day after its call, and a resync with the same digest leaves its rows alone", async () => {
      const fixture = await seed();
      const claims = [
        {
          claimKey: "claude:toolu_shell",
          providerCallId: "toolu_shell",
          source: OperationClaimSource.Shell,
          operationIds: [UNKNOWN_OPERATION_ID],
          invokedAt: EVIDENCE_INVOKED,
          resultAt: EVIDENCE_RESULT,
        },
      ];
      await syncClaims(
        fixture.sessionId,
        fixture.organizationId,
        claims,
        DIGEST
      );

      const outcome = await runAttributionBackfill({
        organizationId: fixture.organizationId,
        now: DAY_LATER,
      });
      const finalized = await rowIds(fixture.sessionId);
      await syncClaims(
        fixture.sessionId,
        fixture.organizationId,
        claims,
        DIGEST
      );

      expect(outcome.counts.finalized).toBe(1);
      expect(await evidenceRows(fixture.sessionId)).toEqual([
        expect.objectContaining({
          receiptId: null,
          outcome: OperationEvidenceOutcome.MissingResult,
        }),
      ]);
      expect(await rowIds(fixture.sessionId)).toEqual(finalized);
    });
  }
);

async function seed(): Promise<EvidenceFixture> {
  const fixture = await seedEvidenceFixture(tracker);
  organizationIds.push(fixture.organizationId);
  return fixture;
}

async function rowIds(sessionId: string): Promise<string[]> {
  const rows = await withDb((db) =>
    db.agentSessionOperationEvidence.findMany({
      where: { agentSessionId: sessionId },
      orderBy: { id: "asc" },
      select: { id: true },
    })
  );
  return rows.map((row) => row.id);
}
