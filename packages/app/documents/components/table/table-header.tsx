"use client";

import type { DocumentColumn } from "@repo/app/shared/hooks/use-column-visibility";
import {
  ARTIFACT_COLUMN_LABELS,
  NON_SORTABLE_COLUMNS,
} from "@repo/app/shared/hooks/use-column-visibility";
import type { SortDirection } from "@repo/app/shared/lib/table-utils";
import { TableGridHeader } from "@repo/design-system/components/ui/table-grid-header";
import { getDocumentRowGridTemplateColumns } from "./document-row";

type NameSortOption = { readonly key: string; readonly label: string };

type DocumentTableHeaderProps = {
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
};

export function DocumentTableHeader({
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
}: DocumentTableHeaderProps) {
  const gridTemplateColumns = getDocumentRowGridTemplateColumns(
    visibleColumns.length
  );

  return (
    <TableGridHeader
      allSelected={allSelected}
      columns={visibleColumns.map((column) => ({
        id: column,
        label: ARTIFACT_COLUMN_LABELS[column],
        sortable: !NON_SORTABLE_COLUMNS.has(column),
      }))}
      gridTemplateColumns={gridTemplateColumns}
      leadingSortKey={nameSortOptions ? undefined : "title"}
      leadingSortOptions={nameSortOptions}
      onClearSort={onClearSort}
      onSelectAll={onSelectAll}
      onSort={onSort}
      showSelectAll={showSelectAll}
      someSelected={someSelected}
      sortBy={sortBy}
      sortDir={sortDir}
      // The template's last track is the 88px More-menu column; render its
      // header cell explicitly (matches the row's bordered More-menu cell).
      trailingCell={<div className="h-10 border-l" />}
    />
  );
}
