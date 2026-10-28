/**
 * ISS-12552 (PRD-800 "Rollout"): the evidence-link writer reads
 * `attribution-evidence-policy` for the session's organization, a company
 * group flag, so every member's sessions and every reader in the organization
 * get the same answer. Links written while the flag was on stay when it is
 * turned off.
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
import { clearAttributionEvidenceGateMemo } from "@/lib/attribution-evidence-policy-feature";
import { syncSessionEvidenceLinks } from "./session-evidence-links";

const flag = vi.hoisted(() => ({ onClerkOrganizationIds: new Set<string>() }));
vi.mock(
  "@/lib/feature-flags/server-feature-flag-evaluation",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/feature-flags/server-feature-flag-evaluation")
    >()),
    evaluateServerFeatureFlagForOrganization: vi.fn(
      (_flag: unknown, clerkOrganizationId: string) =>
        Promise.resolve(flag.onClerkOrganizationIds.has(clerkOrganizationId))
    ),
  })
);

const tracker = createCommittedTestOrganizationTracker();

describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 evidence-link writer organization answer",
  () => {
    afterEach(async () => {
      flag.onClerkOrganizationIds.clear();
      clearAttributionEvidenceGateMemo();
      await tracker.cleanup();
    });

    it("links only the sessions of the organization the flag is on for", async () => {
      const on = await seed();
      const off = await seed();
      flag.onClerkOrganizationIds.add(on.clerkOrganizationId);

      await writeLinks(on);
      await writeLinks(off);

      expect(await evidenceLinkCount(on)).toBe(1);
      expect(await evidenceLinkCount(off)).toBe(0);
    });

    it("keeps the links already written when the flag is turned off", async () => {
      const fixture = await seed();
      flag.onClerkOrganizationIds.add(fixture.clerkOrganizationId);
      await writeLinks(fixture);
      flag.onClerkOrganizationIds.clear();
      // The organization's answer is memoized for a TTL; turning the flag
      // off takes effect once it lapses.
      clearAttributionEvidenceGateMemo();
      await withDb((db) =>
        db.agentSessionOperationEvidence.deleteMany({
          where: { agentSessionId: fixture.sessionId },
        })
      );

      await writeLinks(fixture);

      expect(await evidenceLinkCount(fixture)).toBe(1);
    });
  }
);

type Fixture = {
  organizationId: string;
  clerkOrganizationId: string;
  sessionId: string;
  documentId: string;
};

function writeLinks(fixture: Fixture): Promise<void> {
  return syncSessionEvidenceLinks(fixture.organizationId, [fixture.sessionId]);
}

function evidenceLinkCount(fixture: Fixture): Promise<number> {
  return withDb((db) =>
    db.artifactLink.count({
      where: {
        organizationId: fixture.organizationId,
        sourceId: fixture.sessionId,
        targetId: fixture.documentId,
      },
    })
  );
}

async function seed(): Promise<Fixture> {
  const organizationId = await tracker.create();
  const user = await createTestUser(organizationId);
  const projectId = await createTestProject(organizationId, user.id);
  const sessionId = await createTestSessionDetail({
    organizationId,
    userId: user.id,
    label: "flag-organization",
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
    await db.agentSessionOperationEvidence.create({
      data: {
        organizationId,
        agentSessionId: sessionId,
        claimKey: "claude:toolu_revise",
        targetArtifactId: document.id,
        relationshipKind: AttributionRelationshipKind.Revision,
        outcome: OperationEvidenceOutcome.Committed,
        operationKind: OperationKind.CreateVersion,
        source: OperationSource.Mcp,
        anchors: {},
        extractorVersion: 3,
        policyVersion: ATTRIBUTION_POLICY_VERSION,
      },
      select: { id: true },
    });
    return document.id;
  });
  const organization = await withDb((db) =>
    db.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { clerkId: true },
    })
  );
  return {
    organizationId,
    clerkOrganizationId: organization.clerkId,
    sessionId,
    documentId,
  };
}
