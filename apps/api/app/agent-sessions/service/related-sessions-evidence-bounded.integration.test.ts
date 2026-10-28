/**
 * ISS-12552: the flag-on Related Sessions batch read ranks, caps and counts
 * per target in its statement, as the legacy read does, so a target touched by
 * hundreds of sessions never loads them all (apps/api/AGENTS.md, "Do not
 * materialize a platform-wide workload to emit a bounded top-N").
 */
import { LinkType } from "@repo/api/src/types/artifact";
import {
  AttributionRelationshipKind,
  OperationEvidenceOutcome,
  OperationKind,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import { BranchParticipationKind } from "@repo/api/src/types/branch";
import { DocumentStatus } from "@repo/api/src/types/document";
import { ProvenanceRelationshipKind } from "@repo/api/src/types/provenance-relationship";
import { ArtifactSubtype, ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { ATTRIBUTION_POLICY_VERSION } from "@repo/lib/attribution/classify-operation";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCommittedTestOrganizationTracker,
  createTestProject,
  createTestSessionDetail,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { generateSlug } from "@/app/documents/document-utils";
import { listRelatedSessionsForArtifacts } from "./related-sessions";

vi.mock("@/lib/attribution-evidence-policy-feature", () => ({
  isAttributionEvidenceEnabledForOrganization: vi.fn(async () => true),
}));

const tracker = createCommittedTestOrganizationTracker();
const BASE = Date.parse("2026-10-01T00:00:00.000Z");
const SESSION_COUNT = 200;
const LIMIT = 5;
const SEED_CONCURRENCY = 20;

describe.skipIf(!keys().DATABASE_URL)(
  "Related Sessions evidence batch read is bounded in SQL",
  () => {
    afterEach(() => tracker.cleanup());

    it("returns the newest five of 200 sessions with a total of 200, and the statement returns only those five", async () => {
      const { organizationId, userId, documentId } = await seedOrganization();
      const sessions = await seedSessions(
        organizationId,
        userId,
        SESSION_COUNT
      );
      await withDb((db) =>
        db.agentSessionOperationEvidence.createMany({
          data: sessions.map((agentSessionId, index) =>
            evidence({
              organizationId,
              agentSessionId,
              targetArtifactId: documentId,
              relationshipKind: AttributionRelationshipKind.Revision,
              effectiveAt: new Date(BASE + index * 60_000),
            })
          ),
        })
      );

      const statementRowCounts: number[] = [];
      const result = await withDb.tx(async (tx) => {
        const queryRaw = vi.spyOn(tx, "$queryRaw");
        const read = await listRelatedSessionsForArtifacts(
          organizationId,
          [documentId],
          LIMIT,
          undefined
        );
        for (const call of queryRaw.mock.results) {
          const rows: unknown = await call.value;
          statementRowCounts.push(Array.isArray(rows) ? rows.length : 0);
        }
        return read;
      });

      const page = result[documentId];
      expect(page?.total).toBe(SESSION_COUNT);
      expect(page?.items.map((item) => item.sessionArtifactId)).toEqual(
        sessions.slice(-LIMIT).reverse()
      );
      expect(statementRowCounts.length).toBeGreaterThan(0);
      expect(Math.max(...statementRowCounts)).toBe(LIMIT);
    });

    it("folds each session to its strongest kind and newest time per target, and breaks a time tie by session id", async () => {
      const { organizationId, userId, documentId, secondDocumentId } =
        await seedOrganization();
      const [first, second, third] = (
        await seedSessions(organizationId, userId, 3)
      ).sort();
      const tied = new Date(BASE + 10 * 60_000);
      const earlier = new Date(BASE);
      await withDb(async (db) => {
        await db.agentSessionOperationEvidence.createMany({
          data: [
            evidence({
              organizationId,
              agentSessionId: third,
              targetArtifactId: documentId,
              relationshipKind: AttributionRelationshipKind.CommentReview,
              effectiveAt: tied,
            }),
            evidence({
              organizationId,
              agentSessionId: second,
              targetArtifactId: documentId,
              relationshipKind: AttributionRelationshipKind.CommentReview,
              effectiveAt: tied,
            }),
            evidence({
              organizationId,
              agentSessionId: first,
              targetArtifactId: documentId,
              relationshipKind: AttributionRelationshipKind.Usage,
              effectiveAt: new Date(BASE + 20 * 60_000),
            }),
            evidence({
              organizationId,
              agentSessionId: first,
              targetArtifactId: secondDocumentId,
              relationshipKind: AttributionRelationshipKind.Creation,
              effectiveAt: earlier,
            }),
          ],
        });
        await db.artifactLink.create({
          data: {
            organizationId,
            sourceId: second,
            targetId: documentId,
            linkType: LinkType.RelatesTo,
            branchParticipation: BranchParticipationKind.Wrote,
            metadata: {},
            lastContributedAt: earlier,
          },
          select: { id: true },
        });
      });

      const result = await listRelatedSessionsForArtifacts(
        organizationId,
        [documentId, secondDocumentId],
        10,
        undefined
      );

      expect(result[documentId]).toMatchObject({
        total: 2,
        items: [
          {
            sessionArtifactId: second,
            kind: ProvenanceRelationshipKind.Contribution,
            contributedAt: tied.toISOString(),
          },
          {
            sessionArtifactId: third,
            kind: ProvenanceRelationshipKind.Comment,
            contributedAt: tied.toISOString(),
          },
        ],
      });
      expect(result[secondDocumentId]).toMatchObject({
        total: 1,
        items: [
          {
            sessionArtifactId: first,
            kind: ProvenanceRelationshipKind.Contribution,
            contributedAt: earlier.toISOString(),
          },
        ],
      });
    });
  }
);

async function seedOrganization() {
  const organizationId = await tracker.create();
  const user = await createTestUser(organizationId);
  const projectId = await createTestProject(organizationId, user.id);
  const [documentId, secondDocumentId] = await withDb((db) =>
    Promise.all(
      ["Plan", "Spec"].map((name) =>
        db.artifact
          .create({
            data: {
              name,
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
          .then((document) => document.id)
      )
    )
  );
  if (documentId === undefined || secondDocumentId === undefined) {
    throw new Error("seed documents were not created");
  }
  return { organizationId, userId: user.id, documentId, secondDocumentId };
}

async function seedSessions(
  organizationId: string,
  userId: string,
  count: number
): Promise<string[]> {
  const sessions: string[] = [];
  for (let start = 0; start < count; start += SEED_CONCURRENCY) {
    const batch = Array.from(
      { length: Math.min(SEED_CONCURRENCY, count - start) },
      (_, offset) =>
        createTestSessionDetail({
          organizationId,
          userId,
          label: `bounded-${start + offset}`,
        })
    );
    sessions.push(...(await Promise.all(batch)));
  }
  return sessions;
}

function evidence(params: {
  organizationId: string;
  agentSessionId: string;
  targetArtifactId: string;
  relationshipKind: AttributionRelationshipKind;
  effectiveAt: Date;
}) {
  return {
    ...params,
    claimKey: `claude:toolu_${params.targetArtifactId}`,
    outcome: OperationEvidenceOutcome.Committed,
    operationKind: OperationKind.CreateVersion,
    source: OperationSource.Mcp,
    anchors: {},
    extractorVersion: 3,
    policyVersion: ATTRIBUTION_POLICY_VERSION,
  };
}
