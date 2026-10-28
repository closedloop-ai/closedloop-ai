import { normalizeArtifactHierarchySelection } from "../../shared/components/generic-artifact-surface/preview/components/artifact-hierarchy";
import type { GenericArtifact } from "../../shared/components/generic-artifact-surface/preview/fixtures";

/** A selected descendant moves with its selected ancestor only once. */
export function selectedArtifactIdsForMove(
  id: string,
  rows: readonly GenericArtifact[],
  selectedArtifactIds: ReadonlySet<string>
): string[] {
  return selectedArtifactIds.has(id)
    ? normalizeArtifactHierarchySelection(rows, selectedArtifactIds)
    : [id];
}

/** Resolve adjacent status/priority groups without changing the row-drop writer. */
export function adjacentArtifactGroup(
  groups: readonly {
    key: string;
    items: readonly { id: string }[];
    subgroups?: readonly { key: string; items: readonly { id: string }[] }[];
  }[],
  rowId: string,
  offset: -1 | 1
): { destinationKey: string; subgroupKey?: string } | null {
  const index = groups.findIndex((group) =>
    group.items.some((item) => item.id === rowId)
  );
  const destination = groups[index + offset];
  if (!destination) {
    return null;
  }
  const subgroup = groups[index]?.subgroups?.find((group) =>
    group.items.some((item) => item.id === rowId)
  );
  return { destinationKey: destination.key, subgroupKey: subgroup?.key };
}

/** Complete a bulk move only after its single canonical writer succeeds. */
export async function moveProjectSelection(
  rows: readonly GenericArtifact[],
  selectedArtifactIds: ReadonlySet<string>,
  targetProjectId: string,
  move: (artifactIds: string[], targetProjectId: string) => Promise<unknown>,
  clearSelection: () => void
): Promise<void> {
  const artifactIds = normalizeArtifactHierarchySelection(
    rows,
    selectedArtifactIds
  );
  await move(artifactIds, targetProjectId);
  clearSelection();
}

/** Toggle every selected artifact toward one shared favorite state. */
export function favoriteProjectSelection(
  selectedArtifactIds: ReadonlySet<string>,
  favoriteIds: ReadonlySet<string>,
  mutate: (input: { artifactId: string; isFavorite: boolean }) => void
): void {
  const allFavorite = [...selectedArtifactIds].every((artifactId) =>
    favoriteIds.has(artifactId)
  );
  for (const artifactId of selectedArtifactIds) {
    mutate({ artifactId, isFavorite: allFavorite });
  }
}

/** Open deployments externally while internal artifacts retain app navigation. */
export function openProjectArtifactTarget(
  target: string | undefined,
  external: boolean,
  navigate: (target: string) => void
): void {
  if (!target) {
    return;
  }
  if (external) {
    globalThis.window.open(target, "_blank", "noopener,noreferrer");
  } else {
    navigate(target);
  }
}
