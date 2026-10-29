import {
  ProjectArtifactPlacementPosition,
  type ProjectArtifactPlacementRootUpdates,
  ProjectArtifactPlacementSource,
} from "@repo/api/src/types/project-artifact-placement";
import { PROJECT_TREE_MAX_VISIBLE_LEVELS } from "@repo/api/src/types/project-tree";
import {
  type ArtifactHierarchyDropPlacement,
  artifactParentIds,
  moveArtifactHierarchySubtree,
} from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-hierarchy";
import type { ArtifactListShellController } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-list-shell-content";
import type { GenericArtifact } from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures";
import {
  hierarchyTargetGroupUpdates,
  type ProjectArtifactGroupController,
} from "./project-artifact-group-updates";

type ProjectArtifactHierarchyDropController = ProjectArtifactGroupController & {
  hierarchyView: Pick<
    ArtifactListShellController["hierarchyView"],
    "syncExpansionAfterMove" | "toggleExpanded"
  >;
};

/** Apply the same depth and cycle check to preview, pointer commit, and keyboard commit. */
export function canPlaceProjectArtifactSubtrees(
  rows: readonly GenericArtifact[],
  sourceIds: readonly string[],
  targetId: string,
  placement: ArtifactHierarchyDropPlacement
): boolean {
  return sourceIds.every(
    (id) =>
      !moveArtifactHierarchySubtree(
        rows,
        id,
        targetId,
        placement,
        PROJECT_TREE_MAX_VISIBLE_LEVELS
      ).error
  );
}

/** Commit a valid project-list drop and expand its destination after success. */
export function submitProjectArtifactHierarchyDrop({
  row,
  target,
  placement,
  controller,
  rows,
  sourceIds,
  submitMove,
}: {
  row: GenericArtifact;
  target: GenericArtifact;
  placement: ArtifactHierarchyDropPlacement;
  controller: ProjectArtifactHierarchyDropController;
  rows: readonly GenericArtifact[];
  sourceIds: string[];
  submitMove: (input: {
    artifactIds: string[];
    placement: ArtifactHierarchyDropPlacement;
    targetArtifactId: string;
    rootUpdates?: ProjectArtifactPlacementRootUpdates;
    source: typeof ProjectArtifactPlacementSource.Pointer;
  }) => Promise<unknown>;
}): void {
  const rootUpdates = hierarchyTargetGroupUpdates(
    row.id,
    target.id,
    controller,
    rows
  );
  if (rootUpdates === null) {
    return;
  }
  submitMove({
    artifactIds: sourceIds,
    placement,
    targetArtifactId: target.id,
    ...(rootUpdates ? { rootUpdates } : {}),
    source: ProjectArtifactPlacementSource.Pointer,
  })
    .then(() => {
      controller.hierarchyView.syncExpansionAfterMove(
        rows,
        placement === ProjectArtifactPlacementPosition.Inside
          ? target.id
          : undefined
      );
      if (
        placement === ProjectArtifactPlacementPosition.Inside &&
        !artifactParentIds(rows).has(target.id)
      ) {
        controller.hierarchyView.toggleExpanded(target.id);
      }
    })
    .catch(() => undefined);
}
