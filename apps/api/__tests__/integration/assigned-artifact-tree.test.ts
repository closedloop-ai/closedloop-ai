import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { assignedArtifactTreeService } from "@/app/artifacts/assigned-artifact-tree-service";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

const env = keys();
const hasDatabase = !!env.DATABASE_URL;

/**
 * Real-database coverage for `GET /artifacts/assigned-tree` (FEA-1651).
 *
 * The unit suite (`app/artifacts/assigned-artifact-tree-service.test.ts`) proves
 * the service SHAPES its `where` clauses correctly against a mocked Prisma. It
 * cannot prove those clauses behave correctly against Postgres — an accidental
 * join or relation `include` could still surface a row a JS-object fake never
 * models. Since the parent-chain walk is precisely the path a cross-tenant row
 * could ride in on, org isolation gets asserted here against a real database
 * too, mirroring `project-tree.test.ts`.
 */
describe.skipIf(!hasDatabase)(
  "Assigned Artifact Tree Service Integration",
  () => {
    it("returns an empty tree when the user has nothing assigned", async () => {
      await autoRollbackTransaction(async () => {
        const orgId = await createTestOrganization();
        const user = await createTestUser(orgId);

        const result =
          await assignedArtifactTreeService.getAssignedArtifactTree(
            user.id,
            orgId
          );

        expect(result).toEqual({ nodes: [], externalParents: [] });
      });
    });

    it("roots an assigned artifact at the top of its same-project parent chain", async () => {
      await autoRollbackTransaction(async () => {
        const orgId = await createTestOrganization();
        const user = await createTestUser(orgId);
        const projectId = await createTestProject(orgId, user.id);

        const root = await createArtifact(orgId, projectId, "Root PRD");
        const middle = await createArtifact(orgId, projectId, "Middle Plan");
        const assigned = await createArtifact(
          orgId,
          projectId,
          "Assigned Feature",
          user.id
        );
        await createProducesLink(orgId, root.id, middle.id);
        await createProducesLink(orgId, middle.id, assigned.id);

        const result =
          await assignedArtifactTreeService.getAssignedArtifactTree(
            user.id,
            orgId
          );

        expect(result.nodes.map((node) => node.root.id)).toEqual([root.id]);
        expect(result.nodes[0]?.children.map((child) => child.id)).toEqual([
          middle.id,
          assigned.id,
        ]);
        expect(result.nodes[0]?.children.map((child) => child.depth)).toEqual([
          1, 2,
        ]);
      });
    });

    it("never surfaces another organization's artifact through the parent chain", async () => {
      await autoRollbackTransaction(async () => {
        const orgId = await createTestOrganization();
        const user = await createTestUser(orgId);
        const projectId = await createTestProject(orgId, user.id);

        const foreignOrgId = await createTestOrganization();
        const foreignUser = await createTestUser(foreignOrgId);
        const foreignProjectId = await createTestProject(
          foreignOrgId,
          foreignUser.id
        );
        const foreignParent = await createArtifact(
          foreignOrgId,
          foreignProjectId,
          "Other tenant's PRD"
        );

        const assigned = await createArtifact(
          orgId,
          projectId,
          "Assigned Feature",
          user.id
        );
        // The link row lives in the CALLER's organization while its source
        // artifact does not — the exact shape that would leak a cross-tenant row
        // if the ancestor hop were not org-scoped.
        await createProducesLink(orgId, foreignParent.id, assigned.id);

        const result =
          await assignedArtifactTreeService.getAssignedArtifactTree(
            user.id,
            orgId
          );

        const returnedIds = [
          ...result.nodes.flatMap((node) => [
            node.root.id,
            ...node.children.map((child) => child.id),
          ]),
          ...result.externalParents.map((entry) => entry.parent.id),
        ];
        expect(returnedIds).toContain(assigned.id);
        expect(returnedIds).not.toContain(foreignParent.id);
        expect(result.externalParents).toEqual([]);
      });
    });

    it("does not return another user's assigned artifacts", async () => {
      await autoRollbackTransaction(async () => {
        const orgId = await createTestOrganization();
        const user = await createTestUser(orgId);
        const teammate = await createTestUser(orgId);
        const projectId = await createTestProject(orgId, user.id);

        const mine = await createArtifact(orgId, projectId, "Mine", user.id);
        const theirs = await createArtifact(
          orgId,
          projectId,
          "Theirs",
          teammate.id
        );

        const result =
          await assignedArtifactTreeService.getAssignedArtifactTree(
            user.id,
            orgId
          );

        const returnedIds = result.nodes.flatMap((node) => [
          node.root.id,
          ...node.children.map((child) => child.id),
        ]);
        expect(returnedIds).toContain(mine.id);
        expect(returnedIds).not.toContain(theirs.id);
      });
    });

    it("records a cross-project parent as an external parent rather than a root", async () => {
      await autoRollbackTransaction(async () => {
        const orgId = await createTestOrganization();
        const user = await createTestUser(orgId);
        const projectId = await createTestProject(orgId, user.id);
        const otherProjectId = await createTestProject(orgId, user.id, {
          name: "Other Project",
        });

        const parent = await createArtifact(
          orgId,
          otherProjectId,
          "Cross-project PRD"
        );
        const assigned = await createArtifact(
          orgId,
          projectId,
          "Assigned Feature",
          user.id
        );
        await createProducesLink(orgId, parent.id, assigned.id);

        const result =
          await assignedArtifactTreeService.getAssignedArtifactTree(
            user.id,
            orgId
          );

        expect(result.nodes.map((node) => node.root.id)).toEqual([assigned.id]);
        expect(
          result.externalParents.map((entry) => [
            entry.childId,
            entry.parent.id,
          ])
        ).toEqual([[assigned.id, parent.id]]);
      });
    });
  }
);

function createArtifact(
  organizationId: string,
  projectId: string,
  name: string,
  assigneeId?: string
) {
  return withDb((db) =>
    db.artifact.create({
      data: {
        organizationId,
        projectId,
        assigneeId,
        type: ArtifactType.Document,
        name,
        // `Artifact.status` is a freeform column carrying several disjoint
        // vocabularies (PRD-495); the assigned tree never reads it.
        status: "DRAFT",
      },
    })
  );
}

function createProducesLink(
  organizationId: string,
  sourceId: string,
  targetId: string
) {
  return withDb((db) =>
    db.artifactLink.create({
      data: {
        organizationId,
        sourceId,
        targetId,
        linkType: LinkType.Produces,
      },
    })
  );
}
