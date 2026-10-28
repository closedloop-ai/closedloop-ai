import { LinkType } from "@repo/api/src/types/artifact";
import { DocumentType } from "@repo/api/src/types/document";
import { ProjectArtifactPlacementErrorReason } from "@repo/api/src/types/project-artifact-placement";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { unwrapCreatedLink } from "@/__tests__/support/artifact-links/create-link.test-helpers";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { artifactLinksService } from "@/app/artifact-links/service";
import { documentService } from "@/app/documents/document-service";

const hasDatabase = !!keys().DATABASE_URL;

async function createDocument(
  organizationId: string,
  userId: string,
  projectId: string,
  title: string
): Promise<string> {
  const artifact = await documentService.create(organizationId, userId, {
    projectId,
    type: DocumentType.Feature,
    title,
    content: "Content",
  });
  if (!artifact) {
    throw new Error("Failed to create test artifact");
  }
  return artifact.id;
}

function producesEdgeCount(organizationId: string, sourceId: string) {
  return withDb((db) =>
    db.artifactLink.count({
      where: { organizationId, sourceId, linkType: LinkType.Produces },
    })
  );
}

describe.skipIf(!hasDatabase)(
  "createLink PRODUCES cycle and depth admission",
  () => {
    it("refuses an edge that closes a cycle inside one project", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const user = await createTestUser(organizationId);
        const projectId = await createTestProject(organizationId, user.id);
        const [a, b, c] = [
          await createDocument(organizationId, user.id, projectId, "A"),
          await createDocument(organizationId, user.id, projectId, "B"),
          await createDocument(organizationId, user.id, projectId, "C"),
        ];
        for (const [sourceId, targetId] of [
          [a, b],
          [b, c],
        ]) {
          unwrapCreatedLink(
            await artifactLinksService.createLink(organizationId, {
              sourceId,
              targetId,
              linkType: LinkType.Produces,
            })
          );
        }

        await expect(
          artifactLinksService.createLink(organizationId, {
            sourceId: c,
            targetId: a,
            linkType: LinkType.Produces,
          })
        ).resolves.toEqual({
          ok: false,
          error: ProjectArtifactPlacementErrorReason.Cycle,
        });
        expect(await producesEdgeCount(organizationId, c)).toBe(0);
      });
    });

    it("refuses a cycle across projects and still admits a shared child", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const user = await createTestUser(organizationId);
        const firstProject = await createTestProject(organizationId, user.id);
        const secondProject = await createTestProject(organizationId, user.id);
        const prd = await createDocument(
          organizationId,
          user.id,
          firstProject,
          "PRD"
        );
        const plan = await createDocument(
          organizationId,
          user.id,
          secondProject,
          "Plan"
        );
        const issue = await createDocument(
          organizationId,
          user.id,
          secondProject,
          "Issue"
        );
        for (const [sourceId, targetId] of [
          [prd, plan],
          [plan, issue],
          [prd, issue],
        ]) {
          unwrapCreatedLink(
            await artifactLinksService.createLink(organizationId, {
              sourceId,
              targetId,
              linkType: LinkType.Produces,
            })
          );
        }

        await expect(
          artifactLinksService.createLink(organizationId, {
            sourceId: issue,
            targetId: prd,
            linkType: LinkType.Produces,
          })
        ).resolves.toEqual({
          ok: false,
          error: ProjectArtifactPlacementErrorReason.Cycle,
        });
        expect(await producesEdgeCount(organizationId, issue)).toBe(0);
      });
    });

    it("refuses a same-project edge past four levels and admits lineage across projects", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const user = await createTestUser(organizationId);
        const projectId = await createTestProject(organizationId, user.id);
        const otherProjectId = await createTestProject(organizationId, user.id);
        const chain: string[] = [];
        for (const title of ["L1", "L2", "L3", "L4"]) {
          chain.push(
            await createDocument(organizationId, user.id, projectId, title)
          );
        }
        for (let index = 1; index < chain.length; index += 1) {
          unwrapCreatedLink(
            await artifactLinksService.createLink(organizationId, {
              sourceId: chain[index - 1],
              targetId: chain[index],
              linkType: LinkType.Produces,
            })
          );
        }
        const fifth = await createDocument(
          organizationId,
          user.id,
          projectId,
          "L5"
        );
        const elsewhere = await createDocument(
          organizationId,
          user.id,
          otherProjectId,
          "Elsewhere"
        );

        await expect(
          artifactLinksService.createLink(organizationId, {
            sourceId: chain[3],
            targetId: fifth,
            linkType: LinkType.Produces,
          })
        ).resolves.toEqual({
          ok: false,
          error: ProjectArtifactPlacementErrorReason.MaxDepth,
        });
        expect(await producesEdgeCount(organizationId, chain[3])).toBe(0);

        unwrapCreatedLink(
          await artifactLinksService.createLink(organizationId, {
            sourceId: chain[3],
            targetId: elsewhere,
            linkType: LinkType.Produces,
          })
        );
        // Y already has its canonical parent Z, so a second parent at depth four
        // leaves the tree unchanged and is admitted.
        const z = await createDocument(organizationId, user.id, projectId, "Z");
        const y = await createDocument(organizationId, user.id, projectId, "Y");
        unwrapCreatedLink(
          await artifactLinksService.createLink(organizationId, {
            sourceId: z,
            targetId: y,
            linkType: LinkType.Produces,
          })
        );
        unwrapCreatedLink(
          await artifactLinksService.createLink(organizationId, {
            sourceId: chain[3],
            targetId: y,
            linkType: LinkType.Produces,
          })
        );
      });
    });

    it("leaves non-PRODUCES links free to point back up the lineage", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const user = await createTestUser(organizationId);
        const projectId = await createTestProject(organizationId, user.id);
        const parent = await createDocument(
          organizationId,
          user.id,
          projectId,
          "Parent"
        );
        const child = await createDocument(
          organizationId,
          user.id,
          projectId,
          "Child"
        );
        unwrapCreatedLink(
          await artifactLinksService.createLink(organizationId, {
            sourceId: parent,
            targetId: child,
            linkType: LinkType.Produces,
          })
        );

        const back = await artifactLinksService.createLink(organizationId, {
          sourceId: child,
          targetId: parent,
          linkType: LinkType.RelatesTo,
        });
        expect(back.ok).toBe(true);
      });
    });
  }
);
