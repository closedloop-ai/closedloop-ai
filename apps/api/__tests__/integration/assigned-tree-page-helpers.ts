/**
 * DB seeding and the shipped-read probe shared by the ISS-10472 assigned-tree
 * page suites. Split out when the root-page suite crossed the file ceiling:
 * root SELECTION (`assigned-tree-root-page.test.ts`) and the subtree
 * MATERIALIZATION under a page's roots (`assigned-tree-page-subtrees.test.ts`)
 * are two responsibilities over one fixture vocabulary, so the vocabulary lives
 * here rather than in either of them.
 */

import { IssueStatus } from "@repo/api/src/types/document";
import { ArtifactSubtype, ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { assignedArtifactTreeService } from "@/app/artifacts/assigned-artifact-tree-service";
import { generateSlug } from "@/app/documents/document-utils";

const env = keys();
export const hasDatabase = !!env.DATABASE_URL;

/** Wider than the page under test, so a second page always exists. */
export const PAGE_SIZE = 10;

export type SeededArtifact = { id: string; projectId: string | null };

export async function seedArtifact(input: {
  organizationId: string;
  assigneeId: string | null;
  createdById: string;
  projectId: string | null;
  name: string;
  createdAt?: Date;
  sortOrder?: number;
}): Promise<SeededArtifact> {
  const row = await withDb((db) =>
    db.artifact.create({
      data: {
        name: input.name,
        slug: generateSlug(),
        type: ArtifactType.DOCUMENT,
        subtype: ArtifactSubtype.ISSUE,
        status: IssueStatus.Todo,
        organizationId: input.organizationId,
        createdById: input.createdById,
        assigneeId: input.assigneeId,
        projectId: input.projectId,
        ...(input.createdAt === undefined
          ? {}
          : { createdAt: input.createdAt }),
        ...(input.sortOrder === undefined
          ? {}
          : { sortOrder: input.sortOrder }),
      },
      select: { id: true, projectId: true },
    })
  );
  return { id: row.id, projectId: row.projectId };
}

/** A PRODUCES edge, parent produces child — the only parent-child link type. */
export async function link(
  organizationId: string,
  parentId: string,
  childId: string,
  sortOrder?: number
): Promise<void> {
  await withDb((db) =>
    db.artifactLink.create({
      data: {
        organizationId,
        sourceId: parentId,
        targetId: childId,
        linkType: "PRODUCES",
        ...(sortOrder === undefined ? {} : { sortOrder }),
      },
      select: { id: true },
    })
  );
}

/** The root ids the SHIPPED read reports, in its own order. */
export async function shippedRootIds(
  assigneeId: string,
  organizationId: string,
  viewerUserId: string
): Promise<string[]> {
  const tree = await assignedArtifactTreeService.getAssignedArtifactTree(
    assigneeId,
    organizationId,
    viewerUserId
  );
  // `TreeNode` is already the root group — `root` plus its flattened
  // `children` — so the shipped root list needs no parent filter.
  return tree.nodes.map((node) => node.root.id);
}
