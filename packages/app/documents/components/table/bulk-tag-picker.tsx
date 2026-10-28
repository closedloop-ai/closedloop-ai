"use client";

import { TagEntityType } from "@repo/api/src/types/tag";
import { TagChip } from "@repo/app/shared/components/tag-chip";
// Tags owns the picker chrome shared with Session and Branch bulk addition.
import { BulkTagPicker } from "@repo/app/tags/components/bulk-tag-picker";
import { useBatchApplyTag, useTags } from "@repo/app/tags/hooks/use-tags";
import {
  appliedTagMessage,
  BULK_TAG_ACTION_ID,
  BULK_TAG_ACTION_LABEL,
  BULK_TAG_EMPTY_LABEL,
} from "@repo/app/tags/lib/bulk-tag-labels";
import { toast } from "@repo/design-system/components/ui/sonner";
import type {
  TableBulkActionDescriptor,
  TableBulkActionOption,
} from "@repo/design-system/components/ui/table-bulk-actions";
import { TableBulkActionUndo } from "@repo/design-system/components/ui/table-bulk-actions";
import type { CountNoun } from "@repo/design-system/lib/count-noun";
import { TagIcon } from "lucide-react";
import { useState } from "react";

/**
 * Applying a tag to the selection, as a bulk-action descriptor (ISS-8942).
 *
 * Like its status sibling it keeps its own `render` — the project table's
 * selection bar is not the Sessions rail — while the options and the handler
 * under it are the descriptor's own.
 */
export function useBulkTagAction(
  noun?: CountNoun
): TableBulkActionDescriptor & {
  id: typeof BULK_TAG_ACTION_ID;
} {
  const [open, setOpen] = useState(false);
  const { data: tags } = useTags();
  const batchApplyTag = useBatchApplyTag();
  const options: readonly TableBulkActionOption[] = (tags ?? []).map((tag) => ({
    content: <TagChip tag={tag} />,
    id: tag.id,
    label: tag.name,
  }));

  function select(
    rowIds: readonly string[],
    option: TableBulkActionOption
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      batchApplyTag.mutate(
        {
          tagId: option.id,
          entityType: TagEntityType.Artifact,
          entityIds: [...rowIds],
        },
        {
          // Operator ruling on the ISS-12305 review, following Asana: a tag
          // write keeps the selection; the reader clears it.
          onSuccess: (result) => {
            toast.success(
              appliedTagMessage(option.label, result.appliedCount, noun)
            );
            setOpen(false);
            resolve(true);
          },
          onError: () => resolve(false),
        }
      );
    });
  }

  return {
    emptyLabel: BULK_TAG_EMPTY_LABEL,
    icon: <TagIcon className="h-4 w-4" />,
    id: BULK_TAG_ACTION_ID,
    isPending: batchApplyTag.isPending,
    kind: "picker",
    // ISS-10161: bulk tag is non-destructive and so IS undoable under the
    // 2026-09-16 ruling — the undo is simply not built yet. Declared as the gap
    // it is rather than sharing a value with a destructive action.
    undo: TableBulkActionUndo.NotImplemented,
    label: BULK_TAG_ACTION_LABEL,
    onSelect: select,
    options,
    render: ({ selectOption }) => (
      <BulkTagPicker
        isPending={batchApplyTag.isPending}
        onOpenChange={setOpen}
        onSelect={selectOption}
        open={open}
        options={options}
      />
    ),
  };
}
