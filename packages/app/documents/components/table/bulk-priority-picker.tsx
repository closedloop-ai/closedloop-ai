"use client";

import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import {
  BATCH_ITEM_FAILURE_MESSAGE,
  type BatchMutationResponse,
} from "@repo/api/src/types/batch-mutation-result";
import { Priority } from "@repo/api/src/types/common";
import { useBatchUpdatePriority } from "@repo/app/documents/hooks/use-documents";
import { batchMutationSelectionOutcome } from "@repo/app/shared/bulk-actions/batch-mutation-selection";
import { usePriorityOptions } from "@repo/app/shared/hooks/use-priority-options";
import { PRIORITY_LABELS } from "@repo/app/shared/lib/priority-constants";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { PriorityIcon } from "@repo/design-system/components/ui/priority-icon";
import { toast } from "@repo/design-system/components/ui/sonner";
import type {
  TableBulkActionDescriptor,
  TableBulkActionOption,
  TableBulkSelectionControls,
} from "@repo/design-system/components/ui/table-bulk-actions";
import { TableBulkActionUndo } from "@repo/design-system/components/ui/table-bulk-actions";
import { isPriorityValue } from "@repo/design-system/lib/priority-order";

// The column menu iconifies the priority FIELD this way. A lucide signal glyph
// would wear one specific level and read as "set that level".
const FIELD_ICON = <PriorityIcon priority={Priority.Medium} size={16} />;

/**
 * Setting a priority on the selection, as a bulk-action descriptor beside
 * `useBulkStatusAction`. Its options come from the same shared order every
 * other priority menu reads, so the bar cannot offer a different vocabulary or
 * a different reading order from the cells it acts on.
 */
export function useBulkPriorityAction(): TableBulkActionDescriptor & {
  id: typeof BULK_PRIORITY_ACTION_ID;
} {
  const batchUpdatePriority = useBatchUpdatePriority({
    suppressDefaultErrorToast: true,
  });
  const priorities = usePriorityOptions();

  const options: readonly TableBulkActionOption[] = priorities.map(
    (priority) => ({
      content: (
        <>
          <PriorityIcon priority={priority} size={16} />
          {PRIORITY_LABELS[priority]}
        </>
      ),
      id: priority,
      label: PRIORITY_LABELS[priority],
    })
  );

  function select(
    rowIds: readonly string[],
    option: TableBulkActionOption,
    selection: TableBulkSelectionControls
  ): Promise<boolean> | boolean {
    // Narrowed, not cast: the option id round-trips through the descriptor as
    // an opaque string.
    if (!isPriorityValue(option.id)) {
      return false;
    }
    const priority: Priority = option.id;
    const label = PRIORITY_LABELS[priority];
    const count = rowIds.length;
    return new Promise<boolean>((resolve) => {
      batchUpdatePriority.mutate(
        {
          documentIds: [...rowIds],
          priority,
          surface: ArtifactStatusEditSurface.Bulk,
        },
        {
          onSuccess: (response: BatchMutationResponse) => {
            const outcome = batchMutationSelectionOutcome(
              response.results,
              rowIds
            );
            if (outcome.failureCode) {
              selection.retain(outcome.failedIds);
              toast.error(BATCH_ITEM_FAILURE_MESSAGE[outcome.failureCode]);
              resolve(false);
              return;
            }
            toast.success(
              `Updated ${count} ${count === 1 ? "item" : "items"} to ${label}`
            );
            selection.clear();
            resolve(true);
          },
          onError: () => {
            toast.error(
              `Could not set ${count === 1 ? "the item" : "all items"} to ${label}.`
            );
            resolve(false);
          },
        }
      );
    });
  }

  return {
    emptyLabel: "No priorities available",
    icon: FIELD_ICON,
    id: BULK_PRIORITY_ACTION_ID,
    isPending: batchUpdatePriority.isPending,
    kind: "picker",
    // ISS-10161: bulk priority is non-destructive and so IS undoable under the
    // 2026-09-16 ruling — the undo is simply not built yet. Declared as the gap
    // it is rather than sharing a value with a destructive action.
    undo: TableBulkActionUndo.NotImplemented,
    label: BULK_PRIORITY_ACTION_LABEL,
    onSelect: select,
    options,
    render: ({ selectOption }) => (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            className="h-8 text-xs"
            disabled={batchUpdatePriority.isPending}
            size="sm"
            variant="outline"
          >
            {FIELD_ICON}
            {BULK_PRIORITY_ACTION_LABEL}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center">
          {options.map((option) => (
            <DropdownMenuItem
              key={option.id}
              onClick={async () => {
                await selectOption(option);
              }}
            >
              {option.content}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    ),
  };
}

export const BULK_PRIORITY_ACTION_ID = "bulk-priority";
const BULK_PRIORITY_ACTION_LABEL = "Change Priority";
