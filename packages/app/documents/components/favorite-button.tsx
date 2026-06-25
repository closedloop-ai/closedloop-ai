"use client";

import { FavoriteButton as SharedFavoriteButton } from "@repo/design-system/components/ui/favorite-button";
import {
  useIsFavoriteArtifact,
  useToggleFavoriteArtifact,
} from "../hooks/use-artifact-favorites";

type FavoriteButtonProps = {
  artifactId: string;
  size?: "sm" | "default";
};

export function FavoriteButton({
  artifactId,
  size = "sm",
}: FavoriteButtonProps) {
  const isFavorite = useIsFavoriteArtifact(artifactId);
  const toggleFavorite = useToggleFavoriteArtifact();

  return (
    <SharedFavoriteButton
      isFavorite={isFavorite}
      isPending={toggleFavorite.isPending}
      onToggle={() => {
        toggleFavorite.mutate({ artifactId, isFavorite });
      }}
      size={size}
    />
  );
}
