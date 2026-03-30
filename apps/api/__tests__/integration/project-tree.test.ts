import { ArtifactType } from "@repo/api/src/types/artifact";
import { EntityType, LinkType } from "@repo/api/src/types/entity-link";
import { ExternalLinkType } from "@repo/api/src/types/external-link";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { artifactsService } from "@/app/artifacts/service";
import { featuresService } from "@/app/features/service";
import { projectTreeService } from "@/app/projects/[id]/tree/service";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

const env = keys();
const hasDatabase = !!env.DATABASE_URL;

/** Helper to create an entity link between two entities. */
function createEntityLink(
  organizationId: string,
  sourceId: string,
  sourceType: EntityType,
  targetId: string,
  targetType: EntityType,
  linkType: LinkType = LinkType.Produces
) {
  return withDb((db) =>
    db.entityLink.create({
      data: {
        organizationId,
        sourceId,
        sourceType,
        targetId,
        targetType,
        linkType,
      },
    })
  );
}

/** Helper to create an external link in a project. */
function createExternalLink(
  organizationId: string,
  projectId: string,
  title: string
) {
  return withDb((db) =>
    db.externalLink.create({
      data: {
        organizationId,
        projectId,
        type: ExternalLinkType.PullRequest,
        title,
        externalUrl: `https://github.com/test/repo/pull/${Date.now()}`,
      },
    })
  );
}

describe.skipIf(!hasDatabase)("Project Tree Service Integration", () => {
  it("returns empty nodes for an empty project", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const user = await createTestUser(orgId);
      const projectId = await createTestProject(orgId, user.id);

      const result = await projectTreeService.getProjectTree(projectId, orgId);

      expect(result.nodes).toEqual([]);
    });
  });

  it("returns orphan entities as standalone roots sorted lexicographically", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const user = await createTestUser(orgId);
      const projectId = await createTestProject(orgId, user.id);

      await artifactsService.create(orgId, user.id, {
        projectId,
        type: ArtifactType.Prd,
        title: "Zebra PRD",
        content: "content",
      });
      await artifactsService.create(orgId, user.id, {
        projectId,
        type: ArtifactType.ImplementationPlan,
        title: "Alpha Plan",
        content: "content",
      });
      await featuresService.create(orgId, user.id, {
        projectId,
        title: "Middle Feature",
      });

      const result = await projectTreeService.getProjectTree(projectId, orgId);

      expect(result.nodes).toHaveLength(3);
      // Lexicographic sort
      expect(result.nodes[0]!.root.title).toBe("Alpha Plan");
      expect(result.nodes[1]!.root.title).toBe("Middle Feature");
      expect(result.nodes[2]!.root.title).toBe("Zebra PRD");
      // All orphans have empty children
      for (const node of result.nodes) {
        expect(node.children).toEqual([]);
      }
    });
  });

  it("builds a simple chain with correct root and DFS children", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const user = await createTestUser(orgId);
      const projectId = await createTestProject(orgId, user.id);

      const a = await artifactsService.create(orgId, user.id, {
        projectId,
        type: ArtifactType.Prd,
        title: "A - Root PRD",
        content: "content",
      });
      const b = await artifactsService.create(orgId, user.id, {
        projectId,
        type: ArtifactType.ImplementationPlan,
        title: "B - Plan",
        content: "content",
      });
      const c = await artifactsService.create(orgId, user.id, {
        projectId,
        type: ArtifactType.Prd,
        title: "C - Sub PRD",
        content: "content",
      });

      // A → B → C
      await createEntityLink(
        orgId,
        a!.id,
        EntityType.Artifact,
        b!.id,
        EntityType.Artifact
      );
      await createEntityLink(
        orgId,
        b!.id,
        EntityType.Artifact,
        c!.id,
        EntityType.Artifact
      );

      const result = await projectTreeService.getProjectTree(projectId, orgId);

      expect(result.nodes).toHaveLength(1);
      const node = result.nodes[0]!;
      expect(node.root.id).toBe(a!.id);
      expect(node.children).toHaveLength(2);
      expect(node.children[0]!.id).toBe(b!.id);
      expect(node.children[0]!.depth).toBe(1);
      expect(node.children[1]!.id).toBe(c!.id);
      expect(node.children[1]!.depth).toBe(2);
    });
  });

  it("handles mixed entity types in a chain", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const user = await createTestUser(orgId);
      const projectId = await createTestProject(orgId, user.id);

      const feature = await featuresService.create(orgId, user.id, {
        projectId,
        title: "Root Feature",
      });
      const artifact = await artifactsService.create(orgId, user.id, {
        projectId,
        type: ArtifactType.Prd,
        title: "Child Artifact",
        content: "content",
      });
      const extLink = await createExternalLink(orgId, projectId, "Child PR");

      // Feature → Artifact → ExternalLink
      await createEntityLink(
        orgId,
        feature.id,
        EntityType.Feature,
        artifact!.id,
        EntityType.Artifact
      );
      await createEntityLink(
        orgId,
        artifact!.id,
        EntityType.Artifact,
        extLink.id,
        EntityType.ExternalLink
      );

      const result = await projectTreeService.getProjectTree(projectId, orgId);

      expect(result.nodes).toHaveLength(1);
      const node = result.nodes[0]!;
      expect(node.root.entityType).toBe(EntityType.Feature);
      expect(node.children[0]!.entityType).toBe(EntityType.Artifact);
      expect(node.children[1]!.entityType).toBe(EntityType.ExternalLink);
    });
  });

  it("produces separate nodes for independent chains, sorted lexicographically", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const user = await createTestUser(orgId);
      const projectId = await createTestProject(orgId, user.id);

      // Chain 1: Z-Root → Z-Child
      const z1 = await artifactsService.create(orgId, user.id, {
        projectId,
        type: ArtifactType.Prd,
        title: "Z-Root",
        content: "content",
      });
      const z2 = await artifactsService.create(orgId, user.id, {
        projectId,
        type: ArtifactType.Prd,
        title: "Z-Child",
        content: "content",
      });
      await createEntityLink(
        orgId,
        z1!.id,
        EntityType.Artifact,
        z2!.id,
        EntityType.Artifact
      );

      // Chain 2: A-Root → A-Child
      const a1 = await artifactsService.create(orgId, user.id, {
        projectId,
        type: ArtifactType.Prd,
        title: "A-Root",
        content: "content",
      });
      const a2 = await artifactsService.create(orgId, user.id, {
        projectId,
        type: ArtifactType.Prd,
        title: "A-Child",
        content: "content",
      });
      await createEntityLink(
        orgId,
        a1!.id,
        EntityType.Artifact,
        a2!.id,
        EntityType.Artifact
      );

      const result = await projectTreeService.getProjectTree(projectId, orgId);

      expect(result.nodes).toHaveLength(2);
      expect(result.nodes[0]!.root.title).toBe("A-Root");
      expect(result.nodes[1]!.root.title).toBe("Z-Root");
    });
  });

  it("flattens branching tree with DFS order", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const user = await createTestUser(orgId);
      const projectId = await createTestProject(orgId, user.id);

      const root = await artifactsService.create(orgId, user.id, {
        projectId,
        type: ArtifactType.Prd,
        title: "Root",
        content: "content",
      });
      const child1 = await artifactsService.create(orgId, user.id, {
        projectId,
        type: ArtifactType.Prd,
        title: "Child1",
        content: "content",
      });
      const child2 = await artifactsService.create(orgId, user.id, {
        projectId,
        type: ArtifactType.Prd,
        title: "Child2",
        content: "content",
      });
      const grandchild = await artifactsService.create(orgId, user.id, {
        projectId,
        type: ArtifactType.Prd,
        title: "Grandchild",
        content: "content",
      });

      // root → child1, root → child2, child1 → grandchild
      await createEntityLink(
        orgId,
        root!.id,
        EntityType.Artifact,
        child1!.id,
        EntityType.Artifact
      );
      await createEntityLink(
        orgId,
        root!.id,
        EntityType.Artifact,
        child2!.id,
        EntityType.Artifact
      );
      await createEntityLink(
        orgId,
        child1!.id,
        EntityType.Artifact,
        grandchild!.id,
        EntityType.Artifact
      );

      const result = await projectTreeService.getProjectTree(projectId, orgId);

      expect(result.nodes).toHaveLength(1);
      const node = result.nodes[0]!;
      expect(node.root.id).toBe(root!.id);
      expect(node.children).toHaveLength(3);

      // DFS: child1 (depth 1), grandchild (depth 2), child2 (depth 1)
      expect(node.children[0]!.id).toBe(child1!.id);
      expect(node.children[0]!.depth).toBe(1);
      expect(node.children[1]!.id).toBe(grandchild!.id);
      expect(node.children[1]!.depth).toBe(2);
      expect(node.children[2]!.id).toBe(child2!.id);
      expect(node.children[2]!.depth).toBe(1);
    });
  });

  it("handles cycles without infinite loops", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const user = await createTestUser(orgId);
      const projectId = await createTestProject(orgId, user.id);

      const a = await artifactsService.create(orgId, user.id, {
        projectId,
        type: ArtifactType.Prd,
        title: "A",
        content: "content",
      });
      const b = await artifactsService.create(orgId, user.id, {
        projectId,
        type: ArtifactType.Prd,
        title: "B",
        content: "content",
      });
      const c = await artifactsService.create(orgId, user.id, {
        projectId,
        type: ArtifactType.Prd,
        title: "C",
        content: "content",
      });

      // A → B → C → A (cycle)
      await createEntityLink(
        orgId,
        a!.id,
        EntityType.Artifact,
        b!.id,
        EntityType.Artifact
      );
      await createEntityLink(
        orgId,
        b!.id,
        EntityType.Artifact,
        c!.id,
        EntityType.Artifact
      );
      await createEntityLink(
        orgId,
        c!.id,
        EntityType.Artifact,
        a!.id,
        EntityType.Artifact
      );

      const result = await projectTreeService.getProjectTree(projectId, orgId);

      // Should produce exactly 1 node with all 3 entities (no infinite loop)
      expect(result.nodes).toHaveLength(1);
      const node = result.nodes[0]!;
      expect(node.children).toHaveLength(2);
      // All 3 entity IDs should be present (1 root + 2 children)
      const allIds = [node.root.id, ...node.children.map((c) => c.id)];
      expect(allIds).toHaveLength(3);
      expect(new Set(allIds).size).toBe(3);
    });
  });

  it("ignores cross-project entity links", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const user = await createTestUser(orgId);
      const project1 = await createTestProject(orgId, user.id, {
        name: "Project 1",
      });
      const project2 = await createTestProject(orgId, user.id, {
        name: "Project 2",
      });

      const inProject = await artifactsService.create(orgId, user.id, {
        projectId: project1,
        type: ArtifactType.Prd,
        title: "In Project 1",
        content: "content",
      });
      const otherProject = await artifactsService.create(orgId, user.id, {
        projectId: project2,
        type: ArtifactType.Prd,
        title: "In Project 2",
        content: "content",
      });

      // Cross-project link
      await createEntityLink(
        orgId,
        inProject!.id,
        EntityType.Artifact,
        otherProject!.id,
        EntityType.Artifact
      );

      const result = await projectTreeService.getProjectTree(project1, orgId);

      // inProject should be an orphan root (link is cross-project, filtered out)
      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0]!.root.id).toBe(inProject!.id);
      expect(result.nodes[0]!.children).toEqual([]);
    });
  });

  it("picks earliest-created entity as root when multiple have zero incoming edges", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const user = await createTestUser(orgId);
      const projectId = await createTestProject(orgId, user.id);

      // Create source1 first (earliest), then source2
      const source1 = await artifactsService.create(orgId, user.id, {
        projectId,
        type: ArtifactType.Prd,
        title: "Source 1 (earliest)",
        content: "content",
      });
      const source2 = await artifactsService.create(orgId, user.id, {
        projectId,
        type: ArtifactType.Prd,
        title: "Source 2 (later)",
        content: "content",
      });
      const target = await artifactsService.create(orgId, user.id, {
        projectId,
        type: ArtifactType.Prd,
        title: "Shared Target",
        content: "content",
      });

      // Both source1 and source2 point to target (both have 0 incoming)
      await createEntityLink(
        orgId,
        source1!.id,
        EntityType.Artifact,
        target!.id,
        EntityType.Artifact
      );
      await createEntityLink(
        orgId,
        source2!.id,
        EntityType.Artifact,
        target!.id,
        EntityType.Artifact
      );

      const result = await projectTreeService.getProjectTree(projectId, orgId);

      expect(result.nodes).toHaveLength(1);
      // source1 is earliest → should be root
      expect(result.nodes[0]!.root.id).toBe(source1!.id);
      // source2 and target are children
      const childIds = result.nodes[0]!.children.map((c) => c.id);
      expect(childIds).toContain(source2!.id);
      expect(childIds).toContain(target!.id);
    });
  });
});
