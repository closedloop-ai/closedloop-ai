import type { GenericArtifact } from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures";
import type { GridTableGroup } from "@repo/design-system/components/ui/grid-table";

/** Decorate board rows with comment counts from the independently loaded interaction read. */
export function withBoardCommentCounts(
  groups: GridTableGroup<GenericArtifact>[] | undefined,
  interactions: ReadonlyMap<string, { commentCount?: number }> | undefined
) {
  if (!(groups && interactions)) {
    return groups;
  }
  return groups.map((group) => ({
    ...group,
    items: group.items.map((artifact) => {
      const commentCount = interactions.get(artifact.id)?.commentCount;
      return commentCount === undefined
        ? artifact
        : { ...artifact, commentCount };
    }),
  }));
}
