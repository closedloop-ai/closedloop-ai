import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import { DocumentType } from "@repo/api/src/types/document";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { projectTreeService } from "@/app/artifacts/project-tree-service";
import { documentService } from "@/app/documents/document-service";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

const env = keys();
const hasDatabase = !!env.DATABASE_URL;

/** Helper to create an artifact link between two artifacts. */
function createArtifactLink(
  organizationId: string,
  sourceId: string,
  targetId: string,
  linkType: LinkType = LinkType.Produces
) {
  return withDb((db) =>
    db.artifactLink.create({
      data: {
        organizationId,
        sourceId,
        targetId,
        linkType,
      },
    })
  );
}

/**
 * Helper to create a DEPLOYMENT-typed artifact. Used to stand in for the
 * legacy ExternalLink seeding — both surface on the wire as
 * `EntityType.ExternalLink` via the tree service.
 */
function createExternalLinkArtifact(
  organizationId: string,
  projectId: string,
  title: string
) {
  return withDb((db) =>
    db.artifact.create({
      data: {
        organizationId,
        projectId,
        type: ArtifactType.Deployment,
        name: title,
        status: "ACTIVE",
        externalUrl: `https://example.com/deployments/${Date.now()}`,
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
      expect(result.externalParents).toEqual([]);
    });
  });

  it("returns orphan entities as standalone roots sorted lexicographically", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const user = await createTestUser(orgId);
      const projectId = await createTestProject(orgId, user.id);

      await documentService.create(orgId, user.id, {
        projectId,
        type: DocumentType.Prd,
        title: "Zebra PRD",
        content: "content",
      });
      await documentService.create(orgId, user.id, {
        projectId,
        type: DocumentType.ImplementationPlan,
        title: "Alpha Plan",
        content: "content",
      });
      await documentService.create(orgId, user.id, {
        projectId,
        type: DocumentType.Feature,
        title: "Middle Feature",
        content: "",
      });

      const result = await projectTreeService.getProjectTree(projectId, orgId);

      expect(result.nodes).toHaveLength(3);
      // Lexicographic sort
      expect(result.nodes[0]!.root.name).toBe("Alpha Plan");
      expect(result.nodes[1]!.root.name).toBe("Middle Feature");
      expect(result.nodes[2]!.root.name).toBe("Zebra PRD");
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

      const a = await documentService.create(orgId, user.id, {
        projectId,
        type: DocumentType.Prd,
        title: "A - Root PRD",
        content: "content",
      });
      const b = await documentService.create(orgId, user.id, {
        projectId,
        type: DocumentType.ImplementationPlan,
        title: "B - Plan",
        content: "content",
      });
      const c = await documentService.create(orgId, user.id, {
        projectId,
        type: DocumentType.Prd,
        title: "C - Sub PRD",
        content: "content",
      });

      // A → B → C
      await createArtifactLink(orgId, a!.id, b!.id);
      await createArtifactLink(orgId, b!.id, c!.id);

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

      const feature = await documentService.create(orgId, user.id, {
        projectId,
        type: DocumentType.Feature,
        title: "Root Feature",
        content: "",
      });
      if (!feature) {
        throw new Error("Failed to create feature document in test");
      }
      const artifact = await documentService.create(orgId, user.id, {
        projectId,
        type: DocumentType.Prd,
        title: "Child Artifact",
        content: "content",
      });
      if (!artifact) {
        throw new Error("Failed to create artifact document in test");
      }
      const extLink = await createExternalLinkArtifact(
        orgId,
        projectId,
        "Child PR"
      );

      await createArtifactLink(orgId, feature.id, artifact.id);
      await createArtifactLink(orgId, artifact.id, extLink.id);

      const result = await projectTreeService.getProjectTree(projectId, orgId);

      expect(result.nodes).toHaveLength(1);
      const node = result.nodes[0]!;
      // Tree nodes expose Artifact rows directly — narrow on `type`.
      expect(node.root.type).toBe(ArtifactType.Document);
      expect(node.children[0]!.type).toBe(ArtifactType.Document);
      expect(node.children[1]!.type).toBe(ArtifactType.Deployment);
    });
  });

  it("produces separate nodes for independent chains, sorted lexicographically", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const user = await createTestUser(orgId);
      const projectId = await createTestProject(orgId, user.id);

      // Chain 1: Z-Root → Z-Child
      const z1 = await documentService.create(orgId, user.id, {
        projectId,
        type: DocumentType.Prd,
        title: "Z-Root",
        content: "content",
      });
      const z2 = await documentService.create(orgId, user.id, {
        projectId,
        type: DocumentType.Prd,
        title: "Z-Child",
        content: "content",
      });
      await createArtifactLink(orgId, z1!.id, z2!.id);

      // Chain 2: A-Root → A-Child
      const a1 = await documentService.create(orgId, user.id, {
        projectId,
        type: DocumentType.Prd,
        title: "A-Root",
        content: "content",
      });
      const a2 = await documentService.create(orgId, user.id, {
        projectId,
        type: DocumentType.Prd,
        title: "A-Child",
        content: "content",
      });
      await createArtifactLink(orgId, a1!.id, a2!.id);

      const result = await projectTreeService.getProjectTree(projectId, orgId);

      expect(result.nodes).toHaveLength(2);
      expect(result.nodes[0]!.root.name).toBe("A-Root");
      expect(result.nodes[1]!.root.name).toBe("Z-Root");
    });
  });

  it("flattens branching tree with DFS order", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const user = await createTestUser(orgId);
      const projectId = await createTestProject(orgId, user.id);

      const root = await documentService.create(orgId, user.id, {
        projectId,
        type: DocumentType.Prd,
        title: "Root",
        content: "content",
      });
      const child1 = await documentService.create(orgId, user.id, {
        projectId,
        type: DocumentType.Prd,
        title: "Child1",
        content: "content",
      });
      const child2 = await documentService.create(orgId, user.id, {
        projectId,
        type: DocumentType.Prd,
        title: "Child2",
        content: "content",
      });
      const grandchild = await documentService.create(orgId, user.id, {
        projectId,
        type: DocumentType.Prd,
        title: "Grandchild",
        content: "content",
      });

      // root → child1, root → child2, child1 → grandchild
      await createArtifactLink(orgId, root!.id, child1!.id);
      await createArtifactLink(orgId, root!.id, child2!.id);
      await createArtifactLink(orgId, child1!.id, grandchild!.id);

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

      const a = await documentService.create(orgId, user.id, {
        projectId,
        type: DocumentType.Prd,
        title: "A",
        content: "content",
      });
      const b = await documentService.create(orgId, user.id, {
        projectId,
        type: DocumentType.Prd,
        title: "B",
        content: "content",
      });
      const c = await documentService.create(orgId, user.id, {
        projectId,
        type: DocumentType.Prd,
        title: "C",
        content: "content",
      });

      // A → B → C → A (cycle)
      await createArtifactLink(orgId, a!.id, b!.id);
      await createArtifactLink(orgId, b!.id, c!.id);
      await createArtifactLink(orgId, c!.id, a!.id);

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

      const inProject = await documentService.create(orgId, user.id, {
        projectId: project1,
        type: DocumentType.Prd,
        title: "In Project 1",
        content: "content",
      });
      const otherProject = await documentService.create(orgId, user.id, {
        projectId: project2,
        type: DocumentType.Prd,
        title: "In Project 2",
        content: "content",
      });

      // Cross-project link: in-project source → out-of-project target.
      await createArtifactLink(orgId, inProject!.id, otherProject!.id);

      const result = await projectTreeService.getProjectTree(project1, orgId);

      // inProject should be an orphan root (link is cross-project, filtered out)
      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0]!.root.id).toBe(inProject!.id);
      expect(result.nodes[0]!.children).toEqual([]);
      // Outgoing cross-project link does not produce an external parent entry.
      expect(result.externalParents).toEqual([]);
    });
  });

  it("returns out-of-project parents in externalParents", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const user = await createTestUser(orgId);
      const projectA = await createTestProject(orgId, user.id, {
        name: "Project A",
      });
      const projectB = await createTestProject(orgId, user.id, {
        name: "Project B",
      });

      const externalParent = await documentService.create(orgId, user.id, {
        projectId: projectB,
        type: DocumentType.Prd,
        title: "External Parent PRD",
        content: "content",
      });
      const inProjectChild = await documentService.create(orgId, user.id, {
        projectId: projectA,
        type: DocumentType.ImplementationPlan,
        title: "In-project Child Plan",
        content: "content",
      });

      // External parent (projectB) → in-project child (projectA).
      await createArtifactLink(
        orgId,
        externalParent!.id,
        inProjectChild!.id,
        LinkType.Produces
      );

      const result = await projectTreeService.getProjectTree(projectA, orgId);

      // The child appears in the in-project tree as an orphan root (no
      // in-project parent links it).
      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0]!.root.id).toBe(inProjectChild!.id);

      // The external parent surfaces in externalParents, not in nodes.
      const nodeIds = result.nodes.flatMap((n) => [
        n.root.id,
        ...n.children.map((c) => c.id),
      ]);
      expect(nodeIds).not.toContain(externalParent!.id);

      expect(result.externalParents).toHaveLength(1);
      const entry = result.externalParents[0]!;
      expect(entry.childId).toBe(inProjectChild!.id);
      expect(entry.parent.id).toBe(externalParent!.id);
      expect(entry.parent.name).toBe("External Parent PRD");
      expect(entry.linkType).toBe(LinkType.Produces);
    });
  });

  it("collapses duplicate external parents per child link", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const user = await createTestUser(orgId);
      const projectA = await createTestProject(orgId, user.id, {
        name: "Project A",
      });
      const projectB = await createTestProject(orgId, user.id, {
        name: "Project B",
      });

      const externalParent = await documentService.create(orgId, user.id, {
        projectId: projectB,
        type: DocumentType.Prd,
        title: "Shared External Parent",
        content: "content",
      });
      const child1 = await documentService.create(orgId, user.id, {
        projectId: projectA,
        type: DocumentType.ImplementationPlan,
        title: "Child 1",
        content: "content",
      });
      const child2 = await documentService.create(orgId, user.id, {
        projectId: projectA,
        type: DocumentType.ImplementationPlan,
        title: "Child 2",
        content: "content",
      });

      await createArtifactLink(orgId, externalParent!.id, child1!.id);
      await createArtifactLink(orgId, externalParent!.id, child2!.id);

      const result = await projectTreeService.getProjectTree(projectA, orgId);

      // One entry per (child, parent) link — parent fetched once but appears
      // alongside both children.
      expect(result.externalParents).toHaveLength(2);
      const childIds = result.externalParents.map((e) => e.childId).sort();
      expect(childIds).toEqual([child1!.id, child2!.id].sort());
      for (const entry of result.externalParents) {
        expect(entry.parent.id).toBe(externalParent!.id);
      }
    });
  });

  it("picks earliest-created entity as root when multiple have zero incoming edges", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const user = await createTestUser(orgId);
      const projectId = await createTestProject(orgId, user.id);

      // Create source1 first (earliest), then source2
      const source1 = await documentService.create(orgId, user.id, {
        projectId,
        type: DocumentType.Prd,
        title: "Source 1 (earliest)",
        content: "content",
      });
      const source2 = await documentService.create(orgId, user.id, {
        projectId,
        type: DocumentType.Prd,
        title: "Source 2 (later)",
        content: "content",
      });
      const target = await documentService.create(orgId, user.id, {
        projectId,
        type: DocumentType.Prd,
        title: "Shared Target",
        content: "content",
      });

      // Both source1 and source2 point to target (both have 0 incoming)
      await createArtifactLink(orgId, source1!.id, target!.id);
      await createArtifactLink(orgId, source2!.id, target!.id);

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
