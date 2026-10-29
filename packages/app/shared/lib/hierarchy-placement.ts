import {
  type ProjectArtifactPlacementPosition as PlacementPosition,
  ProjectArtifactPlacementPosition,
} from "@repo/api/src/types/project-artifact-placement";
import { PROJECT_TREE_MAX_VISIBLE_LEVELS } from "@repo/api/src/types/project-tree";

export type HierarchyPlacementDirection = "down" | "in" | "out" | "up";

export type HierarchyPlacementRow = {
  id: string;
  parentId: string | null;
  depth: number;
};

type HierarchyPlacementPosition = Exclude<
  PlacementPosition,
  typeof ProjectArtifactPlacementPosition.Root
>;

/** Resolve modifier-arrow hierarchy placement from one visible depth-first row list. */
export function resolveHierarchyKeyboardPlacement(
  rows: readonly HierarchyPlacementRow[],
  artifactId: string,
  direction: HierarchyPlacementDirection,
  excludedIds: ReadonlySet<string> = new Set()
): { position: HierarchyPlacementPosition; targetArtifactId: string } | null {
  const index = rows.findIndex((row) => row.id === artifactId);
  if (index < 0) {
    return null;
  }
  if (direction === "up" || direction === "in") {
    const previous = siblingRow(rows, index, -1, excludedIds);
    if (!previous) {
      return null;
    }
    return {
      position:
        direction === "in"
          ? ProjectArtifactPlacementPosition.Inside
          : ProjectArtifactPlacementPosition.Before,
      targetArtifactId: previous.id,
    };
  }
  if (direction === "down") {
    const next = siblingRow(rows, index, 1, excludedIds);
    return next
      ? {
          position: ProjectArtifactPlacementPosition.After,
          targetArtifactId: next.id,
        }
      : null;
  }
  const parentId = rows[index]?.parentId;
  return parentId && !excludedIds.has(parentId)
    ? {
        position: ProjectArtifactPlacementPosition.After,
        targetArtifactId: parentId,
      }
    : null;
}

/** Reject a placement when any moved descendant would exceed the server's visible depth. */
export function fitsHierarchyPlacementDepth(
  rows: readonly HierarchyPlacementRow[],
  rowIndexById: ReadonlyMap<string, number>,
  sourceIds: readonly string[],
  targetId: string,
  position: HierarchyPlacementPosition
): boolean {
  const targetIndex = rowIndexById.get(targetId);
  const target = targetIndex === undefined ? undefined : rows[targetIndex];
  if (!target) {
    return false;
  }
  const destinationDepth =
    target.depth +
    (position === ProjectArtifactPlacementPosition.Inside ? 1 : 0);
  return sourceIds.every((sourceId) => {
    const sourceIndex = rowIndexById.get(sourceId);
    if (sourceIndex === undefined) {
      return false;
    }
    const source = rows[sourceIndex];
    if (!source) {
      return false;
    }
    let subtreeDepth = 0;
    for (let index = sourceIndex + 1; index < rows.length; index += 1) {
      const descendant = rows[index];
      if (!descendant || descendant.depth <= source.depth) {
        break;
      }
      subtreeDepth = Math.max(subtreeDepth, descendant.depth - source.depth);
    }
    return destinationDepth + subtreeDepth < PROJECT_TREE_MAX_VISIBLE_LEVELS;
  });
}

function siblingRow(
  rows: readonly HierarchyPlacementRow[],
  index: number,
  offset: -1 | 1,
  excludedIds: ReadonlySet<string>
): HierarchyPlacementRow | null {
  const depth = rows[index]?.depth ?? 0;
  for (
    let cursor = index + offset;
    cursor >= 0 && cursor < rows.length;
    cursor += offset
  ) {
    const candidate = rows[cursor];
    if (!candidate || candidate.depth < depth) {
      return null;
    }
    if (candidate.depth === depth && !excludedIds.has(candidate.id)) {
      return candidate;
    }
  }
  return null;
}
