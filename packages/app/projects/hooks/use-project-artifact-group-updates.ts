"use client";

import type { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { TagEntityType } from "@repo/api/src/types/tag";
import { useUpdateDocument } from "../../documents/hooks/use-documents";
import type { GenericArtifact } from "../../shared/components/generic-artifact-surface/preview/fixtures";
import { useApplyTag, useRemoveTag } from "../../tags/hooks/use-tags";
import type { ProjectArtifactGroupUpdates } from "../lib/project-artifact-group-updates";

/** Keep flag-off group edits on the existing document and tag writers. */
export function useProjectArtifactGroupUpdates() {
  const update = useUpdateDocument();
  const applyTag = useApplyTag();
  const removeTag = useRemoveTag();

  const applyGroupUpdates = (
    artifactIds: readonly string[],
    updates: ProjectArtifactGroupUpdates,
    rows: readonly GenericArtifact[],
    surface?: ArtifactStatusEditSurface
  ) => {
    for (const artifactId of artifactIds) {
      if (updates.tagIds) {
        const currentTagIds =
          rows.find((row) => row.id === artifactId)?.tagIds ?? [];
        replaceTags(
          artifactId,
          currentTagIds,
          updates.tagIds,
          applyTag.mutateAsync,
          removeTag.mutateAsync
        ).catch(() => undefined);
      } else {
        update.mutate({
          id: artifactId,
          ...updates,
          ...(surface ? { surface } : {}),
        });
      }
    }
  };
  return { update, applyGroupUpdates };
}

async function replaceTags(
  artifactId: string,
  currentTagIds: readonly string[],
  desiredTagIds: readonly string[],
  apply: ReturnType<typeof useApplyTag>["mutateAsync"],
  remove: ReturnType<typeof useRemoveTag>["mutateAsync"]
): Promise<void> {
  await Promise.all(
    desiredTagIds
      .filter((tagId) => !currentTagIds.includes(tagId))
      .map((tagId) =>
        apply({
          tagId,
          entityType: TagEntityType.Artifact,
          entityId: artifactId,
        })
      )
  );
  await Promise.all(
    currentTagIds
      .filter((tagId) => !desiredTagIds.includes(tagId))
      .map((tagId) =>
        remove({
          tagId,
          entityType: TagEntityType.Artifact,
          entityId: artifactId,
        })
      )
  );
}
