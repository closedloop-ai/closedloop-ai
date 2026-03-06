import { ArtifactType } from "@repo/api/src/types/artifact";
import { EntityType, LinkType } from "@repo/api/src/types/entity-link";
import { ExternalLinkType } from "@repo/api/src/types/external-link";
import { keys } from "@repo/database/keys";
import { v7 as uuidv7 } from "uuid";
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
  const testUser = await createTestUser(testOrgId);
  const testProjectId = await createTestProject(testOrgId, testUser.id);
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
        { type: ArtifactType.Prd, title: "Feature PRD" }
      );
      const artifact2 = await createArtifact(
        testOrgId,
        testUser.id,
        testProjectId,
        { type: ArtifactType.ImplementationPlan, title: "Implementation Plan" }
      );

      const link = await entityLinksService.createLink(testOrgId, {
        sourceId: artifact1.id,
        sourceType: EntityType.Artifact,
        sourceVersion: 1,
        targetId: artifact2.id,
        targetType: EntityType.Artifact,
        targetVersion: 1,
        linkType: LinkType.Produces,
      });

      expect(link.id).toBeDefined();
      expect(link.sourceId).toBe(artifact1.id);
      expect(link.targetId).toBe(artifact2.id);
      expect(link.linkType).toBe(LinkType.Produces);

      // Find bidirectional links for artifact1
      const links1 = await entityLinksService.findLinks(
        testOrgId,
        artifact1.id,
        EntityType.Artifact
      );
      expect(links1).toHaveLength(1);
      expect(links1[0].id).toBe(link.id);

      // Find bidirectional links for artifact2
      const links2 = await entityLinksService.findLinks(
        testOrgId,
        artifact2.id,
        EntityType.Artifact
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
        { type: ArtifactType.Prd, title: "Feature PRD" }
      );
      const artifact2 = await createArtifact(
        testOrgId,
        testUser.id,
        testProjectId,
        { type: ArtifactType.ImplementationPlan, title: "Plan" }
      );

      await entityLinksService.createLink(testOrgId, {
        sourceId: artifact1.id,
        sourceType: EntityType.Artifact,
        targetId: artifact2.id,
        targetType: EntityType.Artifact,
        linkType: LinkType.Produces,
      });

      // Source links for artifact2 (what produced it?) -> artifact1
      const sourceLinks = await entityLinksService.findSourceLinks(
        testOrgId,
        artifact2.id,
        EntityType.Artifact,
        LinkType.Produces
      );
      expect(sourceLinks).toHaveLength(1);
      expect(sourceLinks[0].sourceId).toBe(artifact1.id);

      // Target links for artifact1 (what did it produce?) -> artifact2
      const targetLinks = await entityLinksService.findTargetLinks(
        testOrgId,
        artifact1.id,
        EntityType.Artifact,
        LinkType.Produces
      );
      expect(targetLinks).toHaveLength(1);
      expect(targetLinks[0].targetId).toBe(artifact2.id);

      // Source links for artifact1 (what produced it?) -> nothing
      const noSourceLinks = await entityLinksService.findSourceLinks(
        testOrgId,
        artifact1.id,
        EntityType.Artifact,
        LinkType.Produces
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
        { type: ArtifactType.ImplementationPlan, title: "Plan" }
      );

      const externalLink = await externalLinksService.create(testOrgId, {
        projectId: testProjectId,
        type: "PULL_REQUEST",
        title: "PR #42",
        externalUrl: "https://github.com/org/repo/pull/42",
      });

      const link = await entityLinksService.createLink(testOrgId, {
        sourceId: artifact.id,
        sourceType: EntityType.Artifact,
        targetId: externalLink.id,
        targetType: EntityType.ExternalLink,
        linkType: LinkType.Produces,
      });

      expect(link.sourceType).toBe(EntityType.Artifact);
      expect(link.targetType).toBe(EntityType.ExternalLink);

      // Verify bidirectional lookup works
      const fromArtifact = await entityLinksService.findLinks(
        testOrgId,
        artifact.id,
        EntityType.Artifact
      );
      expect(fromArtifact).toHaveLength(1);

      const fromExtLink = await entityLinksService.findLinks(
        testOrgId,
        externalLink.id,
        EntityType.ExternalLink
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
        { type: ArtifactType.Prd, title: "Test PRD" }
      );

      const resolved = await entityLinksService.resolveEntity(
        testOrgId,
        artifact.id,
        EntityType.Artifact
      );

      expect(resolved).not.toBeNull();
      expect(resolved!.type).toBe(EntityType.Artifact);
      expect(resolved!.entity.id).toBe(artifact.id);
    });
  });

  it("resolves external link entity", async () => {
    await autoRollbackTransaction(async () => {
      const { testOrgId, testProjectId } = await setupTestData();

      const externalLink = await externalLinksService.create(testOrgId, {
        projectId: testProjectId,
        type: ExternalLinkType.FigmaDesign,
        title: "Design File",
        externalUrl: "https://figma.com/file/abc",
      });

      const resolved = await entityLinksService.resolveEntity(
        testOrgId,
        externalLink.id,
        EntityType.ExternalLink
      );

      expect(resolved).not.toBeNull();
      expect(resolved!.type).toBe(EntityType.ExternalLink);
      expect(resolved!.entity.id).toBe(externalLink.id);
    });
  });

  it("returns null for nonexistent entity", async () => {
    await autoRollbackTransaction(async () => {
      const testOrgId = await createTestOrganization();
      const resolved = await entityLinksService.resolveEntity(
        testOrgId,
        "00000000-0000-0000-0000-000000000000",
        EntityType.Artifact
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
        { type: ArtifactType.Prd, title: "PRD" }
      );
      const artifact2 = await createArtifact(
        testOrgId,
        testUser.id,
        testProjectId,
        { type: "IMPLEMENTATION_PLAN", title: "Plan" }
      );

      const link = await entityLinksService.createLink(testOrgId, {
        sourceId: artifact1.id,
        sourceType: EntityType.Artifact,
        targetId: artifact2.id,
        targetType: EntityType.Artifact,
        linkType: LinkType.Produces,
      });

      await entityLinksService.deleteLink(link.id, testOrgId);

      const links = await entityLinksService.findLinks(
        testOrgId,
        artifact1.id,
        EntityType.Artifact
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
        { type: ArtifactType.Prd, title: "PRD" }
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
        { type: ArtifactType.ImplementationPlan, title: "Another Plan" }
      );

      // Create links: artifact1 -> artifact2, artifact1 -> artifact3
      await entityLinksService.createLink(testOrgId, {
        sourceId: artifact1.id,
        sourceType: EntityType.Artifact,
        targetId: artifact2.id,
        targetType: EntityType.Artifact,
        linkType: LinkType.Produces,
      });

      await entityLinksService.createLink(testOrgId, {
        sourceId: artifact1.id,
        sourceType: EntityType.Artifact,
        targetId: artifact3.id,
        targetType: EntityType.Artifact,
        linkType: LinkType.Produces,
      });

      // Verify links exist
      const before = await entityLinksService.findLinks(
        testOrgId,
        artifact1.id,
        EntityType.Artifact
      );
      expect(before).toHaveLength(2);

      // Delete all links for artifact1
      await entityLinksService.deleteAllLinks(
        testOrgId,
        artifact1.id,
        EntityType.Artifact
      );

      const after = await entityLinksService.findLinks(
        testOrgId,
        artifact1.id,
        EntityType.Artifact
      );
      expect(after).toHaveLength(0);
    });
  });

  describe("findLinkTree", () => {
    it("traverses a three-artifact chain", async () => {
      await autoRollbackTransaction(async () => {
        const { testOrgId, testProjectId, testUser } = await setupTestData();

        const prd = await createArtifact(
          testOrgId,
          testUser.id,
          testProjectId,
          { type: ArtifactType.Prd, title: "PRD" }
        );
        const plan = await createArtifact(
          testOrgId,
          testUser.id,
          testProjectId,
          { type: ArtifactType.ImplementationPlan, title: "Plan" }
        );
        const strategy = await createArtifact(
          testOrgId,
          testUser.id,
          uuidv7(),
          { type: ArtifactType.Prd, title: "Strategy" }
        );

        await entityLinksService.createLink(testOrgId, {
          sourceId: prd.id,
          sourceType: EntityType.Artifact,
          targetId: plan.id,
          targetType: EntityType.Artifact,
          linkType: LinkType.Produces,
        });
        await entityLinksService.createLink(testOrgId, {
          sourceId: plan.id,
          sourceType: EntityType.Artifact,
          targetId: strategy.id,
          targetType: EntityType.Artifact,
          linkType: LinkType.Produces,
        });

        const tree = await entityLinksService.findLinkTree(
          testOrgId,
          prd.id,
          EntityType.Artifact,
          "both",
          10
        );

        expect(tree).toHaveLength(2);
        expect(tree[0].fromEntityId).toBe(prd.id);
        expect(tree[1].fromEntityId).toBe(plan.id);
      });
    });

    it("traverses across entity types", async () => {
      await autoRollbackTransaction(async () => {
        const { testOrgId, testProjectId, testUser } = await setupTestData();

        const artifact = await createArtifact(
          testOrgId,
          testUser.id,
          testProjectId,
          { type: ArtifactType.Prd, title: "PRD" }
        );
        const externalLink = await externalLinksService.create(testOrgId, {
          projectId: testProjectId,
          type: "PULL_REQUEST",
          title: "PR #1",
          externalUrl: "https://github.com/org/repo/pull/1",
        });

        await entityLinksService.createLink(testOrgId, {
          sourceId: artifact.id,
          sourceType: EntityType.Artifact,
          targetId: externalLink.id,
          targetType: EntityType.ExternalLink,
          linkType: LinkType.Produces,
        });

        const tree = await entityLinksService.findLinkTree(
          testOrgId,
          artifact.id,
          EntityType.Artifact,
          "both",
          10
        );

        expect(tree).toHaveLength(1);
        expect(tree[0].link.targetType).toBe(EntityType.ExternalLink);
        expect(tree[0].fromEntityId).toBe(artifact.id);
      });
    });

    it("respects maxDepth", async () => {
      await autoRollbackTransaction(async () => {
        const { testOrgId, testProjectId, testUser } = await setupTestData();

        const a = await createArtifact(testOrgId, testUser.id, testProjectId, {
          type: ArtifactType.Prd,
          title: "A",
        });
        const b = await createArtifact(testOrgId, testUser.id, testProjectId, {
          type: ArtifactType.ImplementationPlan,
          title: "B",
        });
        const c = await createArtifact(testOrgId, testUser.id, uuidv7(), {
          type: ArtifactType.ImplementationPlan,
          title: "C",
        });

        await entityLinksService.createLink(testOrgId, {
          sourceId: a.id,
          sourceType: EntityType.Artifact,
          targetId: b.id,
          targetType: EntityType.Artifact,
          linkType: LinkType.Produces,
        });
        await entityLinksService.createLink(testOrgId, {
          sourceId: b.id,
          sourceType: EntityType.Artifact,
          targetId: c.id,
          targetType: EntityType.Artifact,
          linkType: LinkType.Produces,
        });

        // maxDepth=1: only direct links from A
        const shallow = await entityLinksService.findLinkTree(
          testOrgId,
          a.id,
          EntityType.Artifact,
          "both",
          1
        );

        expect(shallow).toHaveLength(1);
        expect(shallow[0].link.sourceId).toBe(a.id);
        expect(shallow[0].link.targetId).toBe(b.id);
      });
    });
  });

  describe("resolveLinkedEntities", () => {
    it("resolves the other entity on each link", async () => {
      await autoRollbackTransaction(async () => {
        const { testOrgId, testProjectId, testUser } = await setupTestData();

        const prd = await createArtifact(
          testOrgId,
          testUser.id,
          testProjectId,
          { type: ArtifactType.Prd, title: "Feature PRD" }
        );
        const plan = await createArtifact(
          testOrgId,
          testUser.id,
          testProjectId,
          { type: ArtifactType.ImplementationPlan, title: "Plan" }
        );

        const link = await entityLinksService.createLink(testOrgId, {
          sourceId: prd.id,
          sourceType: EntityType.Artifact,
          targetId: plan.id,
          targetType: EntityType.Artifact,
          linkType: LinkType.Produces,
        });

        const resolved = await entityLinksService.resolveLinkedEntities(
          testOrgId,
          [{ link, fromEntityId: prd.id }]
        );

        expect(resolved).toHaveLength(1);
        expect(resolved[0].id).toBe(link.id);
        expect(resolved[0].resolvedEntity).not.toBeNull();
        expect(resolved[0].resolvedEntity!.type).toBe("ARTIFACT");
        expect(resolved[0].resolvedEntity!.entity.id).toBe(plan.id);
      });
    });

    it("resolves cross-type links", async () => {
      await autoRollbackTransaction(async () => {
        const { testOrgId, testProjectId, testUser } = await setupTestData();

        const artifact = await createArtifact(
          testOrgId,
          testUser.id,
          testProjectId,
          { type: ArtifactType.ImplementationPlan, title: "Plan" }
        );

        const externalLink = await externalLinksService.create(testOrgId, {
          projectId: testProjectId,
          type: ExternalLinkType.PullRequest,
          title: "PR #99",
          externalUrl: "https://github.com/org/repo/pull/99",
        });

        const link = await entityLinksService.createLink(testOrgId, {
          sourceId: artifact.id,
          sourceType: "ARTIFACT",
          targetId: externalLink.id,
          targetType: "EXTERNAL_LINK",
          linkType: "PRODUCES",
        });

        const resolved = await entityLinksService.resolveLinkedEntities(
          testOrgId,
          [{ link, fromEntityId: artifact.id }]
        );

        expect(resolved).toHaveLength(1);
        expect(resolved[0].resolvedEntity!.type).toBe("EXTERNAL_LINK");
        expect(resolved[0].resolvedEntity!.entity.id).toBe(externalLink.id);
      });
    });

    it("resolves tree traversal with correct entity at each hop", async () => {
      await autoRollbackTransaction(async () => {
        const { testOrgId, testProjectId, testUser } = await setupTestData();

        const prd = await createArtifact(
          testOrgId,
          testUser.id,
          testProjectId,
          { type: ArtifactType.Prd, title: "PRD" }
        );
        const plan = await createArtifact(
          testOrgId,
          testUser.id,
          testProjectId,
          { type: ArtifactType.ImplementationPlan, title: "Plan" }
        );
        const pr = await externalLinksService.create(testOrgId, {
          projectId: testProjectId,
          type: ExternalLinkType.PullRequest,
          title: "PR #1",
          externalUrl: "https://github.com/org/repo/pull/1",
        });

        await entityLinksService.createLink(testOrgId, {
          sourceId: prd.id,
          sourceType: EntityType.Artifact,
          targetId: plan.id,
          targetType: EntityType.Artifact,
          linkType: LinkType.Produces,
        });
        await entityLinksService.createLink(testOrgId, {
          sourceId: plan.id,
          sourceType: EntityType.Artifact,
          targetId: pr.id,
          targetType: EntityType.ExternalLink,
          linkType: LinkType.Produces,
        });

        // findLinkTree returns annotated links with fromEntityId per hop
        const tree = await entityLinksService.findLinkTree(
          testOrgId,
          prd.id,
          EntityType.Artifact,
          "both",
          10
        );

        const resolved = await entityLinksService.resolveLinkedEntities(
          testOrgId,
          tree
        );

        expect(resolved).toHaveLength(2);
        // First link: PRD→Plan, discovered from PRD → resolves Plan
        expect(resolved[0].resolvedEntity!.type).toBe(EntityType.Artifact);
        expect(resolved[0].resolvedEntity!.entity.id).toBe(plan.id);
        // Second link: Plan→PR, discovered from Plan → resolves PR
        expect(resolved[1].resolvedEntity!.type).toBe(EntityType.ExternalLink);
        expect(resolved[1].resolvedEntity!.entity.id).toBe(pr.id);
      });
    });
  });

  it("filters links by linkType", async () => {
    await autoRollbackTransaction(async () => {
      const { testOrgId, testProjectId, testUser } = await setupTestData();

      const artifact1 = await createArtifact(
        testOrgId,
        testUser.id,
        testProjectId,
        { type: ArtifactType.Prd, title: "PRD" }
      );
      const artifact2 = await createArtifact(
        testOrgId,
        testUser.id,
        testProjectId,
        { type: ArtifactType.ImplementationPlan, title: "Plan" }
      );
      const artifact3 = await createArtifact(
        testOrgId,
        testUser.id,
        testProjectId,
        { type: ArtifactType.ImplementationPlan, title: "Another Plan" }
      );

      await entityLinksService.createLink(testOrgId, {
        sourceId: artifact1.id,
        sourceType: EntityType.Artifact,
        targetId: artifact2.id,
        targetType: EntityType.Artifact,
        linkType: LinkType.Produces,
      });

      await entityLinksService.createLink(testOrgId, {
        sourceId: artifact1.id,
        sourceType: EntityType.Artifact,
        targetId: artifact3.id,
        targetType: EntityType.Artifact,
        linkType: LinkType.RelatesTo,
      });

      // All links
      const all = await entityLinksService.findLinks(
        testOrgId,
        artifact1.id,
        EntityType.Artifact
      );
      expect(all).toHaveLength(2);

      // Only PRODUCES links
      const produces = await entityLinksService.findLinks(
        testOrgId,
        artifact1.id,
        EntityType.Artifact,
        LinkType.Produces
      );
      expect(produces).toHaveLength(1);
      expect(produces[0].linkType).toBe(LinkType.Produces);

      // Only RELATES_TO links
      const relatesTo = await entityLinksService.findLinks(
        testOrgId,
        artifact1.id,
        EntityType.Artifact,
        LinkType.RelatesTo
      );
      expect(relatesTo).toHaveLength(1);
      expect(relatesTo[0].linkType).toBe(LinkType.RelatesTo);
    });
  });
});
