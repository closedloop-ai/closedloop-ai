/**
 * ISS-12552 (PRD-800 "Proving usage"): a receipt both copies of one
 * session could bind goes to the copy on the lowest compute target id, at
 * sync as well as at receipt write, against a real Postgres.
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
  ToolResultState,
} from "@repo/api/src/types/operation-claims";
import { ArtifactSubtype, ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCommittedTestOrganizationTracker,
  createTestProject,
  createTestSessionDetail,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { generateSlug } from "@/app/documents/document-utils";
import { bindAwaitingClaimForReceipt } from "@/lib/operation-receipts/bind-awaiting-claim";
import { persistSessionOperationEvidence } from "./persist-operation-evidence";

/** The flag is on for binding (PRD-800); the link sync reads it as off. */
vi.mock("@/lib/attribution-evidence-policy-feature", () => ({
  isAttributionEvidenceEnabledForOrganization: vi.fn(async () => true),
  evaluateAttributionEvidenceForOrganization: vi.fn(async () => false),
}));

const tracker = createCommittedTestOrganizationTracker();
const organizationIds: string[] = [];
/** Cold-start headroom; the ingest transaction sets its own budget. */
const TRANSACTION_OPTIONS = { maxWait: 5000, timeout: 20_000 };
const INVOKED = "2026-10-16T12:00:00.000Z";
const RESULT = "2026-10-16T12:00:05.000Z";
const REQUESTED = new Date("2026-10-16T12:00:01.000Z");

describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 receipts across copies of one session",
  () => {
    afterEach(async () => {
      const ids = organizationIds.splice(0);
      await withDb((db) =>
        db.artifactOperationReceipt.deleteMany({
          where: { organizationId: { in: ids } },
        })
      );
      await tracker.cleanup();
    });

    it("binds a receipt the canonical copy waits on to that copy when the other copy syncs after it commits", async () => {
      const fixture = await seed();
      const claim = updateClaim("toolu_copied", fixture.documentId);
      await sync(fixture, fixture.canonical, [claim]);
      const receiptId = await receipt(fixture, {
        clientCallId: "toolu_copied",
      });

      await sync(fixture, fixture.other, [claim]);

      expect(await evidence(fixture.canonical)).toEqual([
        { receiptId, outcome: OperationEvidenceOutcome.Committed },
      ]);
      expect(await evidence(fixture.other)).toEqual([
        {
          receiptId: null,
          outcome: OperationEvidenceOutcome.DuplicateInLineage,
        },
      ]);
    });

    it("binds nothing when more copies than the candidate limit wait on a late fingerprint receipt", async () => {
      // A literal, one past the late binder's limit of 50, so raising the limit fails this.
      const fixture = await seed(51);
      const fingerprint = "f".repeat(64);
      await waitingFingerprintClaims(fixture, fingerprint);
      const late = await receipt(fixture, { requestFingerprint: fingerprint });

      await bindAwaitingClaimForReceipt(late, fixture.organizationId);

      expect(
        await withDb((db) =>
          db.agentSessionOperationEvidence.count({
            where: { receiptId: late },
          })
        )
      ).toBe(0);
    });
  }
);

type Fixture = {
  organizationId: string;
  userId: string;
  documentId: string;
  /** The copy on the compute target id that sorts first. */
  canonical: string;
  other: string;
  /** Every copy, ordered by compute target id. */
  copies: string[];
};

/** Copies of one session, one per compute target (two unless asked). */
async function seed(copyCount = 2): Promise<Fixture> {
  const organizationId = await tracker.create();
  organizationIds.push(organizationId);
  const user = await createTestUser(organizationId);
  const projectId = await createTestProject(organizationId, user.id);
  const sessions: string[] = [];
  for (let index = 0; index < copyCount; index++) {
    sessions.push(
      await createTestSessionDetail({
        organizationId,
        userId: user.id,
        label: `copy-${index}`,
      })
    );
  }
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
  const externalSessionId = `ext-copied-${randomUUID()}`;
  const details = await withDb(async (db) => {
    await db.sessionDetail.updateMany({
      where: { artifactId: { in: sessions } },
      data: { externalSessionId },
    });
    return db.sessionDetail.findMany({
      where: { artifactId: { in: sessions } },
      orderBy: { computeTargetId: "asc" },
      select: { artifactId: true },
    });
  });
  const copies = details.map((row) => row.artifactId);
  const [canonical, other] = copies;
  if (!(canonical && other)) {
    throw new Error("expected two copies");
  }
  return {
    organizationId,
    userId: user.id,
    documentId: document.id,
    canonical,
    other,
    copies,
  };
}

/** One waiting fingerprint-only write claim on each copy, inside the receipt's window. */
async function waitingFingerprintClaims(
  fixture: Fixture,
  fingerprint: string
): Promise<void> {
  await withDb((db) =>
    db.agentSessionOperationEvidence.createMany({
      data: fixture.copies.map((agentSessionId) => ({
        organizationId: fixture.organizationId,
        agentSessionId,
        claimKey: "claude:toolu_fingerprinted",
        targetArtifactId: fixture.documentId,
        relationshipKind: AttributionRelationshipKind.Unresolved,
        unresolvedReason: UnresolvedReason.AwaitingReceipt,
        outcome: OperationEvidenceOutcome.AwaitingReceipt,
        operationKind: OperationKind.UpdateFields,
        source: OperationSource.Mcp,
        requestFingerprint: fingerprint,
        invokedAt: new Date(INVOKED),
        anchors: { resultAt: RESULT },
        extractorVersion: 1,
        policyVersion: 1,
      })),
    })
  );
}

async function receipt(
  fixture: Fixture,
  extra: { clientCallId?: string; requestFingerprint?: string }
): Promise<string> {
  const row = await withDb((db) =>
    db.artifactOperationReceipt.create({
      data: {
        organizationId: fixture.organizationId,
        principalUserId: fixture.userId,
        source: OperationSource.Mcp,
        operationKind: OperationKind.UpdateFields,
        targetArtifactId: fixture.documentId,
        outcome: OperationReceiptOutcome.Committed,
        changedFields: ["fileName"],
        clientCallId: extra.clientCallId ?? null,
        requestFingerprint: extra.requestFingerprint ?? null,
        requestedAt: REQUESTED,
        committedAt: REQUESTED,
      },
      select: { id: true },
    })
  );
  return row.id;
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

/** The ingest persist step for one copy, without the late binder. */
async function sync(
  fixture: Fixture,
  agentSessionId: string,
  claims: OperationClaim[]
): Promise<void> {
  await withDb.tx(
    (tx) =>
      persistSessionOperationEvidence(tx, {
        organizationId: fixture.organizationId,
        agentSessionId,
        fresh: true,
        evidence: {
          extractorVersion: OPERATION_EVIDENCE_EXTRACTOR_VERSION,
          digest: randomUUID().replaceAll("-", "").padStart(64, "0"),
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
        },
      }),
    TRANSACTION_OPTIONS
  );
}

function evidence(agentSessionId: string) {
  return withDb((db) =>
    db.agentSessionOperationEvidence.findMany({
      where: { agentSessionId },
      orderBy: { claimKey: "asc" },
      select: { receiptId: true, outcome: true },
    })
  );
}
