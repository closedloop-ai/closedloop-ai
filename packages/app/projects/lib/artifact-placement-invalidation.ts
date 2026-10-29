import { invalidateForBulkArtifactMutation } from "@repo/app/documents/hooks/bulk-artifact-invalidation";
import type { QueryClient } from "@tanstack/react-query";
import { projectTreeKeys } from "../hooks/project-tree-keys";
import { projectArtifactBoardPageKeys } from "../hooks/use-project-artifact-board-page";

export type ArtifactPlacementInvalidationReceipt = {
  affectedArtifactIds?: readonly string[];
  affectedProjectIds: readonly string[];
};

/** Refresh every artifact view affected by a foreground or background placement settlement. */
export function invalidateArtifactPlacementViews(
  queryClient: QueryClient,
  receipt: ArtifactPlacementInvalidationReceipt
): void {
  for (const projectId of new Set(receipt.affectedProjectIds)) {
    queryClient.invalidateQueries({
      queryKey: projectTreeKeys.detail(projectId),
    });
    queryClient.invalidateQueries({
      queryKey: projectArtifactBoardPageKeys.project(projectId),
    });
  }
  if (!receipt.affectedArtifactIds?.length) {
    return;
  }
  invalidateForBulkArtifactMutation(
    queryClient,
    { committedIds: receipt.affectedArtifactIds },
    { allLinkViews: true }
  );
}
