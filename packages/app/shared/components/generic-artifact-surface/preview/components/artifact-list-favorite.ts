import type { ProductGridFavoriteController } from "../../../product-grid-table-v2";
import type { GenericArtifact } from "../fixtures";
import type { ArtifactListShellController } from "./artifact-list-shell-content";

/**
 * The shared star for every artifact list mount, the flat grid and the project
 * tree alike, so neither can drop it or its unavailable and in-flight states
 * (tamsinb and marisolashgrove review on #9116).
 */
export function artifactListFavorite(
  controller: Pick<
    ArtifactListShellController,
    | "favoriteArtifactIds"
    | "favoritesUnavailable"
    | "pendingFavoriteArtifactIds"
    | "setArtifactFavorite"
  >
): ProductGridFavoriteController<GenericArtifact> {
  return {
    favoriteIds: controller.favoriteArtifactIds,
    getArtifactId: (artifact) => artifact.id,
    getItemLabel: (artifact) => artifact.title,
    isUnavailable: controller.favoritesUnavailable,
    onChange: (artifact, favorited) =>
      controller.setArtifactFavorite(artifact.id, favorited),
    pendingIds: controller.pendingFavoriteArtifactIds,
  };
}
