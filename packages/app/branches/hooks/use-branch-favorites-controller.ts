"use client";

import type { ProductGridFavoriteController } from "@repo/app/shared/components/product-grid-table-v2";
import {
  useFavoriteArtifacts,
  useToggleFavoriteArtifact,
} from "../../documents/hooks/use-artifact-favorites";
import {
  useFavoriteArtifactIds,
  usePendingFavoriteArtifactIds,
} from "../../documents/hooks/use-favorite-artifact-ids";
import type { BranchRow } from "../lib/branch-row";

/** Connects cloud Branch artifact identities to the existing favorite store. */
export function useBranchFavoritesController(): ProductGridFavoriteController<BranchRow> {
  const { favoriteIds, isUnavailable } = useFavoriteArtifactIds(
    useFavoriteArtifacts()
  );
  const pendingIds = usePendingFavoriteArtifactIds();
  const favoriteWrite = useToggleFavoriteArtifact();
  return {
    favoriteIds,
    getArtifactId: (row) => row.artifactId,
    getItemLabel: (row) => row.branchName,
    isUnavailable,
    onChange: (row, favorited) => {
      if (row.artifactId) {
        favoriteWrite.mutate({
          artifactId: row.artifactId,
          isFavorite: !favorited,
        });
      }
    },
    pendingIds,
  };
}
