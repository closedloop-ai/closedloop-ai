import { ArtifactType } from "@repo/api/src/types/artifact";
import type {
  ProjectTreeResponse,
  TreeChild,
  TreeNode,
} from "@repo/api/src/types/project-tree";

/**
 * Drop every BRANCH from a My Tasks tree, and everything hanging off one.
 *
 * Branches are not tasks, so My Tasks shows none (ISS-12463). One route the
 * anchor query does not close remains: the assigned-tree endpoint's DOWNWARD
 * walk still materializes a branch that hangs off an assigned issue. ISS-12637
 * retired the per-project fan-out, which was the other. Pruning the assembled
 * tree is where that is caught.
 *
 * A session's canonical parent is its branch, so a removed branch must take its
 * subtree with it — leaving the sessions behind would promote rows that never
 * stood on their own into orphans with a `parentId` pointing at nothing.
 *
 * Returns the SAME object when nothing matched, so a branch-free board keeps
 * referential stability through the `useMemo` chain downstream.
 */
export function pruneBranchSubtrees<T extends ProjectTreeResponse | null>(
  tree: T
): T | ProjectTreeResponse {
  // Both absent shapes reach here: the tree source's own contract says `null`,
  // while the query hooks it reads return `undefined` until the first response
  // lands. Narrowing on `=== null` alone threw on every pending render.
  if (!tree) {
    return tree;
  }

  const keptNodes: TreeNode[] = [];
  let changed = false;
  for (const node of tree.nodes) {
    if (node.root.type === ArtifactType.Branch) {
      changed = true;
      continue;
    }
    const children = pruneBranchChildren(node.children);
    if (children === node.children) {
      keptNodes.push(node);
      continue;
    }
    changed = true;
    keptNodes.push({ root: node.root, children });
  }

  const externalParents = tree.externalParents.filter(
    (link) => link.parent.type !== ArtifactType.Branch
  );
  if (externalParents.length !== tree.externalParents.length) {
    changed = true;
  }
  if (!changed) {
    return tree;
  }
  return { ...tree, externalParents, nodes: keptNodes };
}

/**
 * `TreeNode.children` is FLAT and depth-first, each child naming its own
 * `parentId`, so a branch's subtree is not a nested object to drop — it is the
 * run of later entries whose parent chain reaches that branch. Collecting the
 * removed ids as the walk goes forward is sufficient because a parent always
 * precedes its children in that order.
 */
function pruneBranchChildren(children: TreeChild[]): TreeChild[] {
  const removedIds = new Set<string>();
  const kept: TreeChild[] = [];
  for (const child of children) {
    if (child.type === ArtifactType.Branch || removedIds.has(child.parentId)) {
      removedIds.add(child.id);
      continue;
    }
    kept.push(child);
  }
  return removedIds.size === 0 ? children : kept;
}
