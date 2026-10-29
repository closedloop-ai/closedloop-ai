import { LinkType } from "@repo/api/src/types/artifact";
import { BranchParticipationKind } from "@repo/api/src/types/branch";
import { ProvenanceRelationshipKind } from "@repo/api/src/types/provenance-relationship";
import {
  ArtifactRefRelation,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  createDocumentArtifact,
  createRelatedSessionLink,
} from "@/__tests__/support/agent-sessions/related-session.test-fixtures";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestSessionDetail,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import {
  classifySessionLinkKind,
  readLatestRelatedSessionContributionsForTargets,
} from "./provenance-eligibility";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

describeIfDb("related sessions batch SQL boundary (ISS-9570)", () => {
  it("returns a capped page and exact total without leaking another org", async () => {
    await autoRollbackTransaction(async () => {
      const orgA = await createTestOrganization();
      const orgB = await createTestOrganization();
      const userA = await createTestUser(orgA);
      const userB = await createTestUser(orgB);
      const targetA = await createDocumentArtifact(orgA, "target-a");
      const targetB = await createDocumentArtifact(orgB, "target-b");
      const newest = await createTestSessionDetail({
        organizationId: orgA,
        userId: userA.id,
        label: "newest",
      });
      const middle = await createTestSessionDetail({
        organizationId: orgA,
        userId: userA.id,
        label: "middle",
      });
      const oldest = await createTestSessionDetail({
        organizationId: orgA,
        userId: userA.id,
        label: "oldest",
      });
      const foreignSource = await createTestSessionDetail({
        organizationId: orgB,
        userId: userB.id,
        label: "foreign-source",
      });
      const wrongLinkOrg = await createTestSessionDetail({
        organizationId: orgA,
        userId: userA.id,
        label: "wrong-link-org",
      });
      const invalidMetadata = await createTestSessionDetail({
        organizationId: orgA,
        userId: userA.id,
        label: "invalid-metadata",
      });
      const metadataFallback = await createTestSessionDetail({
        organizationId: orgA,
        userId: userA.id,
        label: "metadata-fallback",
      });
      const documentSource = await createDocumentArtifact(orgA, "doc-source");
      const invalidMetadataPayload = {
        confidence: 2,
        relation: ArtifactRefRelation.Referenced,
        relationTypes: [SessionPrRelationType.Created],
      };

      await createRelatedSessionLink({
        organizationId: orgA,
        sourceId: newest,
        targetId: targetA,
        contributedAt: "2026-09-16T13:00:00.000Z",
      });
      await createRelatedSessionLink({
        organizationId: orgA,
        sourceId: middle,
        targetId: targetA,
        contributedAt: "2026-09-16T12:00:00.000Z",
      });
      await createRelatedSessionLink({
        organizationId: orgA,
        sourceId: oldest,
        targetId: targetA,
        contributedAt: "2026-09-16T11:00:00.000Z",
      });
      await createRelatedSessionLink({
        organizationId: orgA,
        sourceId: foreignSource,
        targetId: targetA,
        contributedAt: "2026-09-16T14:00:00.000Z",
      });
      await createRelatedSessionLink({
        organizationId: orgB,
        sourceId: wrongLinkOrg,
        targetId: targetA,
        contributedAt: "2026-09-16T15:00:00.000Z",
      });
      await createRelatedSessionLink({
        organizationId: orgA,
        sourceId: newest,
        targetId: targetB,
        contributedAt: "2026-09-16T16:00:00.000Z",
      });
      await createRelatedSessionLink({
        organizationId: orgA,
        sourceId: documentSource,
        targetId: targetA,
        contributedAt: "2026-09-16T17:00:00.000Z",
      });
      await createRelatedSessionLink({
        organizationId: orgA,
        sourceId: invalidMetadata,
        targetId: targetA,
        contributedAt: "2026-09-16T18:00:00.000Z",
        metadata: invalidMetadataPayload,
      });
      await createRelatedSessionLink({
        organizationId: orgA,
        sourceId: metadataFallback,
        targetId: targetA,
        contributedAt: "2026-09-16T10:30:00.000Z",
        branchParticipation: "future-participation",
        metadata: { branchParticipation: BranchParticipationKind.Wrote },
      });

      expect(
        classifySessionLinkKind({
          linkType: LinkType.RelatesTo,
          metadata: invalidMetadataPayload,
        })
      ).toBe(ProvenanceRelationshipKind.Reference);
      expect(
        classifySessionLinkKind({
          linkType: LinkType.RelatesTo,
          branchParticipation: "future-participation",
          metadata: { branchParticipation: BranchParticipationKind.Wrote },
        })
      ).toBe(ProvenanceRelationshipKind.Contribution);

      const page = await readLatestRelatedSessionContributionsForTargets({
        organizationId: orgA,
        artifactIds: [targetA, targetB],
        limit: 2,
      });

      expect(page.contributions).toEqual([
        {
          targetId: targetA,
          sessionArtifactId: newest,
          kind: ProvenanceRelationshipKind.Contribution,
          occurredAt: new Date("2026-09-16T13:00:00.000Z"),
        },
        {
          targetId: targetA,
          sessionArtifactId: middle,
          kind: ProvenanceRelationshipKind.Contribution,
          occurredAt: new Date("2026-09-16T12:00:00.000Z"),
        },
      ]);
      expect(page.totalByTarget.get(targetA)).toBe(4);
      expect(page.totalByTarget.has(targetB)).toBe(false);

      // ISS-12653: filtering and candidate search precede the display cap.
      const selected = await readLatestRelatedSessionContributionsForTargets({
        organizationId: orgA,
        artifactIds: [targetA, targetB],
        sessionArtifactIds: [oldest, foreignSource],
        limit: 1,
      });
      expect(
        selected.contributions.map((row) => row.sessionArtifactId)
      ).toEqual([oldest]);
      expect(selected.totalByTarget.get(targetA)).toBe(1);
      expect(selected.totalByTarget.has(targetB)).toBe(false);
      const searched = await readLatestRelatedSessionContributionsForTargets({
        organizationId: orgA,
        artifactIds: [targetA, targetB],
        sessionSearch: oldest,
        limit: 1,
      });
      expect(
        searched.contributions.map((row) => row.sessionArtifactId)
      ).toEqual([oldest]);
      const foreignSearch =
        await readLatestRelatedSessionContributionsForTargets({
          organizationId: orgA,
          artifactIds: [targetA, targetB],
          sessionSearch: foreignSource,
          limit: 1,
        });
      expect(foreignSearch.contributions).toEqual([]);
    });
  });
});
