"use client";

import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { TagEntityType } from "@repo/api/src/types/tag";
import type { DocumentRowData } from "@repo/app/documents/lib/artifact-row-adapter";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { ARTIFACT_TAGS_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { EntityTagsCell } from "@repo/app/tags/components/entity-tags-cell";

/** Canonical tag authority for a document rendered inside a board card. */
export function ProjectArtifactBoardTags({
  document,
}: Readonly<{ document: DocumentRowData }>) {
  const tagsEnabled = useFeatureFlagEnabledOptional(
    ARTIFACT_TAGS_FEATURE_FLAG_KEY
  );
  if (!tagsEnabled) {
    return (
      <EntityTagsCell
        canApply={false}
        canRemove={false}
        editLabel={`Edit tags for ${document.title}`}
        emptyValue={null}
        entityId={null}
        entityType={TagEntityType.Artifact}
        surface={ArtifactStatusEditSurface.Board}
        tags={document.tags ?? []}
      />
    );
  }
  return (
    <EntityTagsCell
      canApply
      canRemove
      editLabel={`Edit tags for ${document.title}`}
      emptyValue={null}
      entityId={document.id}
      entityType={TagEntityType.Artifact}
      surface={ArtifactStatusEditSurface.Board}
      tags={document.tags ?? []}
    />
  );
}
