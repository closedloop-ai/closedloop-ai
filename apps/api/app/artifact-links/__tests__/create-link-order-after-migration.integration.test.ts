import { LinkType } from "@repo/api/src/types/artifact";
import { DocumentType } from "@repo/api/src/types/document";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { artifactLinksService } from "@/app/artifact-links/service";
import { projectTreeService } from "@/app/artifacts/project-tree-service";
import { documentService } from "@/app/documents/document-service";

describe.skipIf(!keys().DATABASE_URL)(
  "new artifact links after the rank migration",
  () => {
    it("preserves the creation-order hierarchy with manual ordering on and off", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const user = await createTestUser(organizationId);
        const projectId = await createTestProject(organizationId, user.id);
        const createDocument = async (title: string, sourceId?: string) => {
          const document = await documentService.create(
            organizationId,
            user.id,
            {
              projectId,
              sourceId,
              type: DocumentType.Prd,
              title,
              content: "Content",
            }
          );
          if (!document) {
            throw new Error("Document creation failed");
          }
          return document.id;
        };
        const parentId = await createDocument("Parent");
        const childIds = [
          await createDocument("First"),
          await createDocument("Second"),
          await createDocument("Third"),
        ];
        for (const targetId of childIds) {
          const result = await artifactLinksService.createLink(organizationId, {
            sourceId: parentId,
            targetId,
            linkType: LinkType.Produces,
          });
          expect(result.ok).toBe(true);
        }
        childIds.push(await createDocument("Fourth", parentId));
        const links = await withDb((db) =>
          db.artifactLink.findMany({
            where: {
              organizationId,
              sourceId: parentId,
              linkType: LinkType.Produces,
            },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            select: { targetId: true, sortOrder: true },
          })
        );
        expect(links.map((link) => link.targetId)).toEqual(childIds);
        expect(links.map((link) => link.sortOrder)).toEqual([
          0, 1000, 2000, 3000,
        ]);

        const off = await projectTreeService.getProjectTree(
          projectId,
          organizationId
        );
        const on = await projectTreeService.getManuallyOrderedProjectTree(
          projectId,
          organizationId
        );
        const childrenOf = (tree: typeof off) =>
          tree.nodes
            .find((node) => node.root.id === parentId)
            ?.children.map((child) => child.id);
        expect(childrenOf(off)).toEqual(childIds);
        expect(childrenOf(on)).toEqual(childrenOf(off));
      });
    });
  }
);
