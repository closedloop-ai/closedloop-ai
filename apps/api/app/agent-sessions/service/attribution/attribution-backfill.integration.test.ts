/**
 * ISS-12552: the historical backfill against a real
 * Postgres. A late receipt binds, an owner's document version corroborates a
 * pre-receipt write while another user's does not, a session with no synced
 * evidence is counted, a second run changes nothing, and a run interrupted
 * mid-cursor resumes to the same result. Each test walks only its own
 * organization.
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
import {
  AttributionBackfillStatus,
  runAttributionBackfill,
} from "./attribution-backfill";
import { persistSessionOperationEvidence } from "./persist-operation-evidence";
import { syncSessionEvidenceLinks } from "./session-evidence-links";

const flag = vi.hoisted(() => ({ linksOn: false }));

/**
 * The backfill's evidence is flag-independent; the link sync needs an answer:
 * off unless a case turns it on.
 */
vi.mock("@/lib/attribution-evidence-policy-feature", () => ({
  isAttributionEvidenceEnabledForOrganization: vi.fn(async () => false),
  evaluateAttributionEvidenceForOrganization: vi.fn(async () => flag.linksOn),
}));

const tracker = createCommittedTestOrganizationTracker();
const organizationIds: string[] = [];
const START = Date.parse("2026-10-01T12:00:00.000Z");
const SECOND = 1000;
const HOUR = 60 * 60 * SECOND;
/** The fixture's claims are an hour old unless a case says otherwise. */
const NOW = new Date(START + HOUR);

describe.skipIf(!keys().DATABASE_URL)("ISS-12552 attribution backfill", () => {
  afterEach(async () => {
    flag.linksOn = false;
    const ids = organizationIds.splice(0);
    await withDb(async (db) => {
      await db.artifactOperationReceipt.deleteMany({
        where: { organizationId: { in: ids } },
      });
      await db.attributionBackfillRun.deleteMany({
        where: { organizationId: { in: ids } },
      });
    });
    await tracker.cleanup();
  });

  it("binds a late receipt, counts a session with no evidence, and changes nothing on a second run", async () => {
    const fixture = await seed();
    const session = await sessionWithEvidence(fixture, [
      awaitingRow("toolu_late", fixture.documentId, 0),
    ]);
    await createTestSessionDetail({
      organizationId: fixture.organizationId,
      userId: fixture.ownerId,
      label: "no-evidence",
    });
    await receipt(fixture, "toolu_late", 1);

    const first = await runAttributionBackfill({
      organizationId: fixture.organizationId,
      now: NOW,
    });
    const afterFirst = await evidenceRows(session);
    const second = await runAttributionBackfill({
      organizationId: fixture.organizationId,
      now: NOW,
    });

    expect(first).toMatchObject({
      status: AttributionBackfillStatus.Completed,
      counts: {
        sessionsScanned: 2,
        sessionsChanged: 1,
        noRetainedProof: 1,
        bound: 1,
        corroborated: 0,
      },
    });
    expect(afterFirst).toEqual([
      expect.objectContaining({
        outcome: OperationReceiptOutcome.Committed,
        relationshipKind: AttributionRelationshipKind.Revision,
        receiptBound: true,
      }),
    ]);
    expect(second.counts).toMatchObject({
      sessionsScanned: 2,
      sessionsChanged: 0,
      noRetainedProof: 1,
      bound: 0,
    });
    expect(await evidenceRows(session)).toEqual(afterFirst);
  });

  it("corroborates a pre-receipt version only from one the session owner created", async () => {
    const fixture = await seed();
    const session = await sessionWithEvidence(fixture, [
      awaitingRow(
        "toolu_own",
        fixture.documentId,
        0,
        OperationKind.CreateVersion
      ),
      awaitingRow(
        "toolu_other",
        fixture.documentId,
        60,
        OperationKind.CreateVersion
      ),
    ]);
    await versions(fixture, [
      { version: 1, content: "one", byOwner: true, atSeconds: -600 },
      { version: 2, content: "two", byOwner: true, atSeconds: 2 },
      { version: 3, content: "three", byOwner: false, atSeconds: 62 },
    ]);

    const outcome = await runAttributionBackfill({
      organizationId: fixture.organizationId,
      now: NOW,
    });

    expect(outcome.counts).toMatchObject({ corroborated: 1, bound: 0 });
    expect(await evidenceRows(session)).toEqual([
      expect.objectContaining({
        claimKey: "claude:toolu_own",
        source: OperationSource.HistoricalRecord,
        outcome: OperationReceiptOutcome.Committed,
        relationshipKind: AttributionRelationshipKind.Revision,
        versionNumber: 2,
      }),
      expect.objectContaining({
        claimKey: "claude:toolu_other",
        source: OperationSource.Mcp,
        outcome: OperationEvidenceOutcome.AwaitingReceipt,
        versionNumber: null,
      }),
    ]);
  });

  it("keeps a corroborated revision when a changed snapshot syncs the same claim again", async () => {
    const fixture = await seed();
    const session = await sessionWithEvidence(fixture, [
      awaitingRow(
        "toolu_own",
        fixture.documentId,
        0,
        OperationKind.CreateVersion
      ),
    ]);
    await versions(fixture, [
      { version: 1, content: "one", byOwner: true, atSeconds: -600 },
      { version: 2, content: "two", byOwner: true, atSeconds: 2 },
    ]);
    await runAttributionBackfill({
      organizationId: fixture.organizationId,
      now: NOW,
    });

    await resync(fixture, session, "e".repeat(64), [
      writeClaim(fixture, "toolu_own", OperationKind.CreateVersion, 0),
    ]);

    expect(await evidenceRows(session)).toEqual([
      expect.objectContaining({
        claimKey: "claude:toolu_own",
        source: OperationSource.HistoricalRecord,
        relationshipKind: AttributionRelationshipKind.Revision,
        versionNumber: 2,
      }),
    ]);
  });

  it("finalizes a write still awaiting its receipt a day after the call, and not before", async () => {
    const fixture = await seed();
    const session = await sessionWithEvidence(fixture, [
      awaitingRow("toolu_never", fixture.documentId, 0),
    ]);

    await runAttributionBackfill({
      organizationId: fixture.organizationId,
      now: new Date(START + 23 * HOUR),
    });
    expect(await evidenceRows(session)).toEqual([
      expect.objectContaining({
        outcome: OperationEvidenceOutcome.AwaitingReceipt,
      }),
    ]);

    const later = await runAttributionBackfill({
      organizationId: fixture.organizationId,
      now: new Date(START + 25 * HOUR),
    });
    expect(later.counts.finalized).toBe(1);
    expect(await evidenceRows(session)).toEqual([
      expect.objectContaining({
        claimKey: "claude:toolu_never",
        outcome: OperationEvidenceOutcome.MissingResult,
        relationshipKind: AttributionRelationshipKind.Unresolved,
      }),
    ]);
  });

  it("credits a version to one session of a lineage, not to each copy of the call", async () => {
    const fixture = await seed();
    const original = await sessionWithEvidence(fixture, [
      awaitingRow(
        "toolu_copied",
        fixture.documentId,
        0,
        OperationKind.CreateVersion
      ),
    ]);
    const copy = await sessionWithEvidence(fixture, [
      awaitingRow(
        "toolu_copied",
        fixture.documentId,
        0,
        OperationKind.CreateVersion
      ),
    ]);
    await versions(fixture, [
      { version: 1, content: "one", byOwner: true, atSeconds: -600 },
      { version: 2, content: "two", byOwner: true, atSeconds: 2 },
    ]);

    const outcome = await runAttributionBackfill({
      organizationId: fixture.organizationId,
      now: NOW,
    });

    expect(outcome.counts.corroborated).toBe(1);
    const sources = [
      ...(await evidenceRows(original)),
      ...(await evidenceRows(copy)),
    ].map((row) => row.source);
    expect(
      sources.filter((s) => s === OperationSource.HistoricalRecord)
    ).toHaveLength(1);
  });

  it("binds a late receipt to the canonical copy when the walk reaches the other copy first", async () => {
    const fixture = await seed();
    const copies = await copiesOfOneSession(fixture, "toolu_copied");
    await receipt(fixture, "toolu_copied", 1);

    const first = await runAttributionBackfill({
      organizationId: fixture.organizationId,
      now: NOW,
    });
    const settled = [
      ...(await evidenceRows(copies.canonical)),
      ...(await evidenceRows(copies.visitedFirst)),
    ];
    const second = await runAttributionBackfill({
      organizationId: fixture.organizationId,
      now: NOW,
    });

    expect(first.counts.bound).toBe(1);
    expect(await evidenceRows(copies.canonical)).toEqual([
      expect.objectContaining({
        outcome: OperationReceiptOutcome.Committed,
        receiptBound: true,
      }),
    ]);
    expect(await evidenceRows(copies.visitedFirst)).toEqual([
      expect.objectContaining({
        outcome: OperationEvidenceOutcome.DuplicateInLineage,
        receiptBound: false,
      }),
    ]);
    expect(second.counts).toMatchObject({ bound: 0, sessionsChanged: 0 });
    expect([
      ...(await evidenceRows(copies.canonical)),
      ...(await evidenceRows(copies.visitedFirst)),
    ]).toEqual(settled);
  });

  it("moves a receipt a non-canonical copy holds to the canonical copy", async () => {
    const fixture = await seed();
    const copies = await copiesOfOneSession(fixture, "toolu_copied");
    const receiptId = await receipt(fixture, "toolu_copied", 1);
    await withDb((db) =>
      db.agentSessionOperationEvidence.updateMany({
        where: { agentSessionId: copies.visitedFirst },
        data: {
          receiptId,
          outcome: OperationReceiptOutcome.Committed,
          relationshipKind: AttributionRelationshipKind.Revision,
          unresolvedReason: null,
        },
      })
    );

    await runAttributionBackfill({
      organizationId: fixture.organizationId,
      now: NOW,
    });

    expect(await evidenceRows(copies.canonical)).toEqual([
      expect.objectContaining({ receiptBound: true }),
    ]);
    expect(await evidenceRows(copies.visitedFirst)).toEqual([
      expect.objectContaining({
        outcome: OperationEvidenceOutcome.DuplicateInLineage,
        receiptBound: false,
      }),
    ]);
  });

  it("binds a fingerprint receipt to the one copy whose call window holds it, never deferring to a canonical copy that cannot bind it", async () => {
    const fixture = await seed();
    const copies = await copiesOfOneSession(fixture, "toolu_fingerprinted");
    const fingerprint = "f".repeat(64);
    await withDb(async (db) => {
      await db.agentSessionOperationEvidence.updateMany({
        where: {
          agentSessionId: { in: [copies.canonical, copies.visitedFirst] },
        },
        data: { providerCallId: null, requestFingerprint: fingerprint },
      });
      await db.agentSessionOperationEvidence.updateMany({
        where: { agentSessionId: copies.canonical },
        data: {
          invokedAt: new Date(START - HOUR),
          anchors: {
            resultAt: new Date(START - HOUR + 5 * SECOND).toISOString(),
          },
        },
      });
    });
    const receiptId = randomUUID();
    await withDb((db) =>
      db.artifactOperationReceipt.create({
        data: {
          id: receiptId,
          organizationId: fixture.organizationId,
          principalUserId: fixture.ownerId,
          source: OperationSource.Mcp,
          operationKind: OperationKind.UpdateFields,
          targetArtifactId: fixture.documentId,
          outcome: OperationReceiptOutcome.Committed,
          changedFields: ["title"],
          requestFingerprint: fingerprint,
          requestedAt: new Date(START + SECOND),
          committedAt: new Date(START + SECOND),
        },
        select: { id: true },
      })
    );

    await runAttributionBackfill({
      organizationId: fixture.organizationId,
      now: NOW,
    });

    expect(await evidenceRows(copies.visitedFirst)).toEqual([
      expect.objectContaining({
        outcome: OperationReceiptOutcome.Committed,
        receiptBound: true,
      }),
    ]);
    expect(await evidenceRows(copies.canonical)).toEqual([
      expect.objectContaining({
        outcome: OperationEvidenceOutcome.AwaitingReceipt,
        receiptBound: false,
      }),
    ]);
  });

  it("settles the other copy as the duplicate of a receipt the canonical copy already holds", async () => {
    const fixture = await seed();
    const copies = await copiesOfOneSession(fixture, "toolu_copied");
    const receiptId = await receipt(fixture, "toolu_copied", 1);
    await withDb((db) =>
      db.agentSessionOperationEvidence.updateMany({
        where: { agentSessionId: copies.canonical },
        data: {
          receiptId,
          outcome: OperationReceiptOutcome.Committed,
          relationshipKind: AttributionRelationshipKind.Revision,
          unresolvedReason: null,
        },
      })
    );

    const run = await runAttributionBackfill({
      organizationId: fixture.organizationId,
      now: NOW,
    });

    expect(run.counts.bound).toBe(0);
    expect(await evidenceRows(copies.canonical)).toEqual([
      expect.objectContaining({ receiptBound: true }),
    ]);
    expect(await evidenceRows(copies.visitedFirst)).toEqual([
      expect.objectContaining({
        outcome: OperationEvidenceOutcome.DuplicateInLineage,
        receiptBound: false,
      }),
    ]);
  });

  it("keeps a write finalized without a receipt finalized through later syncs", async () => {
    // With the flag off the links digest stays stale, so a resync rebuilds.
    flag.linksOn = true;
    const fixture = await seed();
    const session = await sessionWithEvidence(fixture, [
      awaitingRow("toolu_never", fixture.documentId, 0),
    ]);
    await runAttributionBackfill({
      organizationId: fixture.organizationId,
      now: new Date(START + 25 * HOUR),
    });
    const claims = [
      writeClaim(fixture, "toolu_never", OperationKind.UpdateFields, 0),
    ];

    await resync(fixture, session, "e".repeat(64), claims);
    expect(await evidenceRows(session)).toEqual([
      expect.objectContaining({
        claimKey: "claude:toolu_never",
        outcome: OperationEvidenceOutcome.MissingResult,
      }),
    ]);
    const settled = await evidenceIds(session);
    await resync(fixture, session, "e".repeat(64), claims);
    expect(await evidenceIds(session)).toEqual(settled);
  });

  it("resumes an interrupted run to the result an uninterrupted run reaches", async () => {
    const interrupted = await seedThreeSessions();
    const whole = await seedThreeSessions();

    const stopped = await runAttributionBackfill({
      organizationId: interrupted.organizationId,
      now: NOW,
      pageSize: 1,
      maxPages: 1,
    });
    const resumed = await runAttributionBackfill({
      organizationId: interrupted.organizationId,
      now: NOW,
      pageSize: 1,
    });
    const uninterrupted = await runAttributionBackfill({
      organizationId: whole.organizationId,
      now: NOW,
      pageSize: 1,
    });

    expect(stopped.status).toBe(AttributionBackfillStatus.Running);
    expect(stopped.counts.sessionsScanned).toBe(1);
    expect(resumed.runId).toBe(stopped.runId);
    expect(resumed.status).toBe(AttributionBackfillStatus.Completed);
    expect(resumed.counts).toEqual(uninterrupted.counts);
    expect(await outcomesOf(interrupted.sessions)).toEqual(
      await outcomesOf(whole.sessions)
    );
  });
});

type Fixture = {
  organizationId: string;
  ownerId: string;
  otherUserId: string;
  documentId: string;
  documentSlug: string;
};

type RowDraft = {
  claimKey: string;
  providerCallId: string;
  operationKind: OperationKind;
  targetArtifactId: string;
  invokedAt: Date;
  resultAt: string;
};

async function seed(): Promise<Fixture> {
  const organizationId = await tracker.create();
  organizationIds.push(organizationId);
  const owner = await createTestUser(organizationId);
  const other = await createTestUser(organizationId);
  const projectId = await createTestProject(organizationId, owner.id);
  const documentSlug = generateSlug();
  const document = await withDb((db) =>
    db.artifact.create({
      data: {
        name: "Plan",
        slug: documentSlug,
        type: ArtifactType.DOCUMENT,
        subtype: ArtifactSubtype.PRD,
        status: DocumentStatus.Draft,
        organizationId,
        createdById: owner.id,
        projectId,
        document: { create: { repositorySnapshot: {} } },
      },
      select: { id: true },
    })
  );
  return {
    organizationId,
    ownerId: owner.id,
    otherUserId: other.id,
    documentId: document.id,
    documentSlug,
  };
}

function awaitingRow(
  callId: string,
  documentId: string,
  atSeconds: number,
  operationKind: OperationKind = OperationKind.UpdateFields
): RowDraft {
  return {
    claimKey: `claude:${callId}`,
    providerCallId: callId,
    operationKind,
    targetArtifactId: documentId,
    invokedAt: new Date(START + atSeconds * SECOND),
    resultAt: new Date(START + (atSeconds + 5) * SECOND).toISOString(),
  };
}

async function sessionWithEvidence(
  fixture: Fixture,
  rows: RowDraft[]
): Promise<string> {
  const agentSessionId = await createTestSessionDetail({
    organizationId: fixture.organizationId,
    userId: fixture.ownerId,
    label: `backfill-${randomUUID().slice(0, 8)}`,
  });
  await withDb(async (db) => {
    await db.agentSessionOperationEvidenceSnapshot.create({
      data: {
        agentSessionId,
        organizationId: fixture.organizationId,
        digest: "d".repeat(64),
        extractorVersion: 1,
        coverage: {},
      },
      select: { agentSessionId: true },
    });
    await db.agentSessionOperationEvidence.createMany({
      data: rows.map((row) => ({
        organizationId: fixture.organizationId,
        agentSessionId,
        claimKey: row.claimKey,
        providerCallId: row.providerCallId,
        targetArtifactId: row.targetArtifactId,
        observedTarget: fixture.documentSlug,
        relationshipKind: AttributionRelationshipKind.Unresolved,
        unresolvedReason: UnresolvedReason.AwaitingReceipt,
        outcome: OperationEvidenceOutcome.AwaitingReceipt,
        operationKind: row.operationKind,
        source: OperationSource.Mcp,
        invokedAt: row.invokedAt,
        anchors: { resultAt: row.resultAt },
        extractorVersion: 1,
        policyVersion: 1,
      })),
    });
  });
  return agentSessionId;
}

async function receipt(
  fixture: Fixture,
  clientCallId: string,
  atSeconds: number
): Promise<string> {
  const id = randomUUID();
  await withDb((db) =>
    db.artifactOperationReceipt.create({
      data: {
        id,
        organizationId: fixture.organizationId,
        principalUserId: fixture.ownerId,
        source: OperationSource.Mcp,
        operationKind: OperationKind.UpdateFields,
        targetArtifactId: fixture.documentId,
        outcome: OperationReceiptOutcome.Committed,
        changedFields: ["title"],
        clientCallId,
        requestedAt: new Date(START + atSeconds * SECOND),
        committedAt: new Date(START + atSeconds * SECOND),
      },
      select: { id: true },
    })
  );
  return id;
}

async function versions(
  fixture: Fixture,
  drafts: {
    version: number;
    content: string;
    byOwner: boolean;
    atSeconds: number;
  }[]
): Promise<void> {
  await withDb((db) =>
    db.documentVersion.createMany({
      data: drafts.map((draft) => ({
        documentId: fixture.documentId,
        version: draft.version,
        content: draft.content,
        createdById: draft.byOwner ? fixture.ownerId : fixture.otherUserId,
        createdAt: new Date(START + draft.atSeconds * SECOND),
      })),
    })
  );
}

/** Three sessions in one organization: a late receipt, no evidence, a version. */
async function seedThreeSessions(): Promise<{
  organizationId: string;
  sessions: string[];
}> {
  const fixture = await seed();
  const late = await sessionWithEvidence(fixture, [
    awaitingRow("toolu_late", fixture.documentId, 0),
  ]);
  const bare = await createTestSessionDetail({
    organizationId: fixture.organizationId,
    userId: fixture.ownerId,
    label: "no-evidence",
  });
  const versioned = await sessionWithEvidence(fixture, [
    awaitingRow(
      "toolu_version",
      fixture.documentId,
      100,
      OperationKind.CreateVersion
    ),
  ]);
  await receipt(fixture, "toolu_late", 1);
  await versions(fixture, [
    { version: 1, content: "one", byOwner: true, atSeconds: -600 },
    { version: 2, content: "two", byOwner: true, atSeconds: 102 },
  ]);
  return {
    organizationId: fixture.organizationId,
    sessions: [late, bare, versioned].sort(),
  };
}

async function evidenceRows(agentSessionId: string) {
  const rows = await withDb((db) =>
    db.agentSessionOperationEvidence.findMany({
      where: { agentSessionId },
      orderBy: { claimKey: "desc" },
      select: {
        claimKey: true,
        receiptId: true,
        outcome: true,
        relationshipKind: true,
        source: true,
        versionNumber: true,
        updatedAt: true,
      },
    })
  );
  return rows.map(({ receiptId, ...row }) => ({
    ...row,
    receiptBound: receiptId !== null,
  }));
}

/** Per-session evidence with ids and times dropped, for comparing two orgs. */
function outcomesOf(sessions: readonly string[]) {
  return Promise.all(
    sessions.map(async (session) =>
      (await evidenceRows(session)).map(({ updatedAt: _, ...row }) => row)
    )
  );
}

function writeClaim(
  fixture: Fixture,
  callId: string,
  operationKind: OperationKind,
  atSeconds: number
): OperationClaim {
  return {
    claimKey: `claude:${callId}`,
    providerCallId: callId,
    source: OperationClaimSource.ClosedloopMcp,
    toolName: "create-document-version",
    operationKind,
    resultState: ToolResultState.Present,
    inputTargets: [{ key: "documentId", uuid: fixture.documentId }],
    invokedAt: new Date(START + atSeconds * SECOND).toISOString(),
    resultAt: new Date(START + (atSeconds + 5) * SECOND).toISOString(),
  };
}

/**
 * A sync of the session's evidence snapshot through the ingest persist step,
 * then the link sync ingest runs after the slice commits.
 */
async function resync(
  fixture: Fixture,
  agentSessionId: string,
  digest: string,
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
          digest,
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
    { maxWait: 5000, timeout: 20_000 }
  );
  await syncSessionEvidenceLinks(fixture.organizationId, [agentSessionId]);
}

async function evidenceIds(agentSessionId: string): Promise<string[]> {
  const found = await withDb((db) =>
    db.agentSessionOperationEvidence.findMany({
      where: { agentSessionId },
      orderBy: { id: "asc" },
      select: { id: true },
    })
  );
  return found.map((row) => row.id);
}

/**
 * Two records of one session (PRD-800), each awaiting a receipt for
 * the same call. The record the walk reaches first (the smaller artifact id)
 * is given the compute target that sorts last, so it is not the canonical copy.
 */
async function copiesOfOneSession(
  fixture: Fixture,
  callId: string
): Promise<{ canonical: string; visitedFirst: string }> {
  const [visitedFirst, canonical] = (
    await Promise.all([
      sessionWithEvidence(fixture, [
        awaitingRow(callId, fixture.documentId, 0),
      ]),
      sessionWithEvidence(fixture, [
        awaitingRow(callId, fixture.documentId, 0),
      ]),
    ])
  ).sort();
  await withDb(async (db) => {
    const details = await db.sessionDetail.findMany({
      where: { artifactId: { in: [visitedFirst, canonical] } },
      select: { computeTargetId: true },
    });
    const [low, high] = details.map((row) => row.computeTargetId).sort();
    const externalSessionId = `ext-copied-${randomUUID()}`;
    await db.sessionDetail.update({
      where: { artifactId: visitedFirst },
      data: { computeTargetId: high, externalSessionId },
      select: { artifactId: true },
    });
    await db.sessionDetail.update({
      where: { artifactId: canonical },
      data: { computeTargetId: low, externalSessionId },
      select: { artifactId: true },
    });
  });
  return { canonical, visitedFirst };
}
