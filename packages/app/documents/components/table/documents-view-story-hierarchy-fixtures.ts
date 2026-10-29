import { LinkType } from "@repo/api/src/types/artifact";
import { HierarchyAvailability } from "@repo/api/src/types/project-tree";
import type { makeRawArtifact } from "@repo/app/shared/test-fixtures/documents";

/** Hierarchy metadata shared by the four-level and partial-page stories. */
export function hierarchyState(childCount: number, hierarchyPath: string[]) {
  return {
    availability: HierarchyAvailability.Complete,
    canMove: true,
    childCount,
    hierarchyPath,
  };
}

export function hierarchyChild(
  artifact: ReturnType<typeof makeRawArtifact>,
  parentId: string,
  depth: number,
  hierarchyPath: string[]
) {
  return {
    ...artifact,
    depth,
    hierarchy: hierarchyState(depth < 3 ? 1 : 0, hierarchyPath),
    linkType: LinkType.Produces,
    parentId,
  };
}
