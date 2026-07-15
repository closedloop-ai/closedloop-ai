"use client";

import { TableHead } from "@closedloop-ai/design-system/components/ui/table";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";

export type SortDirection = "asc" | "desc";

type SortableColumnHeaderProps<TColumn extends string> = {
  column: TColumn;
  label: string;
  sortBy: TColumn | null;
  sortDir: SortDirection;
  onSort: (column: TColumn, direction: SortDirection) => void;
  className?: string;
};

type SortIndicatorProps = {
  isActive: boolean;
  direction: SortDirection;
  className?: string;
};

export function getNextSortDirection(
  isActive: boolean,
  currentDirection: SortDirection
): SortDirection {
  if (!isActive) {
    return "desc";
  }

  return currentDirection === "desc" ? "asc" : "desc";
}

export function SortIndicator({
  isActive,
  direction,
  className,
}: SortIndicatorProps) {
  if (!isActive) {
    return (
      <ArrowUpDown
        className={cn("h-3.5 w-3.5 text-muted-foreground", className)}
      />
    );
  }

  if (direction === "asc") {
    return <ArrowUp className={cn("h-3.5 w-3.5", className)} />;
  }

  return <ArrowDown className={cn("h-3.5 w-3.5", className)} />;
}

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
    onSort(column, getNextSortDirection(isActive, sortDir));
  }

  return (
    <TableHead className={className}>
      <button
        className="inline-flex items-center gap-1 hover:text-foreground"
        onClick={handleClick}
        type="button"
      >
        {label}
        <SortIndicator direction={sortDir} isActive={isActive} />
      </button>
    </TableHead>
  );
}
