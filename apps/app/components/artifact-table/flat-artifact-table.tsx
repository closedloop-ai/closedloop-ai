"use client";

import { Button } from "@repo/design-system/components/ui/button";
import type { LucideIcon } from "lucide-react";
import { FileIcon, TrashIcon } from "lucide-react";
import type React from "react";
import { useMemo, useState } from "react";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { EmptyState } from "@/components/empty-state";
import type { ArtifactColumn } from "@/hooks/use-column-visibility";
import { useSortParams } from "@/hooks/use-sort-params";
import { ensureDate } from "@/lib/date-utils";
import { comparePriorityValues } from "@/lib/priority-sort";
import type { SortDirection } from "@/lib/table-utils";
import { getUserDisplayName } from "@/lib/user-utils";
import type { ArtifactRowItem, RowEditHandlers } from "./artifact-row";
import { ArtifactRow } from "./artifact-row";
import { ArtifactTableHeader } from "./table-header";

// ---- Sort columns ----

const FLAT_SORT_COLUMNS = [
  "title",
  "assignee",
  "dueDate",
  "priority",
  "project",
  "type",
  "score",
] as const;
type FlatSortColumn = (typeof FLAT_SORT_COLUMNS)[number];

function getItemDisplayName(item: ArtifactRowItem): string {
  if (item.kind === "project") {
    return item.data.name;
  }
  return item.data.title;
}

function compareByAssignee(a: ArtifactRowItem, b: ArtifactRowItem): number {
  const aName = a.data.assignee ? getUserDisplayName(a.data.assignee) : "";
  const bName = b.data.assignee ? getUserDisplayName(b.data.assignee) : "";
  if (!(aName || bName)) {
    return 0;
  }
  if (!aName) {
    return 1;
  }
  if (!bName) {
    return -1;
  }
  return aName.localeCompare(bName);
}

function compareByDueDate(a: ArtifactRowItem, b: ArtifactRowItem): number {
  const aDate = ensureDate(a.data.updatedAt);
  const bDate = ensureDate(b.data.updatedAt);
  if (!(aDate || bDate)) {
    return 0;
  }
  if (!aDate) {
    return 1;
  }
  if (!bDate) {
    return -1;
  }
  return aDate.getTime() - bDate.getTime();
}

function compareByPriority(a: ArtifactRowItem, b: ArtifactRowItem): number {
  return comparePriorityValues(a.data.priority, b.data.priority);
}

function compareByProject(a: ArtifactRowItem, b: ArtifactRowItem): number {
  const aProject =
    a.kind === "project" ? a.data.name : (a.data.project?.name ?? "");
  const bProject =
    b.kind === "project" ? b.data.name : (b.data.project?.name ?? "");
  return aProject.localeCompare(bProject);
}

const SORT_COMPARATORS: Partial<
  Record<FlatSortColumn, (a: ArtifactRowItem, b: ArtifactRowItem) => number>
> = {
  title: (a, b) => getItemDisplayName(a).localeCompare(getItemDisplayName(b)),
  assignee: compareByAssignee,
  dueDate: compareByDueDate,
  priority: compareByPriority,
  project: compareByProject,
};

function sortFlatItems(
  items: ArtifactRowItem[],
  sortBy: FlatSortColumn | null,
  sortDir: SortDirection
): ArtifactRowItem[] {
  if (!sortBy) {
    return items;
  }
  const comparator = SORT_COMPARATORS[sortBy];
  if (!comparator) {
    return items;
  }
  return [...items].sort((a, b) => {
    const result = comparator(a, b);
    return sortDir === "asc" ? result : -result;
  });
}

// ---- Props ----

type FlatArtifactTableProps = {
  items: ArtifactRowItem[];
  visibleColumns: ArtifactColumn[];
  onDelete: (item: ArtifactRowItem) => Promise<boolean>;
  moreMenuContent: (
    item: ArtifactRowItem,
    onRequestDelete: () => void
  ) => React.ReactNode;
  editHandlers?: RowEditHandlers;
  /** Maps child entity ID to parent entity title for the Parent column. */
  parentTitleMap?: Map<string, { title: string; href: string | null }>;
  emptyIcon?: LucideIcon;
  emptyTitle?: string;
  emptyDescription?: string;
};

// ---- Component ----

export function FlatArtifactTable({
  items,
  visibleColumns,
  onDelete,
  moreMenuContent,
  editHandlers,
  parentTitleMap,
  emptyIcon,
  emptyTitle = "No items",
  emptyDescription = "Nothing to show here yet.",
}: FlatArtifactTableProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<ArtifactRowItem | null>(
    null
  );
  const [pendingBulkIds, setPendingBulkIds] = useState<Set<string>>(new Set());
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletePending, setDeletePending] = useState(false);

  const { sortBy, sortDir, setSort } = useSortParams<FlatSortColumn>({
    defaultColumn: "title",
    defaultDirection: "asc",
    validColumns: FLAT_SORT_COLUMNS,
  });

  const sortedItems = useMemo(
    () => sortFlatItems(items, sortBy, sortDir),
    [items, sortBy, sortDir]
  );

  function handleSelectionChange(id: string, checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }

  function handleRequestDelete(item: ArtifactRowItem) {
    setPendingBulkIds(new Set());
    setDeleteTarget(item);
    setDeleteDialogOpen(true);
  }

  function handleRequestBulkDelete() {
    setPendingBulkIds(new Set(selectedIds));
    setDeleteTarget(null);
    setDeleteDialogOpen(true);
  }

  async function handleConfirmDelete(): Promise<boolean> {
    setDeletePending(true);
    try {
      if (pendingBulkIds.size > 0) {
        let allSuccess = true;
        for (const id of pendingBulkIds) {
          const item = items.find((i) => i.data.id === id);
          if (!item) {
            allSuccess = false;
            continue;
          }
          const success = await onDelete(item);
          if (success) {
            setSelectedIds((prev) => {
              const next = new Set(prev);
              next.delete(id);
              return next;
            });
          } else {
            allSuccess = false;
          }
        }
        return allSuccess;
      }
      if (!deleteTarget) {
        return false;
      }
      const success = await onDelete(deleteTarget);
      if (success) {
        setSelectedIds((prev) => {
          const next = new Set(prev);
          next.delete(deleteTarget.data.id);
          return next;
        });
      }
      return success;
    } finally {
      setDeletePending(false);
    }
  }

  // Only pass sortable columns to the header's onSort
  function handleSort(column: string, dir: SortDirection) {
    if (FLAT_SORT_COLUMNS.includes(column as FlatSortColumn)) {
      setSort(column as FlatSortColumn, dir);
    }
  }

  if (items.length === 0) {
    return (
      <EmptyState
        description={emptyDescription}
        icon={emptyIcon ?? FileIcon}
        title={emptyTitle}
      />
    );
  }

  const isBulk = pendingBulkIds.size > 0;
  let deleteItemName: string;
  if (isBulk) {
    deleteItemName = `${pendingBulkIds.size} items`;
  } else if (deleteTarget) {
    deleteItemName = getItemDisplayName(deleteTarget);
  } else {
    deleteItemName = "";
  }
  const deleteTitle = isBulk ? "Items" : "Item";

  return (
    <div className="relative">
      <div className="min-w-fit">
        <ArtifactTableHeader
          onSort={handleSort}
          sortBy={sortBy}
          sortDir={sortDir}
          visibleColumns={visibleColumns}
        />
        {sortedItems.map((item) => (
          <ArtifactRow
            editHandlers={editHandlers}
            isSelected={selectedIds.has(item.data.id)}
            item={item}
            key={item.data.id}
            moreMenuContent={moreMenuContent(item, () =>
              handleRequestDelete(item)
            )}
            onSelectionChange={handleSelectionChange}
            parentHref={parentTitleMap?.get(item.data.id)?.href}
            parentTitle={parentTitleMap?.get(item.data.id)?.title}
            showCheckbox
            visibleColumns={visibleColumns}
          />
        ))}
      </div>

      {/* Floating selection bar */}
      {selectedIds.size > 0 && (
        <div className="pointer-events-none sticky bottom-3 z-50 mt-4 flex justify-center">
          <div className="pointer-events-auto flex items-center gap-4 rounded-2xl border bg-background px-[18px] py-3 shadow-md">
            <span className="shrink-0 font-medium text-muted-foreground text-xs">
              {selectedIds.size} {selectedIds.size === 1 ? "item" : "items"}{" "}
              selected
            </span>
            <div className="flex items-center gap-2">
              <Button
                className="h-8 text-xs"
                onClick={() => setSelectedIds(new Set())}
                size="sm"
                variant="outline"
              >
                Clear Selected
              </Button>
              <Button
                className="h-8 text-xs"
                onClick={handleRequestBulkDelete}
                size="sm"
                variant="outline"
              >
                <TrashIcon className="h-4 w-4" />
                Delete
              </Button>
            </div>
          </div>
        </div>
      )}

      <DeleteConfirmationDialog
        isPending={deletePending}
        itemName={deleteItemName}
        onConfirm={handleConfirmDelete}
        onOpenChange={setDeleteDialogOpen}
        open={deleteDialogOpen}
        title={deleteTitle}
      />
    </div>
  );
}
