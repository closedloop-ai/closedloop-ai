"use client";

import type { DocumentColumn } from "@repo/app/shared/hooks/use-column-visibility";
import {
  ARTIFACT_COLUMN_LABELS,
  NON_SORTABLE_COLUMNS,
} from "@repo/app/shared/hooks/use-column-visibility";
import type { SortDirection } from "@repo/app/shared/lib/table-utils";
import { ROW_ACTIONS_COLUMN } from "@repo/design-system/components/ui/grid-table";
import { TableGridHeaderV2 } from "@repo/design-system/components/ui/table-grid-header-v2";
import { ariaColumnHeaderProps } from "@repo/design-system/lib/grid-table-aria";
import { cn } from "@repo/design-system/lib/utils";
import {
  getDocumentRowGridTemplateColumns,
  getDocumentTableColumnCount,
} from "./document-row";

type NameSortOption = { readonly key: string; readonly label: string };

type DocumentTableHeaderProps = {
  className?: string;
  visibleColumns: DocumentColumn[];
  sortBy: string | null;
  sortDir: SortDirection;
  onSort: (column: string, direction: SortDirection) => void;
  showSelectAll?: boolean;
  allSelected?: boolean;
  someSelected?: boolean;
  onSelectAll?: (checked: boolean) => void;
  nameSortOptions?: readonly NameSortOption[];
  onClearSort?: () => void;
  /**
   * FEA-4165: column reorder. Receives the full new VISIBLE column-id order the
   * caller merges back into its persisted order. Wired, each data column header
   * is the v2 options menu (Sort ascending, Sort descending, Move column) and
   * the column drags by its header (ISS-11412 Decision 6). Omit and the headers
   * stay click-to-sort with no menu, which is what the Projects list and the
   * skeleton render.
   */
  onReorderColumns?: (nextVisibleOrder: string[]) => void;
  /**
   * ISS-4761: opt this header into the shared `GridTable` ARIA table semantics
   * (ISS-4672). Set ONLY when the CALLER renders `role="table"` on its own
   * wrapper and its `DocumentRow`s carry the matching `insideAriaTable`, since a
   * `row`/`columnheader` with no `table` ancestor is itself an ARIA violation.
   *
   * This header owns its own `trailingCell` (the More-menu track), so it also
   * owns that cell's `columnheader` role, `aria-colindex`, and accessible name —
   * `TableGridHeaderV2` cannot infer any of the three for caller-supplied markup.
   */
  insideAriaTable?: boolean;
};

export function DocumentTableHeader({
  className,
  visibleColumns,
  sortBy,
  sortDir,
  onSort,
  showSelectAll,
  allSelected,
  someSelected,
  onSelectAll,
  nameSortOptions,
  onClearSort,
  onReorderColumns,
  insideAriaTable = false,
}: DocumentTableHeaderProps) {
  const gridTemplateColumns = getDocumentRowGridTemplateColumns(
    visibleColumns.length
  );

  return (
    <TableGridHeaderV2
      allSelected={allSelected}
      // The legacy flat Project Detail host is the only DocumentsView host
      // wrapped in `min-w-fit`. Keep its main-compatible max-content table
      // without changing card fallback on the other flat document surfaces.
      className={cn("[.min-w-fit_&]:min-w-max", className)}
      columns={visibleColumns.map((column) => ({
        id: column,
        label: ARTIFACT_COLUMN_LABELS[column],
        sortable: !NON_SORTABLE_COLUMNS.has(column),
      }))}
      gridTemplateColumns={gridTemplateColumns}
      insideAriaTable={insideAriaTable}
      leadingSortKey={nameSortOptions ? undefined : "title"}
      leadingSortOptions={nameSortOptions}
      onClearSort={onClearSort}
      onSelectAll={onSelectAll}
      onSort={onSort}
      reorder={
        onReorderColumns
          ? { columnOrder: visibleColumns, onReorder: onReorderColumns }
          : undefined
      }
      showSelectAll={showSelectAll}
      someSelected={someSelected}
      sortBy={sortBy}
      sortDir={sortDir}
      // The template's last track is the 88px More-menu column; render its
      // header cell explicitly (matches the row's bordered More-menu cell).
      // ISS-4761: when opted in it must declare its own `columnheader` role,
      // the next `aria-colindex` after the data columns, and a name — the track
      // has no visible label, so without one every row's action cell would be
      // announced under a blank column. The name is the shared
      // `ROW_ACTIONS_COLUMN` spec's, not a local literal.
      trailingCell={
        <div
          {...ariaColumnHeaderProps(
            insideAriaTable,
            getDocumentTableColumnCount(visibleColumns.length),
            ROW_ACTIONS_COLUMN.ariaLabel
          )}
          className="h-full border-l"
        />
      }
    />
  );
}
