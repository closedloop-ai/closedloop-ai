import type { Artifact } from "@repo/api/src/types/artifact";
import type { TreeNode } from "@repo/api/src/types/project-tree";
// Intentional cross-slice dependency: a project tree links to its document
// artifacts, so projects/lib reuses the documents slice's canonical artifact
// route resolver rather than duplicating routing rules. Keep this pointed at
// the one generic resolver (getArtifactRoute), not document-specific helpers.
import {
  getArtifactRoute,
  withOrgSlug,
} from "@repo/app/documents/lib/document-navigation";

export type ParentEntry = { title: string; href: string | null };

/**
 * Populate `map` with child-id → immediate-parent entries for one tree node.
 * Uses `parentId` on each TreeChild to resolve the immediate parent.
 */
export function addNodeParentEntries(
  node: TreeNode,
  map: Map<string, ParentEntry>,
  orgSlug: string
): void {
  const rootEntry: ParentEntry = {
    title: node.root.name,
    href: withOrgSlug(orgSlug, getArtifactRoute(node.root)),
  };

  const childrenById = new Map<string, Artifact>(
    node.children.map((c) => [c.id, c])
  );
  for (const child of node.children) {
    if (child.parentId === node.root.id) {
      map.set(child.id, rootEntry);
    } else {
      const parent = childrenById.get(child.parentId);
      if (parent) {
        map.set(child.id, {
          title: parent.name,
          href: withOrgSlug(orgSlug, getArtifactRoute(parent)),
        });
      }
    }
  }
}
