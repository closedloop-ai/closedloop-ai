import { ProjectStatus } from "@repo/api/src/types/project";
import {
  ProjectArtifactBoardLayout,
  type ProjectArtifactBoardLayout as ProjectArtifactBoardLayoutValue,
} from "@repo/api/src/types/project-artifact-board-view";

/** Resolve the project artifact layout URL without losing unrelated view state. */
export function replaceProjectArtifactLayout(input: {
  layout: string;
  onValidLayout?: (layout: ProjectArtifactBoardLayoutValue) => void;
  pathname: string;
  replace: (href: string, options?: { scroll?: boolean }) => void;
  search: string;
}) {
  if (
    !(
      input.layout === ProjectArtifactBoardLayout.Board ||
      input.layout === ProjectArtifactBoardLayout.List
    )
  ) {
    return;
  }
  input.onValidLayout?.(input.layout);
  const params = new URLSearchParams(input.search);
  if (input.layout === ProjectArtifactBoardLayout.Board) {
    params.set("layout", input.layout);
  } else {
    params.delete("layout");
  }
  const query = params.toString();
  input.replace(query ? `${input.pathname}?${query}` : input.pathname, {
    scroll: false,
  });
}

export function favoriteIconClass(
  isFavorite: boolean,
  mutedWhenNotFavorite: boolean
) {
  if (isFavorite) {
    return "h-4 w-4 fill-yellow-400 text-yellow-400";
  }
  return mutedWhenNotFavorite ? "h-4 w-4 text-muted-foreground" : "h-4 w-4";
}

export function isFavoriteDisabled(isPending: boolean, status: ProjectStatus) {
  return isPending || status === ProjectStatus.Archived;
}

export function getFavoriteButtonLabel(
  status: ProjectStatus,
  isFavorite: boolean
) {
  if (status === ProjectStatus.Archived) {
    return "Archived projects cannot be favorited";
  }
  if (isFavorite) {
    return "Remove from favorites";
  }
  return "Add to favorites";
}

export function getFavoriteMenuLabel(
  status: ProjectStatus,
  isFavorite: boolean
) {
  if (status === ProjectStatus.Archived) {
    return "Favorites unavailable while archived";
  }
  if (isFavorite) {
    return "Remove from Favorites";
  }
  return "Add to Favorites";
}
