/**
 * The Related Sessions batch read narrows to the requested sessions, or to a
 * search, on the evidence read (ISS-12552, `attribution-evidence-policy` on)
 * exactly as on the legacy read.
 */
import {
  AttributionRelationshipKind,
  OperationEvidenceOutcome,
  OperationKind,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import { DocumentStatus } from "@repo/api/src/types/document";
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

describe.skipIf(!keys().DATABASE_URL)(
  "Related Sessions filter on the evidence read",
  () => {
    afterEach(() => tracker.cleanup());

    it("returns only the requested sessions, or only those the search names", async () => {
      const fixture = await seed();
      const read = (filter: {
        sessionArtifactIds?: string[];
        sessionSearch?: string;
      }) =>
        listRelatedSessionsForArtifacts(
          fixture.organizationId,
          [fixture.documentId],
          25,
          filter
        ).then((results) =>
          (results[fixture.documentId]?.items ?? [])
            .map((item) => item.sessionArtifactId)
            .sort()
        );

      expect(await read({})).toEqual([fixture.alpha, fixture.beta].sort());
      expect(await read({ sessionArtifactIds: [fixture.alpha] })).toEqual([
        fixture.alpha,
      ]);
      expect(await read({ sessionSearch: "BETA-ONLY" })).toEqual([
        fixture.beta,
      ]);
    });
  }
);

async function seed() {
  const organizationId = await tracker.create();
  const user = await createTestUser(organizationId);
  const projectId = await createTestProject(organizationId, user.id);
  const alpha = await createTestSessionDetail({
    organizationId,
    userId: user.id,
    label: "alpha-only",
  });
  const beta = await createTestSessionDetail({
    organizationId,
    userId: user.id,
    label: "beta-only",
  });
  const documentId = await withDb(async (db) => {
    const document = await db.artifact.create({
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
    });
    await db.agentSessionOperationEvidence.createMany({
      data: [alpha, beta].map((agentSessionId) => ({
        organizationId,
        agentSessionId,
        claimKey: "claude:toolu_revise",
        targetArtifactId: document.id,
        relationshipKind: AttributionRelationshipKind.Revision,
        outcome: OperationEvidenceOutcome.Committed,
        operationKind: OperationKind.CreateVersion,
        source: OperationSource.Mcp,
        anchors: {},
        extractorVersion: 3,
        policyVersion: ATTRIBUTION_POLICY_VERSION,
      })),
    });
    return document.id;
  });
  return { organizationId, userId: user.id, documentId, alpha, beta };
}
