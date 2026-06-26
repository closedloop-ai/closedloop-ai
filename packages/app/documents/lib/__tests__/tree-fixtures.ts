import {
  type Artifact,
  type ArtifactType,
  LinkType,
} from "@repo/api/src/types/artifact";
import type { TreeChild } from "@repo/api/src/types/project-tree";

/**
 * Shared project-tree test fixtures for the documents pipeline / row-action
 * suites. Extracted so `table-view-pipeline.test.ts` and
 * `table-row-actions.test.ts` build tree artifacts the same way instead of
 * each redefining `makeTreeArtifact` / `asChild`.
 */

export function makeTreeArtifact(id: string, type: ArtifactType): Artifact {
  return {
    id,
    organizationId: "org-1",
    projectId: "proj-1",
    type,
    subtype: null,
    name: `Artifact ${id}`,
    slug: id.toUpperCase(),
    status: "active",
    priority: null,
    assigneeId: null,
    assignee: null,
    dueDate: null,
    externalUrl: null,
    sortOrder: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    createdById: null,
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
  };
}

export function asChild(artifact: Artifact, parentId: string): TreeChild {
  return { ...artifact, linkType: LinkType.Produces, depth: 1, parentId };
}
