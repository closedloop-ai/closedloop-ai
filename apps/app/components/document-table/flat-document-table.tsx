"use client";

import { Button } from "@repo/design-system/components/ui/button";
import type { LucideIcon } from "lucide-react";
import { FileIcon, TrashIcon } from "lucide-react";
import type React from "react";
import { useMemo, useState } from "react";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { EmptyState } from "@/components/empty-state";
import type { DocumentColumn } from "@/hooks/use-column-visibility";
import { useGroupExpansion } from "@/hooks/use-group-expansion";
import { useSortParams } from "@/hooks/use-sort-params";
import { ensureDate } from "@/lib/date-utils";
import { GroupByMode, groupByMode } from "@/lib/group-by";
import { comparePriorityValues } from "@/lib/priority-sort";
import type { SortDirection } from "@/lib/table-utils";
import { compareAssigneeNames } from "@/lib/user-utils";
import type { DocumentRowItem, RowEditHandlers } from "./document-row";
import { DocumentRow } from "./document-row";
import { GroupSectionHeader, sectionIcon } from "./group-section-header";
import { DocumentTableHeader } from "./table-header";

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

function getItemDisplayName(item: DocumentRowItem): string {
  if (item.kind === "project") {
    return item.data.name;
  }
  return item.data.title;
}

function compareByAssignee(a: DocumentRowItem, b: DocumentRowItem): number {
  return compareAssigneeNames(a.data.assignee, b.data.assignee);
}

function compareByDueDate(a: DocumentRowItem, b: DocumentRowItem): number {
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

function compareByPriority(a: DocumentRowItem, b: DocumentRowItem): number {
  return comparePriorityValues(a.data.priority, b.data.priority);
}

function compareByProject(a: DocumentRowItem, b: DocumentRowItem): number {
  const aProject =
    a.kind === "project" ? a.data.name : (a.data.project?.name ?? "");
  const bProject =
    b.kind === "project" ? b.data.name : (b.data.project?.name ?? "");
  return aProject.localeCompare(bProject);
}

const SORT_COMPARATORS: Partial<
  Record<FlatSortColumn, (a: DocumentRowItem, b: DocumentRowItem) => number>
> = {
  title: (a, b) => getItemDisplayName(a).localeCompare(getItemDisplayName(b)),
  assignee: compareByAssignee,
  dueDate: compareByDueDate,
  priority: compareByPriority,
  project: compareByProject,
};

function sortFlatItems(
  items: DocumentRowItem[],
  sortBy: FlatSortColumn | null,
  sortDir: SortDirection
): DocumentRowItem[] {
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

type FlatDocumentTableProps = {
  items: DocumentRowItem[];
  visibleColumns: DocumentColumn[];
  onDelete: (item: DocumentRowItem) => Promise<boolean>;
  moreMenuContent: (
    item: DocumentRowItem,
    onRequestDelete: () => void
  ) => React.ReactNode;
  editHandlers?: RowEditHandlers;
  /** Maps child entity ID to parent entity title for the Parent column. */
  parentTitleMap?: Map<string, { title: string; href: string | null }>;
  emptyIcon?: LucideIcon;
  emptyTitle?: string;
  emptyDescription?: string;
  /** How to group items (none / status / assignee / priority). */
  groupBy?: GroupByMode;
  /** localStorage key for group section expansion state. */
  groupExpansionKey?: string;
};

// ---- Component ----

export function FlatDocumentTable({
  items,
  visibleColumns,
  onDelete,
  moreMenuContent,
  editHandlers,
  parentTitleMap,
  emptyIcon,
  emptyTitle = "No items",
  emptyDescription = "Nothing to show here yet.",
  groupBy = GroupByMode.None,
  groupExpansionKey = "table:expand:flat-group-sections",
}: FlatDocumentTableProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<DocumentRowItem | null>(
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

  const { isExpanded: isSectionExpanded, toggleGroup: toggleSection } =
    useGroupExpansion(groupExpansionKey, { defaultExpanded: true });

  const sortedItems = useMemo(
    () => sortFlatItems(items, sortBy, sortDir),
    [items, sortBy, sortDir]
  );

  const groupedSections = useMemo(() => {
    if (groupBy === GroupByMode.None) {
      return [];
    }
    return groupByMode(sortedItems, (item) => item, groupBy);
  }, [groupBy, sortedItems]);

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

  function handleRequestDelete(item: DocumentRowItem) {
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

  function renderRow(item: DocumentRowItem) {
    return (
      <DocumentRow
        editHandlers={editHandlers}
        isSelected={selectedIds.has(item.data.id)}
        item={item}
        key={item.data.id}
        moreMenuContent={moreMenuContent(item, () => handleRequestDelete(item))}
        onSelectionChange={handleSelectionChange}
        parentHref={parentTitleMap?.get(item.data.id)?.href}
        parentTitle={parentTitleMap?.get(item.data.id)?.title}
        showCheckbox
        visibleColumns={visibleColumns}
      />
    );
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

  function renderTableBody() {
    if (groupBy !== GroupByMode.None && groupedSections.length > 0) {
      return groupedSections.map((section) => {
        const sectionOpen = isSectionExpanded(section.descriptor.key);
        return (
          <div key={section.descriptor.key}>
            <GroupSectionHeader
              count={section.values.length}
              icon={sectionIcon(section.descriptor)}
              isOpen={sectionOpen}
              label={section.descriptor.label}
              onToggle={() => toggleSection(section.descriptor.key)}
            />
            {sectionOpen && section.values.map(renderRow)}
          </div>
        );
      });
    }
    return sortedItems.map(renderRow);
  }

  return (
    <div className="relative">
      <div className="min-w-fit">
        <DocumentTableHeader
          onSort={handleSort}
          sortBy={sortBy}
          sortDir={sortDir}
          visibleColumns={visibleColumns}
        />
        {renderTableBody()}
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
