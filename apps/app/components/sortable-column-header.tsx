"use client";

import { TableHead } from "@repo/design-system/components/ui/table";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import type { SortDirection } from "@/lib/table-utils";

type SortableColumnHeaderProps<TColumn extends string> = {
  column: TColumn;
  label: string;
  sortBy: TColumn | null;
  sortDir: SortDirection;
  onSort: (column: TColumn, direction: SortDirection) => void;
  className?: string;
};

export function SortableColumnHeader<TColumn extends string>({
  column,
  label,
  sortBy,
  sortDir,
  onSort,
  className,
}: SortableColumnHeaderProps<TColumn>) {
  const isActive = sortBy === column;

  function handleClick() {
    if (!isActive) {
      onSort(column, "desc");
      return;
    }
    if (sortDir === "desc") {
      onSort(column, "asc");
      return;
    }
    onSort(column, "desc");
  }

  function renderIcon() {
    if (!isActive) {
      return <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground" />;
    }
    if (sortDir === "asc") {
      return <ArrowUp className="h-3.5 w-3.5" />;
    }
    return <ArrowDown className="h-3.5 w-3.5" />;
  }

  return (
    <TableHead className={className}>
      <button
        className="inline-flex items-center gap-1 hover:text-foreground"
        onClick={handleClick}
        type="button"
      >
        {label}
        {renderIcon()}
      </button>
    </TableHead>
  );
}
