"use client";

import { TagEntityType } from "@repo/api/src/types/tag";
import { CELL_CLASSES } from "@repo/app/documents/components/table/cells/shared-cell-styles";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { TagChips } from "@repo/app/tags/components/tag-chip";
import { TagPicker } from "@repo/app/tags/components/tag-picker";
import { useNavigation } from "@repo/navigation/use-navigation";
import { useOrgPath } from "@repo/navigation/use-org-path";
import { PlusIcon } from "lucide-react";

/**
 * Tags column cell (FEA-1763 / PLN-874 Phase 3; extracted from
 * document-row.tsx). Documents get the interactive picker behind the
 * `artifact-tags` flag; everything else renders read-only chips.
 */
export function TagsCell({ item }: { item: DocumentRowItem }) {
  const buildOrgPath = useOrgPath();
  const { navigate } = useNavigation();
  const tags = "tags" in item.data ? (item.data.tags ?? []) : [];
  const tagsEnabled = useFeatureFlagEnabled("artifact-tags");
  const entityId =
    tagsEnabled && item.kind === "document" ? item.data.id : null;

  if (!entityId) {
    return (
      <div className={CELL_CLASSES}>
        <TagChips maxVisible={2} tags={tags} />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-11 shrink-0 items-center border-l px-3">
      <TagPicker
        appliedTags={tags}
        entityId={entityId}
        entityType={TagEntityType.Artifact}
        onChipClick={(tag) =>
          navigate(buildOrgPath(`/search?tagId=${encodeURIComponent(tag.id)}`))
        }
        trigger={
          <button
            aria-label="Add tag"
            className="flex shrink-0 items-center justify-center hover:bg-muted/50"
            onClick={(e) => e.stopPropagation()}
            type="button"
          >
            <PlusIcon className="h-3 w-3" />
          </button>
        }
      />
    </div>
  );
}
