import type { ArtifactType } from "@repo/api/src/types/artifact";
import { keys } from "@repo/database/keys";
import { artifactsService } from "@/app/artifacts/service";
import { entityLinksService } from "@/app/entity-links/service";
import { externalLinksService } from "@/app/external-links/service";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

const env = keys();
const hasDatabase = !!env.DATABASE_URL;

async function setupTestData() {
  const testOrgId = await createTestOrganization();
  const testProjectId = await createTestProject(testOrgId);
  const testUser = await createTestUser(testOrgId);
  return { testOrgId, testProjectId, testUser };
}

async function createArtifact(
  orgId: string,
  userId: string,
  projectId: string,
  overrides: { type: ArtifactType; title: string }
) {
  const artifact = await artifactsService.create(orgId, userId, {
    projectId,
    type: overrides.type,
    title: overrides.title,
    content: "Content",
  });
  if (!artifact) {
    throw new Error("Failed to create test artifact");
  }
  return artifact;
}

describe.skipIf(!hasDatabase)("Entity Links Service Integration", () => {
  it("creates and finds bidirectional entity links", async () => {
    await autoRollbackTransaction(async () => {
      const { testOrgId, testProjectId, testUser } = await setupTestData();

      const artifact1 = await createArtifact(
        testOrgId,
        testUser.id,
        testProjectId,
        { type: "PRD", title: "Feature PRD" }
      );
      const artifact2 = await createArtifact(
        testOrgId,
        testUser.id,
        testProjectId,
        { type: "IMPLEMENTATION_PLAN", title: "Implementation Plan" }
      );

      const link = await entityLinksService.createLink({
        sourceId: artifact1.id,
        sourceType: "ARTIFACT",
        sourceVersion: 1,
        targetId: artifact2.id,
        targetType: "ARTIFACT",
        targetVersion: 1,
        linkType: "PRODUCES",
      });

      expect(link.id).toBeDefined();
      expect(link.sourceId).toBe(artifact1.id);
      expect(link.targetId).toBe(artifact2.id);
      expect(link.linkType).toBe("PRODUCES");

      // Find bidirectional links for artifact1
      const links1 = await entityLinksService.findLinks(
        artifact1.id,
        "ARTIFACT"
      );
      expect(links1).toHaveLength(1);
      expect(links1[0].id).toBe(link.id);

      // Find bidirectional links for artifact2
      const links2 = await entityLinksService.findLinks(
        artifact2.id,
        "ARTIFACT"
      );
      expect(links2).toHaveLength(1);
      expect(links2[0].id).toBe(link.id);
    });
  });

  it("finds source and target links directionally", async () => {
    await autoRollbackTransaction(async () => {
      const { testOrgId, testProjectId, testUser } = await setupTestData();

      const artifact1 = await createArtifact(
        testOrgId,
        testUser.id,
        testProjectId,
        { type: "PRD", title: "Feature PRD" }
      );
      const artifact2 = await createArtifact(
        testOrgId,
        testUser.id,
        testProjectId,
        { type: "IMPLEMENTATION_PLAN", title: "Plan" }
      );

      await entityLinksService.createLink({
        sourceId: artifact1.id,
        sourceType: "ARTIFACT",
        targetId: artifact2.id,
        targetType: "ARTIFACT",
        linkType: "PRODUCES",
      });

      // Source links for artifact2 (what produced it?) -> artifact1
      const sourceLinks = await entityLinksService.findSourceLinks(
        artifact2.id,
        "ARTIFACT",
        "PRODUCES"
      );
      expect(sourceLinks).toHaveLength(1);
      expect(sourceLinks[0].sourceId).toBe(artifact1.id);

      // Target links for artifact1 (what did it produce?) -> artifact2
      const targetLinks = await entityLinksService.findTargetLinks(
        artifact1.id,
        "ARTIFACT",
        "PRODUCES"
      );
      expect(targetLinks).toHaveLength(1);
      expect(targetLinks[0].targetId).toBe(artifact2.id);

      // Source links for artifact1 (what produced it?) -> nothing
      const noSourceLinks = await entityLinksService.findSourceLinks(
        artifact1.id,
        "ARTIFACT",
        "PRODUCES"
      );
      expect(noSourceLinks).toHaveLength(0);
    });
  });

  it("links artifact to external link", async () => {
    await autoRollbackTransaction(async () => {
      const { testOrgId, testProjectId, testUser } = await setupTestData();

      const artifact = await createArtifact(
        testOrgId,
        testUser.id,
        testProjectId,
        { type: "IMPLEMENTATION_PLAN", title: "Plan" }
      );

      const externalLink = await externalLinksService.create(testOrgId, {
        type: "PULL_REQUEST",
        title: "PR #42",
        externalUrl: "https://github.com/org/repo/pull/42",
      });

      const link = await entityLinksService.createLink({
        sourceId: artifact.id,
        sourceType: "ARTIFACT",
        targetId: externalLink.id,
        targetType: "EXTERNAL_LINK",
        linkType: "PRODUCES",
      });

      expect(link.sourceType).toBe("ARTIFACT");
      expect(link.targetType).toBe("EXTERNAL_LINK");

      // Verify bidirectional lookup works
      const fromArtifact = await entityLinksService.findLinks(
        artifact.id,
        "ARTIFACT"
      );
      expect(fromArtifact).toHaveLength(1);

      const fromExtLink = await entityLinksService.findLinks(
        externalLink.id,
        "EXTERNAL_LINK"
      );
      expect(fromExtLink).toHaveLength(1);
    });
  });

  it("resolves entities by type", async () => {
    await autoRollbackTransaction(async () => {
      const { testOrgId, testProjectId, testUser } = await setupTestData();

      const artifact = await createArtifact(
        testOrgId,
        testUser.id,
        testProjectId,
        { type: "PRD", title: "Test PRD" }
      );

      const resolved = await entityLinksService.resolveEntity(
        artifact.id,
        "ARTIFACT"
      );

      expect(resolved).not.toBeNull();
      expect(resolved!.type).toBe("ARTIFACT");
      expect(resolved!.entity.id).toBe(artifact.id);
    });
  });

  it("resolves external link entity", async () => {
    await autoRollbackTransaction(async () => {
      const testOrgId = await createTestOrganization();

      const externalLink = await externalLinksService.create(testOrgId, {
        type: "FIGMA_DESIGN",
        title: "Design File",
        externalUrl: "https://figma.com/file/abc",
      });

      const resolved = await entityLinksService.resolveEntity(
        externalLink.id,
        "EXTERNAL_LINK"
      );

      expect(resolved).not.toBeNull();
      expect(resolved!.type).toBe("EXTERNAL_LINK");
      expect(resolved!.entity.id).toBe(externalLink.id);
    });
  });

  it("returns null for nonexistent entity", async () => {
    await autoRollbackTransaction(async () => {
      const resolved = await entityLinksService.resolveEntity(
        "00000000-0000-0000-0000-000000000000",
        "ARTIFACT"
      );
      expect(resolved).toBeNull();
    });
  });

  it("deletes a single entity link", async () => {
    await autoRollbackTransaction(async () => {
      const { testOrgId, testProjectId, testUser } = await setupTestData();

      const artifact1 = await createArtifact(
        testOrgId,
        testUser.id,
        testProjectId,
        { type: "PRD", title: "PRD" }
      );
      const artifact2 = await createArtifact(
        testOrgId,
        testUser.id,
        testProjectId,
        { type: "IMPLEMENTATION_PLAN", title: "Plan" }
      );

      const link = await entityLinksService.createLink({
        sourceId: artifact1.id,
        sourceType: "ARTIFACT",
        targetId: artifact2.id,
        targetType: "ARTIFACT",
        linkType: "PRODUCES",
      });

      await entityLinksService.deleteLink(link.id);

      const links = await entityLinksService.findLinks(
        artifact1.id,
        "ARTIFACT"
      );
      expect(links).toHaveLength(0);
    });
  });

  it("deletes all links for an entity", async () => {
    await autoRollbackTransaction(async () => {
      const { testOrgId, testProjectId, testUser } = await setupTestData();

      const artifact1 = await createArtifact(
        testOrgId,
        testUser.id,
        testProjectId,
        { type: "PRD", title: "PRD" }
      );
      const artifact2 = await createArtifact(
        testOrgId,
        testUser.id,
        testProjectId,
        { type: "IMPLEMENTATION_PLAN", title: "Plan" }
      );
      const artifact3 = await createArtifact(
        testOrgId,
        testUser.id,
        testProjectId,
        { type: "IMPLEMENTATION_PLAN", title: "Another Plan" }
      );

      // Create links: artifact1 -> artifact2, artifact1 -> artifact3
      await entityLinksService.createLink({
        sourceId: artifact1.id,
        sourceType: "ARTIFACT",
        targetId: artifact2.id,
        targetType: "ARTIFACT",
        linkType: "PRODUCES",
      });

      await entityLinksService.createLink({
        sourceId: artifact1.id,
        sourceType: "ARTIFACT",
        targetId: artifact3.id,
        targetType: "ARTIFACT",
        linkType: "PRODUCES",
      });

      // Verify links exist
      const before = await entityLinksService.findLinks(
        artifact1.id,
        "ARTIFACT"
      );
      expect(before).toHaveLength(2);

      // Delete all links for artifact1
      await entityLinksService.deleteAllLinks(artifact1.id, "ARTIFACT");

      const after = await entityLinksService.findLinks(
        artifact1.id,
        "ARTIFACT"
      );
      expect(after).toHaveLength(0);
    });
  });

  it("filters links by linkType", async () => {
    await autoRollbackTransaction(async () => {
      const { testOrgId, testProjectId, testUser } = await setupTestData();

      const artifact1 = await createArtifact(
        testOrgId,
        testUser.id,
        testProjectId,
        { type: "PRD", title: "PRD" }
      );
      const artifact2 = await createArtifact(
        testOrgId,
        testUser.id,
        testProjectId,
        { type: "IMPLEMENTATION_PLAN", title: "Plan" }
      );
      const artifact3 = await createArtifact(
        testOrgId,
        testUser.id,
        testProjectId,
        { type: "IMPLEMENTATION_PLAN", title: "Another Plan" }
      );

      await entityLinksService.createLink({
        sourceId: artifact1.id,
        sourceType: "ARTIFACT",
        targetId: artifact2.id,
        targetType: "ARTIFACT",
        linkType: "PRODUCES",
      });

      await entityLinksService.createLink({
        sourceId: artifact1.id,
        sourceType: "ARTIFACT",
        targetId: artifact3.id,
        targetType: "ARTIFACT",
        linkType: "RELATES_TO",
      });

      // All links
      const all = await entityLinksService.findLinks(artifact1.id, "ARTIFACT");
      expect(all).toHaveLength(2);

      // Only PRODUCES links
      const produces = await entityLinksService.findLinks(
        artifact1.id,
        "ARTIFACT",
        "PRODUCES"
      );
      expect(produces).toHaveLength(1);
      expect(produces[0].linkType).toBe("PRODUCES");

      // Only RELATES_TO links
      const relatesTo = await entityLinksService.findLinks(
        artifact1.id,
        "ARTIFACT",
        "RELATES_TO"
      );
      expect(relatesTo).toHaveLength(1);
      expect(relatesTo[0].linkType).toBe("RELATES_TO");
    });
  });
});
