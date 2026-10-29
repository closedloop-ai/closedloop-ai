/**
 * ISS-12552: an organization with an owner, a document and sessions, the
 * receipts the API records for the owner's writes, and a sync of a session's
 * operation claims that commits and then runs the ingest's post-commit phase,
 * as `upsertSessionsBatch` does.
 */
import { randomUUID } from "node:crypto";
import {
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
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
import { isCanonicalComputeTarget } from "@repo/lib/attribution/transcript-copies";
import {
  type createCommittedTestOrganizationTracker,
  createTestProject,
  createTestSessionDetail,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { persistSessionOperationEvidence } from "@/app/agent-sessions/service/attribution/persist-operation-evidence";
import { settleCommittedSessionEvidence } from "@/app/agent-sessions/service/attribution/settle-committed-session-evidence";
import { generateSlug } from "@/app/documents/document-utils";

export const EVIDENCE_INVOKED = "2026-10-16T12:00:00.000Z";
export const EVIDENCE_RESULT = "2026-10-16T12:00:05.000Z";
export const EVIDENCE_REQUESTED = new Date("2026-10-16T12:00:01.000Z");
/** Cold-start headroom; the ingest transaction sets its own budget. */
export const TRANSACTION_OPTIONS = { maxWait: 5000, timeout: 20_000 };

export type EvidenceFixture = {
  organizationId: string;
  userId: string;
  sessionId: string;
  documentId: string;
};

export async function seedEvidenceFixture(
  tracker: ReturnType<typeof createCommittedTestOrganizationTracker>
): Promise<EvidenceFixture> {
  const organizationId = await tracker.create();
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

/** Receipts and backfill runs are not in the graph the tracker deletes. */
export async function deleteReceipts(
  organizationIds: readonly string[]
): Promise<void> {
  await withDb(async (db) => {
    await db.artifactOperationReceipt.deleteMany({
      where: { organizationId: { in: [...organizationIds] } },
    });
    await db.attributionBackfillRun.deleteMany({
      where: { organizationId: { in: [...organizationIds] } },
    });
  });
}

export async function writeReceipt(
  fixture: EvidenceFixture,
  extra: {
    clientCallId?: string;
    requestFingerprint?: string;
    principalUserId?: string;
    operationKind?: OperationKind;
    requestedAt?: Date;
    versionNumber?: number;
    changedFields?: string[];
    createdArtifactId?: string;
  }
): Promise<string> {
  const row = await withDb((db) =>
    db.artifactOperationReceipt.create({
      data: {
        id: randomUUID(),
        organizationId: fixture.organizationId,
        principalUserId: extra.principalUserId ?? fixture.userId,
        source: OperationSource.Mcp,
        operationKind: extra.operationKind ?? OperationKind.UpdateFields,
        targetArtifactId: fixture.documentId,
        createdArtifactId: extra.createdArtifactId ?? null,
        outcome: OperationReceiptOutcome.Committed,
        changedFields: extra.changedFields ?? ["fileName"],
        versionNumber: extra.versionNumber ?? null,
        clientCallId: extra.clientCallId ?? null,
        requestFingerprint: extra.requestFingerprint ?? null,
        requestedAt: extra.requestedAt ?? EVIDENCE_REQUESTED,
        committedAt: extra.requestedAt ?? EVIDENCE_REQUESTED,
      },
      select: { id: true },
    })
  );
  return row.id;
}

export function updateClaim(
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
    invokedAt: EVIDENCE_INVOKED,
    resultAt: EVIDENCE_RESULT,
    ...extra,
  };
}

/** Another session of the fixture's owner, started at `startedAt`. */
export function ownerSession(
  fixture: EvidenceFixture,
  label: string,
  startedAt?: Date
): Promise<string> {
  return createTestSessionDetail({
    organizationId: fixture.organizationId,
    userId: fixture.userId,
    label,
    ...(startedAt ? { sessionTimestamp: startedAt } : {}),
  });
}

/** Commits the session's evidence, then runs the ingest's post-commit phase. */
export async function syncClaims(
  sessionId: string,
  organizationId: string,
  claims: readonly OperationClaim[],
  digest?: string
): Promise<void> {
  const persisted = await withDb.tx(
    (tx) =>
      persistSessionOperationEvidence(tx, {
        organizationId,
        agentSessionId: sessionId,
        evidence: operationEvidence(claims, digest),
        fresh: true,
      }),
    TRANSACTION_OPTIONS
  );
  await settleCommittedSessionEvidence(
    organizationId,
    persisted.snapshotWritten ? [sessionId] : [],
    persisted.bindingChangedSessionIds
  );
}

/** A Desktop's evidence payload for the claims; the digest follows them. */
export function operationEvidence(
  claims: readonly OperationClaim[],
  digest?: string
): SessionOperationEvidence {
  return {
    extractorVersion: OPERATION_EVIDENCE_EXTRACTOR_VERSION,
    digest:
      digest ?? JSON.stringify(claims).length.toString(16).padStart(64, "0"),
    coverage: {
      harness: "claude",
      evidencePathSupported: true,
      closedloopMcpCalls: claims.length,
      shellCallsWithOperationIds: 0,
      directApiShellCommands: 0,
      unsupportedToolNames: {},
      claimsDroppedByCap: 0,
    },
    claims: [...claims],
  };
}

export function evidenceRows(sessionId: string) {
  return withDb((db) =>
    db.agentSessionOperationEvidence.findMany({
      where: { agentSessionId: sessionId },
      orderBy: { claimKey: "asc" },
      select: {
        claimKey: true,
        receiptId: true,
        contestedReceiptId: true,
        outcome: true,
        relationshipKind: true,
        unresolvedReason: true,
        targetArtifactId: true,
        operationKind: true,
        providerCallId: true,
        invokedAt: true,
        effectiveAt: true,
        changedFields: true,
        versionNumber: true,
        observedTarget: true,
        source: true,
      },
    })
  );
}

/**
 * Two records of the fixture's session synced from two machines: the same
 * harness and external session id, ordered by compute target id.
 */
export async function copiesOfFixtureSession(
  fixture: EvidenceFixture
): Promise<{ canonical: string; other: string }> {
  const second = await ownerSession(fixture, "copy");
  const details = await withDb(async (db) => {
    const source = await db.sessionDetail.findUniqueOrThrow({
      where: { artifactId: fixture.sessionId },
      select: { externalSessionId: true },
    });
    await db.sessionDetail.update({
      where: { artifactId: second },
      data: { externalSessionId: source.externalSessionId },
      select: { artifactId: true },
    });
    return db.sessionDetail.findMany({
      where: { artifactId: { in: [fixture.sessionId, second] } },
      select: { artifactId: true, computeTargetId: true },
    });
  });
  const [canonical, other] = [...details].sort((a, b) =>
    isCanonicalComputeTarget(a.computeTargetId, b.computeTargetId) ? -1 : 1
  );
  if (!(canonical && other)) {
    throw new Error("both copies must exist");
  }
  return { canonical: canonical.artifactId, other: other.artifactId };
}

/** A document of the fixture's owner, for a create receipt to name. */
export async function ownerDocument(fixture: EvidenceFixture): Promise<string> {
  const document = await withDb((db) =>
    db.artifact.create({
      data: {
        name: "Created plan",
        slug: generateSlug(),
        type: ArtifactType.DOCUMENT,
        subtype: ArtifactSubtype.PRD,
        status: DocumentStatus.Draft,
        organizationId: fixture.organizationId,
        createdById: fixture.userId,
      },
      select: { id: true },
    })
  );
  return document.id;
}
