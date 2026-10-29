/**
 * ISS-12552 (PRD-800 "Proving usage"): which requests a session's
 * synced claims prove, from claims persisted and bound by sync ingest through
 * to the allocation, against a real Postgres.
 */
import { ACTIVITY_PHASE } from "@repo/api/src/types/activity-phase";
import { LinkType } from "@repo/api/src/types/artifact";
import {
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
  UsageAssociationMethod,
} from "@repo/api/src/types/attribution-evidence";
import {
  BranchParticipationKind,
  BranchStatus,
} from "@repo/api/src/types/branch";
import { DocumentStatus } from "@repo/api/src/types/document";
import {
  OPERATION_EVIDENCE_EXTRACTOR_VERSION,
  type OperationClaim,
  OperationClaimSource,
  ToolResultState,
} from "@repo/api/src/types/operation-claims";
import { TokenSourceIdentityAvailability } from "@repo/api/src/types/token-cost-provenance";
import { ArtifactSubtype, ArtifactType, Prisma, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { requestKeyFor } from "@repo/lib/harness/request-key";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCommittedTestOrganizationTracker,
  createTestProject,
  createTestSessionDetail,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { generateSlug } from "@/app/documents/document-utils";
import { deriveImplementationEvidence } from "./derive-implementation-evidence";
import { persistSessionOperationEvidence } from "./persist-operation-evidence";
import { allocateSessionUsage } from "./session-allocation-service";

const tracker = createCommittedTestOrganizationTracker();
const organizationIds: string[] = [];
const TRANSACTION_OPTIONS = { maxWait: 5000, timeout: 20_000 };
const START = Date.parse("2026-10-16T12:00:00.000Z");
const SECOND = 1000;
const SCHEME = "test";
const BRANCH = "feat/request-proof";

describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 request proof from synced claims",
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

    it("proves only a request's single receipted target, a nested write's candidates, and an implementation join's requests", async () => {
      const fixture = await seed();
      await tokenEvents(fixture, [
        ["multi", 10],
        ["candidate-1", 110],
        ["candidate-2", 120],
        ["closing", 180],
        ["implemented", 210],
        ["lookup", 250],
      ]);
      await segments(fixture, [
        [ACTIVITY_PHASE.Plan, 0, 50],
        [ACTIVITY_PHASE.Plan, 100, 200],
        [ACTIVITY_PHASE.Implement, 200, 300],
      ]);
      const claims = [
        writeClaim("toolu_a", fixture.documents.a, 20, {
          requestKey: request("multi"),
        }),
        writeClaim("toolu_b", fixture.documents.b, 30, {
          requestKey: request("multi"),
        }),
        writeClaim("toolu_c", fixture.documents.c, 150, {
          candidateRequestKeys: [
            request("candidate-1"),
            request("candidate-2"),
          ],
        }),
        {
          claimKey: `claude:implementation:${BRANCH}`,
          source: OperationClaimSource.ImplementationJoin,
          branch: BRANCH,
          requestKeys: [request("implemented")],
        },
      ];
      for (const claim of claims.slice(0, 3)) {
        await receipt(fixture, claim);
      }

      await sync(fixture, claims);
      const result = await allocateSessionUsage(fixture);
      if (!result.ok) {
        throw new Error(`allocation failed: ${result.error.kind}`);
      }

      expect(
        result.value.proofs
          .map((proof) => [proof.sourceKey, proof.recipientKey, proof.method])
          .sort()
      ).toEqual(
        [
          [
            `${SCHEME}:candidate-1#input`,
            fixture.documents.c,
            UsageAssociationMethod.RequestReceipt,
          ],
          [
            `${SCHEME}:candidate-2#input`,
            fixture.documents.c,
            UsageAssociationMethod.RequestReceipt,
          ],
          [
            `${SCHEME}:implemented#input`,
            fixture.branchId,
            UsageAssociationMethod.RequestReceipt,
          ],
        ].sort()
      );
    });

    it("keeps the whole-run fallback only for a write with no request and no candidates, never for one whose request is unresolved", async () => {
      const fixture = await seed();
      await tokenEvents(fixture, [
        ["beside-unresolved", 10],
        ["beside-older-desktop", 110],
      ]);
      // An implement segment between them keeps the two plan runs apart.
      await segments(fixture, [
        [ACTIVITY_PHASE.Plan, 0, 50],
        [ACTIVITY_PHASE.Implement, 50, 100],
        [ACTIVITY_PHASE.Plan, 100, 200],
      ]);
      const claims = [
        writeClaim("toolu_unresolved", fixture.documents.a, 20, {
          requestUnresolved: true,
        }),
        writeClaim("toolu_older_desktop", fixture.documents.b, 150, {}),
      ];
      for (const claim of claims) {
        await receipt(fixture, claim);
      }

      await sync(fixture, claims);
      const result = await allocateSessionUsage(fixture);
      if (!result.ok) {
        throw new Error(`allocation failed: ${result.error.kind}`);
      }

      expect(
        result.value.proofs.map((proof) => [
          proof.sourceKey,
          proof.recipientKey,
          proof.method,
        ])
      ).toEqual([
        [
          `${SCHEME}:beside-older-desktop#input`,
          fixture.documents.b,
          UsageAssociationMethod.AgentPhaseRun,
        ],
      ]);
    });
  }
);

type Fixture = {
  organizationId: string;
  agentSessionId: string;
  userId: string;
  branchId: string;
  documents: { a: string; b: string; c: string };
};

async function seed(): Promise<Fixture> {
  const organizationId = await tracker.create();
  organizationIds.push(organizationId);
  const user = await createTestUser(organizationId);
  const projectId = await createTestProject(organizationId, user.id);
  const agentSessionId = await createTestSessionDetail({
    organizationId,
    userId: user.id,
    label: "request-proof",
  });
  const artifact = (
    db: Prisma.TransactionClient,
    name: string,
    subtype: ArtifactSubtype
  ) =>
    db.artifact.create({
      data: {
        name,
        slug: generateSlug(),
        type: ArtifactType.DOCUMENT,
        subtype,
        status: DocumentStatus.Draft,
        organizationId,
        createdById: user.id,
        projectId,
      },
      select: { id: true },
    });
  return await withDb.tx(async (db) => {
    const a = await artifact(db, "A", ArtifactSubtype.PRD);
    const b = await artifact(db, "B", ArtifactSubtype.PRD);
    const c = await artifact(db, "C", ArtifactSubtype.PRD);
    const issue = await artifact(db, "Issue", ArtifactSubtype.FEATURE);
    const branch = await db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.BRANCH,
        name: BRANCH,
        status: BranchStatus.Open,
        createdById: user.id,
      },
      select: { id: true },
    });
    await db.branchDetail.create({
      data: {
        artifactId: branch.id,
        organizationId,
        repositoryFullName: "acme/app",
        branchName: BRANCH,
      },
      select: { artifactId: true },
    });
    await db.artifactLink.createMany({
      data: [
        {
          organizationId,
          sourceId: issue.id,
          targetId: branch.id,
          linkType: LinkType.Produces,
        },
        {
          organizationId,
          sourceId: agentSessionId,
          targetId: branch.id,
          linkType: LinkType.RelatesTo,
          branchParticipation: BranchParticipationKind.Wrote,
          metadata: {},
        },
      ],
    });
    return {
      organizationId,
      agentSessionId,
      userId: user.id,
      branchId: branch.id,
      documents: { a: a.id, b: b.id, c: c.id },
    };
  }, TRANSACTION_OPTIONS);
}

function request(id: string): string {
  return requestKeyFor(SCHEME, id);
}

function writeClaim(
  callId: string,
  documentId: string,
  atSeconds: number,
  anchors: Pick<
    OperationClaim,
    "requestKey" | "candidateRequestKeys" | "requestUnresolved"
  >
): OperationClaim {
  const at = new Date(START + atSeconds * SECOND).toISOString();
  return {
    claimKey: `claude:${callId}`,
    providerCallId: callId,
    source: OperationClaimSource.ClosedloopMcp,
    toolName: "update-document",
    operationKind: OperationKind.UpdateFields,
    resultState: ToolResultState.Present,
    inputTargets: [{ key: "documentId", uuid: documentId }],
    invokedAt: at,
    resultAt: at,
    ...anchors,
  };
}

/** The receipt the claim's write committed, for sync to bind by call id. */
async function receipt(fixture: Fixture, claim: OperationClaim) {
  const target = claim.inputTargets?.[0]?.uuid;
  const at = new Date(claim.invokedAt ?? START);
  await withDb((db) =>
    db.artifactOperationReceipt.create({
      data: {
        organizationId: fixture.organizationId,
        principalUserId: fixture.userId,
        source: OperationSource.Mcp,
        operationKind: OperationKind.UpdateFields,
        targetArtifactId: target,
        outcome: OperationReceiptOutcome.Committed,
        changedFields: ["title"],
        clientCallId: claim.providerCallId,
        requestedAt: at,
        committedAt: at,
      },
      select: { id: true },
    })
  );
}

/** Sync ingest's persist step, then the implementation derive it runs after. */
async function sync(fixture: Fixture, claims: OperationClaim[]) {
  await withDb.tx(async (tx) => {
    await persistSessionOperationEvidence(tx, {
      organizationId: fixture.organizationId,
      agentSessionId: fixture.agentSessionId,
      fresh: true,
      evidence: {
        extractorVersion: OPERATION_EVIDENCE_EXTRACTOR_VERSION,
        digest: "c".repeat(64),
        coverage: {
          harness: "claude",
          evidencePathSupported: true,
          closedloopMcpCalls: 3,
          shellCallsWithOperationIds: 0,
          directApiShellCommands: 0,
          unsupportedToolNames: {},
          claimsDroppedByCap: 0,
        },
        claims,
      },
    });
    await deriveImplementationEvidence(tx, {
      organizationId: fixture.organizationId,
      sessionIds: [fixture.agentSessionId],
    });
  }, TRANSACTION_OPTIONS);
}

async function tokenEvents(
  fixture: Fixture,
  events: [id: string, atSeconds: number][]
) {
  await withDb((db) =>
    db.agentSessionTokenEvent.createMany({
      data: events.map(([id, atSeconds]) => ({
        agentSessionId: fixture.agentSessionId,
        externalEventId: id,
        model: "claude-sonnet-4-20250514",
        inputTokens: 100n,
        estimatedCost: new Prisma.Decimal("0.000300"),
        sourceIdentity: {
          availability: TokenSourceIdentityAvailability.Available,
          scheme: SCHEME,
          sourceRecordIds: [id],
        },
        eventCreatedAt: new Date(START + atSeconds * SECOND),
      })),
    })
  );
}

async function segments(
  fixture: Fixture,
  spans: [phase: string, startSeconds: number, endSeconds: number][]
) {
  await withDb((db) =>
    db.agentSessionActivitySegment.createMany({
      data: spans.map(([phase, startSeconds, endSeconds]) => ({
        agentSessionId: fixture.agentSessionId,
        phase,
        startMs: BigInt(START + startSeconds * SECOND),
        endMs: BigInt(START + endSeconds * SECOND),
        confidence: 1,
        evidenceLayers: [],
        classifierVersion: 1,
        workItemRef: null,
      })),
    })
  );
}
