/**
 * ISS-12552: reconciliation against a real Postgres. A
 * session binds only its own owner's receipts in its own organization; a
 * committed timeout and a retry each bind once; a receipt written after the
 * claim synced binds when it is written; the first claim in a lineage keeps a
 * shared receipt; an unchanged snapshot is a no-op.
 */
import { randomUUID } from "node:crypto";
import {
  AttributionRelationshipKind,
  OperationEvidenceOutcome,
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
  UnresolvedReason,
} from "@repo/api/src/types/attribution-evidence";
import { DocumentStatus } from "@repo/api/src/types/document";
import {
  OPERATION_EVIDENCE_EXTRACTOR_VERSION,
  type OperationClaim,
  OperationClaimSource,
  type SessionOperationEvidence,
  ToolResultState,
} from "@repo/api/src/types/operation-claims";
import { ArtifactSubtype, ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { FINGERPRINT_WINDOW_MS } from "@repo/lib/attribution/receipt-outcome";
import { requestKeyFor } from "@repo/lib/harness/request-key";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCommittedTestOrganizationTracker,
  createTestProject,
  createTestSessionDetail,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { generateSlug } from "@/app/documents/document-utils";
import {
  bindAwaitingClaimForReceipt,
  FINGERPRINT_CANDIDATE_LIMIT,
} from "@/lib/operation-receipts/bind-awaiting-claim";
import { persistSessionOperationEvidence } from "./persist-operation-evidence";
import { syncSessionEvidenceLinks } from "./session-evidence-links";

const flag = vi.hoisted(() => ({
  offOrganizationIds: new Set<string>(),
  linksOn: false,
}));

/**
 * Sync reconciliation is flag-independent and the link sync needs an answer:
 * off unless a case turns it on. The late binder reads the organization's
 * answer (PRD-800 "Rollout").
 */
vi.mock("@/lib/attribution-evidence-policy-feature", () => ({
  evaluateAttributionEvidenceForOrganization: vi.fn(async () => flag.linksOn),
  isAttributionEvidenceEnabledForOrganization: vi.fn(
    async (organizationId: string) =>
      !flag.offOrganizationIds.has(organizationId)
  ),
}));

const tracker = createCommittedTestOrganizationTracker();
/** Cold-start headroom; the ingest transaction sets its own budget. */
const TRANSACTION_OPTIONS = { maxWait: 5000, timeout: 20_000 };
const organizationIds: string[] = [];
const INVOKED = "2026-10-16T12:00:00.000Z";
const RESULT = "2026-10-16T12:00:05.000Z";
const REQUESTED = new Date("2026-10-16T12:00:01.000Z");
/** Reconciliation reads the session owner, never the sync caller. */

describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 operation claim reconciliation",
  () => {
    afterEach(async () => {
      flag.offOrganizationIds.clear();
      flag.linksOn = false;
      const ids = organizationIds.splice(0);
      await withDb((db) =>
        db.artifactOperationReceipt.deleteMany({
          where: { organizationId: { in: ids } },
        })
      );
      await tracker.cleanup();
    });

    it("binds only the owner's receipts in the session's own organization", async () => {
      const fixture = await seed();
      const other = await createTestUser(fixture.organizationId);
      const foreignOrganizationId = await tracker.create();
      organizationIds.push(foreignOrganizationId);
      const foreignUser = await createTestUser(foreignOrganizationId);
      await receipt(fixture, { clientCallId: "toolu_own" });
      await receipt(fixture, {
        clientCallId: "toolu_other_user",
        principalUserId: other.id,
      });
      await receipt(fixture, {
        clientCallId: "toolu_other_org",
        organizationId: foreignOrganizationId,
        principalUserId: foreignUser.id,
      });

      await sync(fixture.sessionId, fixture.organizationId, [
        updateClaim("toolu_own", fixture.documentId),
        updateClaim("toolu_other_user", fixture.documentId),
        updateClaim("toolu_other_org", fixture.documentId),
      ]);

      expect(await rows(fixture.sessionId)).toEqual([
        expect.objectContaining({
          claimKey: "claude:toolu_other_org",
          receiptId: null,
          outcome: OperationEvidenceOutcome.AwaitingReceipt,
          relationshipKind: AttributionRelationshipKind.Unresolved,
        }),
        expect.objectContaining({
          claimKey: "claude:toolu_other_user",
          receiptId: null,
          outcome: OperationEvidenceOutcome.AwaitingReceipt,
        }),
        expect.objectContaining({
          claimKey: "claude:toolu_own",
          outcome: OperationEvidenceOutcome.Committed,
          relationshipKind: AttributionRelationshipKind.Revision,
          targetArtifactId: fixture.documentId,
          changedFields: ["fileName"],
          source: OperationSource.Mcp,
        }),
      ]);
    });

    it("binds no receipt the session owner made in another organization", async () => {
      const fixture = await seed();
      const foreignOrganizationId = await tracker.create();
      organizationIds.push(foreignOrganizationId);
      await receipt(fixture, {
        clientCallId: "toolu_same_user_other_org",
        organizationId: foreignOrganizationId,
      });

      await sync(fixture.sessionId, fixture.organizationId, [
        updateClaim("toolu_same_user_other_org", fixture.documentId),
      ]);

      expect(await rows(fixture.sessionId)).toEqual([
        expect.objectContaining({
          claimKey: "claude:toolu_same_user_other_org",
          receiptId: null,
          outcome: OperationEvidenceOutcome.AwaitingReceipt,
        }),
      ]);
    });

    it("never turns the caller's own comment receipt into a creation of another member's document", async () => {
      const fixture = await seed();
      const victimDocumentId = await otherMembersDocument(fixture);
      await receipt(fixture, {
        clientCallId: "toolu_forged",
        operationKind: OperationKind.Comment,
      });

      await sync(fixture.sessionId, fixture.organizationId, [
        createClaim("toolu_forged", victimDocumentId),
      ]);

      expect(await rows(fixture.sessionId)).toEqual([
        expect.objectContaining({
          claimKey: "claude:toolu_forged",
          receiptId: null,
          outcome: OperationEvidenceOutcome.AwaitingReceipt,
          relationshipKind: AttributionRelationshipKind.Unresolved,
        }),
      ]);
    });

    it("binds no late receipt of another operation to a waiting claim", async () => {
      const fixture = await seed();
      const victimDocumentId = await otherMembersDocument(fixture);
      await sync(fixture.sessionId, fixture.organizationId, [
        createClaim("toolu_late_forged", victimDocumentId),
      ]);
      const late = await receipt(fixture, {
        clientCallId: "toolu_late_forged",
        operationKind: OperationKind.Comment,
      });

      await bindAwaitingClaimForReceipt(late, fixture.organizationId);

      expect(await rows(fixture.sessionId)).toEqual([
        expect.objectContaining({
          claimKey: "claude:toolu_late_forged",
          receiptId: null,
          outcome: OperationEvidenceOutcome.AwaitingReceipt,
        }),
      ]);
    });

    it("binds a committed timeout once, and each retry to its own receipt", async () => {
      const fixture = await seed();
      const first = await receipt(fixture, { clientCallId: "toolu_timeout" });
      const second = await receipt(fixture, { clientCallId: "toolu_retry" });

      await sync(fixture.sessionId, fixture.organizationId, [
        updateClaim("toolu_timeout", fixture.documentId, {
          resultState: ToolResultState.Error,
        }),
        updateClaim("toolu_retry", fixture.documentId),
      ]);

      expect(
        (await rows(fixture.sessionId)).map((row) => [
          row.claimKey,
          row.receiptId,
          row.outcome,
        ])
      ).toEqual([
        ["claude:toolu_retry", second, OperationEvidenceOutcome.Committed],
        ["claude:toolu_timeout", first, OperationEvidenceOutcome.Committed],
      ]);
    });

    it("binds no late receipt another member's call wrote to the owner's waiting claim", async () => {
      const fixture = await seed();
      const other = await createTestUser(fixture.organizationId);
      await sync(fixture.sessionId, fixture.organizationId, [
        updateClaim("toolu_late_other", fixture.documentId),
      ]);
      const late = await receipt(fixture, {
        clientCallId: "toolu_late_other",
        principalUserId: other.id,
      });

      await bindAwaitingClaimForReceipt(late, fixture.organizationId);

      expect(await rows(fixture.sessionId)).toEqual([
        expect.objectContaining({
          claimKey: "claude:toolu_late_other",
          receiptId: null,
          outcome: OperationEvidenceOutcome.AwaitingReceipt,
        }),
      ]);
    });

    it("binds no receipt of another member's that a shell command printed", async () => {
      const fixture = await seed();
      const other = await createTestUser(fixture.organizationId);
      const theirs = await receipt(fixture, {
        clientCallId: "toolu_theirs",
        principalUserId: other.id,
      });

      await sync(fixture.sessionId, fixture.organizationId, [
        {
          claimKey: "claude:toolu_shell",
          providerCallId: "toolu_shell",
          source: OperationClaimSource.Shell,
          operationIds: [`clop_${theirs}`],
          invokedAt: INVOKED,
          resultAt: RESULT,
        },
      ]);

      expect(await rows(fixture.sessionId)).toEqual([
        expect.objectContaining({
          claimKey: "claude:toolu_shell",
          receiptId: null,
        }),
      ]);
    });

    it("binds the one in-window claim among a full page of stale claims with its fingerprint", async () => {
      const fixture = await seed();
      const fingerprint = "f".repeat(64);
      const longBefore = new Date(
        REQUESTED.getTime() - 2 * FINGERPRINT_WINDOW_MS
      ).toISOString();
      await sync(fixture.sessionId, fixture.organizationId, [
        updateClaim("toolu_in_window", fixture.documentId, {
          requestFingerprint: fingerprint,
        }),
        ...Array.from({ length: FINGERPRINT_CANDIDATE_LIMIT }, (_, index) =>
          updateClaim(`toolu_stale_${index}`, fixture.documentId, {
            requestFingerprint: fingerprint,
            invokedAt: longBefore,
            resultAt: longBefore,
          })
        ),
      ]);
      const late = await receipt(fixture, { requestFingerprint: fingerprint });

      await bindAwaitingClaimForReceipt(late, fixture.organizationId);

      const bound = await withDb((db) =>
        db.agentSessionOperationEvidence.findMany({
          where: { receiptId: late },
          select: { claimKey: true },
        })
      );
      expect(bound).toEqual([{ claimKey: "claude:toolu_in_window" }]);
    });

    it("binds no fingerprint claim whose anchored result time is not a timestamp", async () => {
      const fixture = await seed();
      const fingerprint = "f".repeat(64);
      await sync(fixture.sessionId, fixture.organizationId, [
        updateClaim("toolu_unreadable_result", fixture.documentId, {
          requestFingerprint: fingerprint,
          resultAt: "not a time",
        }),
      ]);
      const late = await receipt(fixture, { requestFingerprint: fingerprint });

      await bindAwaitingClaimForReceipt(late, fixture.organizationId);

      const bound = await withDb((db) =>
        db.agentSessionOperationEvidence.count({ where: { receiptId: late } })
      );
      expect(bound).toBe(0);
    });

    it("binds a fingerprint receipt requested after the call's start window but inside its result window", async () => {
      const fixture = await seed();
      const fingerprint = "f".repeat(64);
      const invokedAt = Date.parse(INVOKED);
      await sync(fixture.sessionId, fixture.organizationId, [
        updateClaim("toolu_long_call", fixture.documentId, {
          requestFingerprint: fingerprint,
          resultAt: new Date(invokedAt + 10 * 60_000).toISOString(),
        }),
      ]);
      const late = await receipt(fixture, {
        requestFingerprint: fingerprint,
        requestedAt: new Date(invokedAt + FINGERPRINT_WINDOW_MS + 60_000),
      });

      await bindAwaitingClaimForReceipt(late, fixture.organizationId);

      const bound = await withDb((db) =>
        db.agentSessionOperationEvidence.findMany({
          where: { receiptId: late },
          select: { claimKey: true },
        })
      );
      expect(bound).toEqual([{ claimKey: "claude:toolu_long_call" }]);
    });

    it("keeps the request a claim names on its evidence row (PRD-800)", async () => {
      const fixture = await seed();
      const requestKey = requestKeyFor(
        "claude.transcript.entry.uuid",
        "line-1"
      );

      await sync(fixture.sessionId, fixture.organizationId, [
        updateClaim("toolu_requested", fixture.documentId, { requestKey }),
      ]);

      const stored = await withDb((db) =>
        db.agentSessionOperationEvidence.findFirst({
          where: { agentSessionId: fixture.sessionId },
          select: { anchors: true },
        })
      );
      expect(stored?.anchors).toMatchObject({ requestKey });
    });

    it("binds a receipt written after its claim synced, when it is written", async () => {
      const fixture = await seed();
      await sync(fixture.sessionId, fixture.organizationId, [
        updateClaim("toolu_late", fixture.documentId),
      ]);
      const late = await receipt(fixture, { clientCallId: "toolu_late" });

      await bindAwaitingClaimForReceipt(late, fixture.organizationId);

      expect(await rows(fixture.sessionId)).toEqual([
        expect.objectContaining({
          receiptId: late,
          outcome: OperationEvidenceOutcome.Committed,
          relationshipKind: AttributionRelationshipKind.Revision,
          unresolvedReason: null,
        }),
      ]);
    });

    it("late-binds a receipt only in the organization the flag is on for", async () => {
      const off = await seed();
      flag.offOrganizationIds.add(off.organizationId);
      const on = await seed();
      for (const fixture of [off, on]) {
        await sync(fixture.sessionId, fixture.organizationId, [
          updateClaim("toolu_late", fixture.documentId),
        ]);
      }
      const offReceipt = await receipt(off, { clientCallId: "toolu_late" });
      const onReceipt = await receipt(on, { clientCallId: "toolu_late" });

      await bindAwaitingClaimForReceipt(offReceipt, off.organizationId);
      await bindAwaitingClaimForReceipt(onReceipt, on.organizationId);

      expect(await rows(off.sessionId)).toEqual([
        expect.objectContaining({
          receiptId: null,
          outcome: OperationEvidenceOutcome.AwaitingReceipt,
        }),
      ]);
      expect(await rows(on.sessionId)).toEqual([
        expect.objectContaining({
          receiptId: onReceipt,
          outcome: OperationEvidenceOutcome.Committed,
        }),
      ]);
    });

    it("leaves a shared receipt with the lineage's earliest claim", async () => {
      const fixture = await seed();
      const fork = await createTestSessionDetail({
        organizationId: fixture.organizationId,
        userId: fixture.userId,
        label: "fork",
      });
      const shared = await receipt(fixture, { clientCallId: "toolu_shared" });

      await sync(fork, fixture.organizationId, [
        updateClaim("toolu_shared", fixture.documentId, {
          invokedAt: "2026-10-16T12:30:00.000Z",
          resultAt: "2026-10-16T12:30:05.000Z",
        }),
      ]);
      await sync(fixture.sessionId, fixture.organizationId, [
        updateClaim("toolu_shared", fixture.documentId),
      ]);

      expect((await rows(fixture.sessionId))[0]?.receiptId).toBe(shared);
      expect(await rows(fork)).toEqual([
        expect.objectContaining({
          receiptId: null,
          outcome: OperationEvidenceOutcome.DuplicateInLineage,
          unresolvedReason: UnresolvedReason.DuplicateInLineage,
        }),
      ]);
    });

    it("gives a shared receipt to neither of two claims invoked at the same instant", async () => {
      const fixture = await seed();
      const copy = await createTestSessionDetail({
        organizationId: fixture.organizationId,
        userId: fixture.userId,
        label: "copy",
      });
      await receipt(fixture, { clientCallId: "toolu_tied" });

      await sync(copy, fixture.organizationId, [
        updateClaim("toolu_tied", fixture.documentId),
      ]);
      await sync(fixture.sessionId, fixture.organizationId, [
        updateClaim("toolu_tied", fixture.documentId),
      ]);

      for (const session of [copy, fixture.sessionId]) {
        expect(await rows(session)).toEqual([
          expect.objectContaining({
            receiptId: null,
            outcome: OperationEvidenceOutcome.Ambiguous,
            relationshipKind: AttributionRelationshipKind.Unresolved,
          }),
        ]);
      }
    });

    it("keeps a tie through a resync of either side with a new digest", async () => {
      const fixture = await seed();
      const fork = await createTestSessionDetail({
        organizationId: fixture.organizationId,
        userId: fixture.userId,
        label: "fork",
      });
      const tied = await receipt(fixture, { clientCallId: "toolu_tied" });
      await sync(fork, fixture.organizationId, [
        updateClaim("toolu_tied", fixture.documentId),
      ]);
      await sync(fixture.sessionId, fixture.organizationId, [
        updateClaim("toolu_tied", fixture.documentId),
      ]);
      const grown = (callId: string) => [
        updateClaim("toolu_tied", fixture.documentId),
        updateClaim(callId, fixture.documentId, {
          toolName: "get-document",
          operationKind: OperationKind.Read,
        }),
      ];
      const tiedRow = async (session: string) =>
        (await rows(session)).find(
          (row) => row.claimKey === "claude:toolu_tied"
        );
      const stillTied = expect.objectContaining({
        receiptId: null,
        outcome: OperationEvidenceOutcome.Ambiguous,
      });

      await sync(
        fixture.sessionId,
        fixture.organizationId,
        grown("toolu_read_one")
      );
      expect(await tiedRow(fixture.sessionId)).toEqual(stillTied);
      expect(await tiedRow(fork)).toEqual(stillTied);

      await sync(fork, fixture.organizationId, grown("toolu_read_two_more"));
      expect(await tiedRow(fixture.sessionId)).toEqual(stillTied);
      expect(await tiedRow(fork)).toEqual(stillTied);
      const bound = await withDb((db) =>
        db.agentSessionOperationEvidence.count({ where: { receiptId: tied } })
      );
      expect(bound).toBe(0);
    });

    it("treats a resync with the same digest as a no-op once every claim is resolved", async () => {
      // With the flag off the links digest stays stale, so a resync rebuilds.
      flag.linksOn = true;
      const fixture = await seed();
      await receipt(fixture, { clientCallId: "toolu_same" });
      const claims = [updateClaim("toolu_same", fixture.documentId)];
      await sync(fixture.sessionId, fixture.organizationId, claims);
      const before = await rowIds(fixture.sessionId);

      await sync(fixture.sessionId, fixture.organizationId, claims);

      expect(await rowIds(fixture.sessionId)).toEqual(before);
    });

    it("ingests a claim an earlier parse dropped once the same snapshot is readable", async () => {
      const fixture = await seed();
      const digest = "f".repeat(64);
      await receipt(fixture, { clientCallId: "toolu_unparsed" });
      await sync(fixture.sessionId, fixture.organizationId, [], {
        digest,
        unparsedClaims: 1,
      });

      await sync(
        fixture.sessionId,
        fixture.organizationId,
        [updateClaim("toolu_unparsed", fixture.documentId)],
        { digest, unparsedClaims: 0 }
      );

      expect(await rows(fixture.sessionId)).toEqual([
        expect.objectContaining({
          claimKey: "claude:toolu_unparsed",
          outcome: OperationEvidenceOutcome.Committed,
        }),
      ]);
    });

    it("binds a receipt written since, on a resync with the same digest", async () => {
      const fixture = await seed();
      const claims = [updateClaim("toolu_same", fixture.documentId)];
      await sync(fixture.sessionId, fixture.organizationId, claims);
      const late = await receipt(fixture, { clientCallId: "toolu_same" });

      await sync(fixture.sessionId, fixture.organizationId, claims);

      expect(await rows(fixture.sessionId)).toEqual([
        expect.objectContaining({
          claimKey: "claude:toolu_same",
          receiptId: late,
          outcome: OperationEvidenceOutcome.Committed,
          relationshipKind: AttributionRelationshipKind.Revision,
        }),
      ]);
    });
  }
);

type Fixture = {
  organizationId: string;
  userId: string;
  sessionId: string;
  documentId: string;
};

async function seed(): Promise<Fixture> {
  const organizationId = await tracker.create();
  organizationIds.push(organizationId);
  const user = await createTestUser(organizationId);
  const projectId = await createTestProject(organizationId, user.id);
  const sessionId = await createTestSessionDetail({
    organizationId,
    userId: user.id,
    label: "owner",
  });
  const document = await withDb((db) =>
    db.artifact.create({
      data: {
        name: "Plan",
        slug: generateSlug(),
        type: ArtifactType.DOCUMENT,
        subtype: ArtifactSubtype.PRD,
        status: DocumentStatus.Draft,
        organizationId,
        createdById: user.id,
        projectId,
      },
      select: { id: true },
    })
  );
  return {
    organizationId,
    userId: user.id,
    sessionId,
    documentId: document.id,
  };
}

async function receipt(
  fixture: Fixture,
  extra: {
    clientCallId?: string;
    requestFingerprint?: string;
    organizationId?: string;
    principalUserId?: string;
    operationKind?: OperationKind;
    requestedAt?: Date;
  }
): Promise<string> {
  const row = await withDb((db) =>
    db.artifactOperationReceipt.create({
      data: {
        id: randomUUID(),
        organizationId: extra.organizationId ?? fixture.organizationId,
        principalUserId: extra.principalUserId ?? fixture.userId,
        source: OperationSource.Mcp,
        operationKind: extra.operationKind ?? OperationKind.UpdateFields,
        targetArtifactId: fixture.documentId,
        outcome: OperationReceiptOutcome.Committed,
        changedFields: ["fileName"],
        clientCallId: extra.clientCallId ?? null,
        requestFingerprint: extra.requestFingerprint ?? null,
        requestedAt: extra.requestedAt ?? REQUESTED,
        committedAt: REQUESTED,
      },
      select: { id: true },
    })
  );
  return row.id;
}

function createClaim(callId: string, documentId: string): OperationClaim {
  return updateClaim(callId, documentId, {
    toolName: "create-document",
    operationKind: OperationKind.Create,
  });
}

async function otherMembersDocument(fixture: Fixture): Promise<string> {
  const member = await createTestUser(fixture.organizationId);
  const document = await withDb((db) =>
    db.artifact.create({
      data: {
        name: "Their plan",
        slug: generateSlug(),
        type: ArtifactType.DOCUMENT,
        subtype: ArtifactSubtype.PRD,
        status: DocumentStatus.Draft,
        organizationId: fixture.organizationId,
        createdById: member.id,
      },
      select: { id: true },
    })
  );
  return document.id;
}

function updateClaim(
  callId: string,
  documentId: string,
  extra: Partial<OperationClaim> = {}
): OperationClaim {
  return {
    claimKey: `claude:${callId}`,
    providerCallId: callId,
    source: OperationClaimSource.ClosedloopMcp,
    toolName: "update-document",
    operationKind: OperationKind.UpdateFields,
    resultState: ToolResultState.Present,
    inputTargets: [{ key: "documentId", uuid: documentId }],
    invokedAt: INVOKED,
    resultAt: RESULT,
    ...extra,
  };
}

async function sync(
  sessionId: string,
  organizationId: string,
  claims: OperationClaim[],
  /** A Desktop resend keeps its digest; the server's parse may drop claims. */
  resend?: { digest: string; unparsedClaims: number }
): Promise<void> {
  const evidence: SessionOperationEvidence & { unparsedClaims?: number } = {
    ...(resend ? { unparsedClaims: resend.unparsedClaims } : {}),
    extractorVersion: OPERATION_EVIDENCE_EXTRACTOR_VERSION,
    digest:
      resend?.digest ??
      JSON.stringify(claims).length.toString(16).padStart(64, "0"),
    coverage: {
      harness: "claude",
      evidencePathSupported: true,
      closedloopMcpCalls: claims.length,
      shellCallsWithOperationIds: 0,
      directApiShellCommands: 0,
      unsupportedToolNames: {},
      claimsDroppedByCap: 0,
    },
    claims,
  };
  await withDb.tx(
    (tx) =>
      persistSessionOperationEvidence(tx, {
        organizationId,
        agentSessionId: sessionId,
        evidence,
        fresh: true,
      }),
    TRANSACTION_OPTIONS
  );
  // Ingest syncs the links after the slice commits.
  await syncSessionEvidenceLinks(organizationId, [sessionId]);
}

async function rowIds(sessionId: string): Promise<string[]> {
  const found = await withDb((db) =>
    db.agentSessionOperationEvidence.findMany({
      where: { agentSessionId: sessionId },
      orderBy: { id: "asc" },
      select: { id: true },
    })
  );
  return found.map((row) => row.id);
}

function rows(sessionId: string) {
  return withDb((db) =>
    db.agentSessionOperationEvidence.findMany({
      where: { agentSessionId: sessionId },
      orderBy: { claimKey: "asc" },
      select: {
        claimKey: true,
        receiptId: true,
        outcome: true,
        relationshipKind: true,
        unresolvedReason: true,
        targetArtifactId: true,
        changedFields: true,
        source: true,
      },
    })
  );
}
