"use client";

import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { TagEntityType } from "@repo/api/src/types/tag";
import { useDocumentCellClasses } from "@repo/app/documents/components/table/cells/cell-frame";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { EntityTagsCell } from "@repo/app/tags/components/entity-tags-cell";
import { useNavigation } from "@repo/navigation/use-navigation";
import { useOrgPath } from "@repo/navigation/use-org-path";

/**
 * Tags column cell (FEA-1763 / PLN-874 Phase 3; extracted from
 * document-row.tsx). Documents get the interactive picker behind the
 * `artifact-tags` flag; everything else renders read-only chips.
 *
 * ISS-9215 folded the rendering into the shared `EntityTagsCell` that Sessions
 * and Branches also mount, leaving this file the row-shape mapping and the two
 * things that are genuinely Documents-only: a chip press routes to tag search,
 * and an untagged row renders nothing rather than the grid's em-dash.
 */
export function TagsCell({ item }: { item: DocumentRowItem }) {
  const buildOrgPath = useOrgPath();
  const cells = useDocumentCellClasses();
  const { navigate } = useNavigation();
  const tags = "tags" in item.data ? (item.data.tags ?? []) : [];
  const tagsEnabled = useFeatureFlagEnabled("artifact-tags");
  const entityId =
    tagsEnabled && item.kind === "document" ? item.data.id : null;
  // Only a `document` row ever reaches the trigger this names, so the other
  // kinds need no label of their own.
  const documentTitle = item.kind === "document" ? item.data.title : "";

  return (
    <div className={entityId ? cells.contentBox : cells.box}>
      <EntityTagsCell
        // The `artifact-tags` gate and the row kind above already decide
        // whether this row is writable; past that, the API is the boundary.
        canApply
        canRemove
        editLabel={`Edit tags for ${documentTitle ?? "this document"}`}
        // A project or branch row with no tags has always rendered an empty
        // cell here. The grid's em-dash would newly claim "no tags" on a row
        // whose relation this table never loaded.
        emptyValue={null}
        entityId={entityId}
        entityType={TagEntityType.Artifact}
        // Documents is the only surface where a chip is a navigation target:
        // it filters search by that tag.
        onChipClick={(tag) =>
          navigate(buildOrgPath(`/search?tagId=${encodeURIComponent(tag.id)}`))
        }
        surface={ArtifactStatusEditSurface.InlineCell}
        tags={tags}
      />
    </div>
  );
}
