/**
 * ISS-12552: the comparison report on a seeded
 * two-organization database. Organization A has a link the flag keeps, one it
 * drops because evidence shows a read, and one it drops for absent evidence
 * from a Desktop that never sent any; organization B has a link whose
 * session synced evidence that names nothing for it, and an API-key write no
 * claim bound.
 */
import { randomUUID } from "node:crypto";
import { LinkType } from "@repo/api/src/types/artifact";
import {
  AttributionRelationshipKind,
  OperationEvidenceOutcome,
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import { DocumentStatus } from "@repo/api/src/types/document";
import { OPERATION_EVIDENCE_EXTRACTOR_VERSION } from "@repo/api/src/types/operation-claims";
import { ProvenanceRelationshipKind } from "@repo/api/src/types/provenance-relationship";
import { ArtifactRefRelation } from "@repo/api/src/types/session-artifact-link";
import { ArtifactSubtype, ArtifactType, Prisma, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import {
  asCopiesOfOneSession,
  type OwnedUsageUnit,
  ownedUsageOrganization,
  sessionWithUsage,
} from "@/__tests__/support/agent-sessions/attribution/owned-usage.test-fixtures";
import {
  createCommittedTestOrganizationTracker,
  createTestProject,
  createTestSessionDetail,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { generateSlug } from "@/app/documents/document-utils";
import {
  buildAttributionComparisonReport,
  UNRECORDED_RECEIPT_ROUTE,
} from "./attribution-comparison";
import { AbsentEvidenceGroup } from "./attribution-comparison-classify";

const tracker = createCommittedTestOrganizationTracker();
const organizationIds: string[] = [];
const RECEIPTS_EPOCH = new Date("2026-01-01T00:00:00.000Z");
const PARENT_START = new Date("2026-10-19T10:00:00.000Z");
const FORK_START = new Date("2026-10-19T11:00:00.000Z");
const TIE_START = new Date("2026-10-19T12:00:00.000Z");
const OTHER_SCHEME = "test.per-file";

describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 attribution comparison report",
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

    it("compares each organization's links apart and sums them globally", async () => {
      const a = await organization();
      const [kept, read, absent] = await Promise.all([
        documentIn(a),
        documentIn(a),
        documentIn(a),
      ]);
      const upgraded = await session(a);
      await snapshot(a, upgraded);
      const readEvidenceId = await evidence(
        a,
        upgraded,
        read,
        AttributionRelationshipKind.Usage
      );
      await evidence(a, upgraded, kept, AttributionRelationshipKind.Creation);
      await link(a, upgraded, kept, ArtifactRefRelation.Created);
      await link(a, upgraded, read, ArtifactRefRelation.Output);
      const notUpgraded = await session(a);
      await link(a, notUpgraded, absent, ArtifactRefRelation.Output);

      const b = await organization();
      const target = await documentIn(b);
      const synced = await session(b);
      await snapshot(b, synced);
      await link(b, synced, target, ArtifactRefRelation.Created);
      await apiReceipt(b);

      const report = await buildAttributionComparisonReport({
        organizationIds: [a.organizationId, b.organizationId],
        receiptsEpoch: RECEIPTS_EPOCH,
      });

      expect(report).not.toHaveProperty("policyFlag");
      const sectionA = report.organizations[a.organizationId];
      const sectionB = report.organizations[b.organizationId];
      expect(sectionA?.links).toEqual({
        total: 3,
        agree: 1,
        disagree: 2,
        addedByEvidence: 0,
        droppedForReadOrReference: 1,
        droppedForAbsentEvidence: 1,
      });
      expect(sectionA?.disagreements.sample).toContainEqual(
        expect.objectContaining({
          sessionId: upgraded,
          targetId: read,
          flagOff: ProvenanceRelationshipKind.Contribution,
          flagOn: ProvenanceRelationshipKind.Usage,
          evidence: [expect.objectContaining({ id: readEvidenceId })],
        })
      );
      expect(sectionA?.absentEvidenceSessions).toMatchObject({
        [AbsentEvidenceGroup.DesktopNotUpgraded]: 1,
        [AbsentEvidenceGroup.EvidenceSyncedNoClaim]: 0,
      });
      expect(sectionA?.correlationCoverage).toEqual({
        "claude@2.1.303": { sessions: 1, writeClaims: 1, bound: 0, unbound: 1 },
      });
      expect(sectionB?.links).toMatchObject({
        total: 1,
        droppedForAbsentEvidence: 1,
      });
      expect(sectionB?.absentEvidenceSessions).toMatchObject({
        [AbsentEvidenceGroup.EvidenceSyncedNoClaim]: 1,
        [AbsentEvidenceGroup.DesktopNotUpgraded]: 0,
      });
      expect(sectionB?.apiKeyWrites).toEqual({
        total: 1,
        attributed: 0,
        unattributed: 1,
        byRoute: {
          [UNRECORDED_RECEIPT_ROUTE]: {
            total: 1,
            attributed: 0,
            unattributed: 1,
          },
        },
      });
      expect(report.global.links.total).toBe(4);
      expect(report.global.apiKeyWrites.total).toBe(1);
      expect(report.global.allocation).toMatchObject({
        sessions: 2,
        failures: {},
        totalMicros: 0,
        allocatedMicros: 0,
      });
    });

    it("groups an absent-evidence session by when it last synced, not by session_updated_at", async () => {
      const org = await organization();
      const target = await documentIn(org);
      const old = await session(org);
      await link(org, old, target, ArtifactRefRelation.Output);
      const group = async () => {
        const report = await buildAttributionComparisonReport({
          organizationIds: [org.organizationId],
          receiptsEpoch: RECEIPTS_EPOCH,
        });
        return report.organizations[org.organizationId]?.absentEvidenceSessions;
      };
      await withDb((db) =>
        db.sessionDetail.update({
          where: { artifactId: old },
          data: {
            lastSyncedAt: new Date("2025-12-01T00:00:00.000Z"),
            sessionUpdatedAt: new Date("2025-12-01T00:00:00.000Z"),
          },
          select: { artifactId: true },
        })
      );
      const before = await group();

      await withDb((db) =>
        db.sessionDetail.update({
          where: { artifactId: old },
          data: { sessionUpdatedAt: new Date("2026-10-19T12:00:00.000Z") },
          select: { artifactId: true },
        })
      );

      expect(before).toMatchObject({
        [AbsentEvidenceGroup.DesktopNotUpgraded]: 0,
        [AbsentEvidenceGroup.NoRetainedTranscript]: 1,
      });
      expect(await group()).toEqual(before);
    });

    it("counts token events the source-identity dedupe sets aside, per organization (ISS-12744)", async () => {
      const org = await ownedUsageOrganization(tracker);
      await sessionWithUsage(org, "parent", PARENT_START, [
        { uuid: "entry-1", input: 100n },
        { uuid: "entry-2", input: 200n },
        { uuid: "L1", input: 5n, scheme: OTHER_SCHEME },
      ]);
      await sessionWithUsage(org, "fork", FORK_START, [
        { uuid: "entry-1", input: 100n },
        { uuid: "entry-2", input: 200n },
        { uuid: "entry-3", input: 50n },
        { uuid: "L1", input: 5n, scheme: OTHER_SCHEME },
      ]);
      await sessionWithUsage(org, "tie-a", TIE_START, [
        { uuid: "entry-9", input: 10n },
      ]);
      await sessionWithUsage(org, "tie-b", TIE_START, [
        { uuid: "entry-9", input: 10n },
      ]);
      const copied: OwnedUsageUnit[] = [
        { uuid: "entry-20", input: 7n, eventId: "token-event-entry-20" },
        {
          uuid: "R1",
          input: 3n,
          scheme: OTHER_SCHEME,
          eventId: "token-event-r1",
        },
        { uuid: "l1", input: 2n, unavailable: true, eventId: "token-event-l1" },
      ];
      await asCopiesOfOneSession([
        await sessionWithUsage(org, "copy-a", TIE_START, copied),
        await sessionWithUsage(org, "copy-b", TIE_START, copied),
      ]);
      const member = await createTestUser(org.id);
      await sessionWithUsage(
        { id: org.id, userId: member.id },
        "member",
        FORK_START,
        [{ uuid: "entry-1", input: 100n }]
      );
      const stranger = await ownedUsageOrganization(tracker);
      await sessionWithUsage(stranger, "stranger", FORK_START, [
        { uuid: "entry-3", input: 50n },
      ]);

      const report = await buildAttributionComparisonReport({
        organizationIds: [org.id, stranger.id],
        receiptsEpoch: RECEIPTS_EPOCH,
      });

      // The copy on the higher compute target sets aside all three of its
      // events, matched by event id whatever identity they carry, and never
      // ties.
      expect(report.organizations[org.id]?.duplicateTokenEvents).toEqual({
        ownedElsewhere: 5,
        tied: 2,
      });
      expect(report.organizations[stranger.id]?.duplicateTokenEvents).toEqual({
        ownedElsewhere: 0,
        tied: 0,
      });
      expect(report.global.duplicateTokenEvents).toEqual({
        ownedElsewhere: 5,
        tied: 2,
      });
    });

    it("shows unpriced tokens, uniform-rate usage and the gap to each session's stored cost (PRD-800)", async () => {
      const org = await ownedUsageOrganization(tracker);
      const { agentSessionId } = await sessionWithUsage(
        org,
        "costed",
        PARENT_START,
        [
          { uuid: "priced", input: 2000n },
          { uuid: "unpriced", input: 500n },
          { uuid: "uniform", input: 300n },
        ]
      );
      await withDb(async (db) => {
        await db.agentSessionTokenEvent.updateMany({
          where: { agentSessionId, externalEventId: "costed:unpriced" },
          data: { estimatedCost: null },
        });
        await db.agentSessionTokenEvent.updateMany({
          where: { agentSessionId, externalEventId: "costed:uniform" },
          data: {
            model: "not-a-real-model",
            estimatedCost: new Prisma.Decimal("0.000900"),
          },
        });
        await db.sessionDetail.update({
          where: { artifactId: agentSessionId },
          data: { estimatedCost: new Prisma.Decimal("0.005000") },
          select: { artifactId: true },
        });
        await db.agentSessionOperationEvidenceSnapshot.create({
          data: {
            agentSessionId,
            organizationId: org.id,
            digest: "d".repeat(64),
            extractorVersion: OPERATION_EVIDENCE_EXTRACTOR_VERSION,
            coverage: {},
          },
          select: { agentSessionId: true },
        });
      });

      const report = await buildAttributionComparisonReport({
        organizationIds: [org.id],
        receiptsEpoch: RECEIPTS_EPOCH,
      });

      expect(report.organizations[org.id]?.allocation).toMatchObject({
        sessions: 1,
        failures: {},
        totalTokens: 2800,
        unpricedTokens: 500,
        uniformRateTokens: 300,
        uniformRateMicros: 900,
        totalMicros: 2900,
        sessionCostGapMicros: 2100,
        sessionsWithoutCost: 0,
      });
    });
  }
);

type Org = { organizationId: string; userId: string; projectId: string };

async function organization(): Promise<Org> {
  const organizationId = await tracker.create();
  organizationIds.push(organizationId);
  const user = await createTestUser(organizationId);
  const projectId = await createTestProject(organizationId, user.id);
  return { organizationId, userId: user.id, projectId };
}

async function documentIn(org: Org): Promise<string> {
  const row = await withDb((db) =>
    db.artifact.create({
      data: {
        name: "Doc",
        slug: generateSlug(),
        type: ArtifactType.DOCUMENT,
        subtype: ArtifactSubtype.PRD,
        status: DocumentStatus.Draft,
        organizationId: org.organizationId,
        createdById: org.userId,
        projectId: org.projectId,
      },
      select: { id: true },
    })
  );
  return row.id;
}

function session(org: Org): Promise<string> {
  return createTestSessionDetail({
    organizationId: org.organizationId,
    userId: org.userId,
    label: `comparison-${randomUUID().slice(0, 8)}`,
  });
}

async function snapshot(org: Org, agentSessionId: string): Promise<void> {
  await withDb((db) =>
    db.agentSessionOperationEvidenceSnapshot.create({
      data: {
        agentSessionId,
        organizationId: org.organizationId,
        digest: "e".repeat(64),
        extractorVersion: 1,
        coverage: { harness: "claude", harnessVersion: "2.1.303" },
      },
      select: { agentSessionId: true },
    })
  );
}

async function evidence(
  org: Org,
  agentSessionId: string,
  targetArtifactId: string,
  relationshipKind: AttributionRelationshipKind
): Promise<string> {
  const row = await withDb((db) =>
    db.agentSessionOperationEvidence.create({
      data: {
        organizationId: org.organizationId,
        agentSessionId,
        claimKey: `claude:toolu_${randomUUID().slice(0, 8)}`,
        targetArtifactId,
        relationshipKind,
        outcome: OperationEvidenceOutcome.Committed,
        operationKind:
          relationshipKind === AttributionRelationshipKind.Creation
            ? OperationKind.Create
            : OperationKind.Read,
        source: OperationSource.Mcp,
        extractorVersion: 1,
        policyVersion: 1,
      },
      select: { id: true },
    })
  );
  return row.id;
}

async function link(
  org: Org,
  sourceId: string,
  targetId: string,
  relation: ArtifactRefRelation
): Promise<void> {
  await withDb((db) =>
    db.artifactLink.create({
      data: {
        organizationId: org.organizationId,
        sourceId,
        targetId,
        linkType: LinkType.RelatesTo,
        metadata: { relation },
      },
      select: { id: true },
    })
  );
}

async function apiReceipt(org: Org): Promise<void> {
  await withDb((db) =>
    db.artifactOperationReceipt.create({
      data: {
        id: randomUUID(),
        organizationId: org.organizationId,
        principalUserId: org.userId,
        source: OperationSource.Api,
        operationKind: OperationKind.UpdateFields,
        outcome: OperationReceiptOutcome.Committed,
        requestedAt: new Date(),
        committedAt: new Date(),
      },
      select: { id: true },
    })
  );
}
