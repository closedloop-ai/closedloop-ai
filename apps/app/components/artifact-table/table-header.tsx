"use client";

import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import type { ArtifactColumn } from "@/hooks/use-column-visibility";
import {
  ARTIFACT_COLUMN_LABELS,
  NON_SORTABLE_COLUMNS,
} from "@/hooks/use-column-visibility";
import type { SortDirection } from "@/lib/table-utils";

type ArtifactTableHeaderProps = {
  visibleColumns: ArtifactColumn[];
  sortBy: string | null;
  sortDir: SortDirection;
  onSort: (column: string, direction: SortDirection) => void;
};

function SortIcon({
  column,
  sortBy,
  sortDir,
}: {
  column: string;
  sortBy: string | null;
  sortDir: SortDirection;
}) {
  if (sortBy !== column) {
    return <ArrowUpDown className="h-3 w-3 text-muted-foreground" />;
  }
  if (sortDir === "asc") {
    return <ArrowUp className="h-3 w-3 text-muted-foreground" />;
  }
  return <ArrowDown className="h-3 w-3 text-muted-foreground" />;
}

export function ArtifactTableHeader({
  visibleColumns,
  sortBy,
  sortDir,
  onSort,
}: ArtifactTableHeaderProps) {
  function handleSort(column: string) {
    if (sortBy !== column) {
      onSort(column, "desc");
      return;
    }
    onSort(column, sortDir === "desc" ? "asc" : "desc");
  }

  return (
    <div className="sticky top-0 z-10 flex h-10 w-full min-w-0 items-center border-b bg-background">
      {/* Name column — flexible width */}
      <div className="flex min-w-[350px] flex-1 items-center py-2 pr-3 pl-4">
        <button
          className="flex items-center gap-1 hover:text-foreground"
          onClick={() => handleSort("title")}
          type="button"
        >
          <span className="font-medium text-muted-foreground text-xs">
            Name
          </span>
          <SortIcon column="title" sortBy={sortBy} sortDir={sortDir} />
        </button>
      </div>

      {/* Property columns — fixed 124px each */}
      {visibleColumns.map((column) => {
        const isSortable = !NON_SORTABLE_COLUMNS.has(column);
        return (
          <div
            className="flex h-10 w-[124px] shrink-0 items-center border-l px-3 py-2"
            key={column}
          >
            {isSortable ? (
              <button
                className="flex flex-1 items-center gap-1 overflow-hidden hover:text-foreground"
                onClick={() => handleSort(column)}
                type="button"
              >
                <span className="truncate font-medium text-muted-foreground text-xs">
                  {ARTIFACT_COLUMN_LABELS[column]}
                </span>
                <SortIcon column={column} sortBy={sortBy} sortDir={sortDir} />
              </button>
            ) : (
              <span className="truncate font-medium text-muted-foreground text-xs">
                {ARTIFACT_COLUMN_LABELS[column]}
              </span>
            )}
          </div>
        );
      })}

      {/* More menu spacer */}
      <div className="h-10 w-14 shrink-0 border-l" />
    </div>
  );
}
