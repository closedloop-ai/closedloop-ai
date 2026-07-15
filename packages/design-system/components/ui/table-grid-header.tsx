"use client";

import { InfoIcon } from "lucide-react";
import { Checkbox } from "./checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import {
  getNextSortDirection,
  SortIndicator,
  type SortDirection,
} from "./sortable-column-header";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import type { ReactNode } from "react";

export type TableGridHeaderColumn = {
  id: string;
  label: string;
  sortable?: boolean;
  className?: string;
  /** Optional help text shown via an info icon + tooltip after the label. */
  tooltip?: string;
};

// Info icon + tooltip appended to a column header when `tooltip` is set.
function HeaderTooltip({ label, text }: { label: string; text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={`${label} help`}
          className="ml-1 shrink-0 text-muted-foreground/60 hover:text-foreground"
          type="button"
        >
          <InfoIcon className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-56">{text}</TooltipContent>
    </Tooltip>
  );
}

export type TableGridHeaderSortOption = {
  key: string;
  label: string;
};

type TableGridHeaderProps = {
  gridTemplateColumns: string;
  columns: readonly TableGridHeaderColumn[];
  sortBy: string | null;
  sortDir: SortDirection;
  onSort: (column: string, direction: SortDirection) => void;
  leadingLabel?: string;
  leadingSortKey?: string;
  leadingSortOptions?: readonly TableGridHeaderSortOption[];
  onClearSort?: () => void;
  showSelectAll?: boolean;
  allSelected?: boolean;
  someSelected?: boolean;
  onSelectAll?: (checked: boolean) => void;
  showRankSlot?: boolean;
  trailingCell?: ReactNode;
  className?: string;
};

export function TableGridHeader({
  gridTemplateColumns,
  columns,
  sortBy,
  sortDir,
  onSort,
  leadingLabel = "Name",
  leadingSortKey,
  leadingSortOptions,
  onClearSort,
  showSelectAll,
  allSelected,
  someSelected,
  onSelectAll,
  showRankSlot = false,
  trailingCell,
  className,
}: TableGridHeaderProps) {
  return (
    <div
      className={cn(
        "sticky top-0 z-10 grid h-10 min-w-fit border-b bg-[var(--grid-table-surface,var(--background))]",
        className
      )}
      style={{ gridTemplateColumns }}
    >
      {showRankSlot ? <div /> : null}
      <div className="flex min-w-0 items-center py-2 pr-3 pl-4">
        {showSelectAll ? (
          <Checkbox
            checked={getSelectAllState(allSelected, someSelected)}
            className="mr-2"
            onCheckedChange={(checked) => onSelectAll?.(checked === true)}
          />
        ) : null}
        <LeadingHeaderControl
          label={leadingLabel}
          onClearSort={onClearSort}
          onSort={onSort}
          sortBy={sortBy}
          sortDir={sortDir}
          sortKey={leadingSortKey}
          sortOptions={leadingSortOptions}
        />
      </div>

      {columns.map((column) => (
        <div
          className={cn(
            "flex h-10 min-w-0 items-center border-l px-3 py-2",
            column.className
          )}
          key={column.id}
        >
          {column.sortable ? (
            <button
              className="flex flex-1 items-center gap-1 overflow-hidden hover:text-foreground"
              onClick={() =>
                onSort(column.id, getNextSortDirection(sortBy === column.id, sortDir))
              }
              type="button"
            >
              <span className="truncate font-medium text-muted-foreground text-xs">
                {column.label}
              </span>
              <SortIndicator
                className="h-3 w-3"
                direction={sortDir}
                isActive={sortBy === column.id}
              />
            </button>
          ) : (
            <span className="truncate font-medium text-muted-foreground text-xs">
              {column.label}
            </span>
          )}
          {column.tooltip ? (
            <HeaderTooltip label={column.label} text={column.tooltip} />
          ) : null}
        </div>
      ))}

      {/* Trailing cell is opt-in via `trailingCell` (e.g. the documents table's
          More-menu header slot). No implicit phantom default: a fixed-height
          one used to wrap onto an implicit grid row and overlap the first data
          row's lead cell when a caller's template had no track for it. */}
      {trailingCell}
    </div>
  );
}

function LeadingHeaderControl({
  label,
  sortKey,
  sortOptions,
  sortBy,
  sortDir,
  onSort,
  onClearSort,
}: {
  label: string;
  sortKey?: string;
  sortOptions?: readonly TableGridHeaderSortOption[];
  sortBy: string | null;
  sortDir: SortDirection;
  onSort: (column: string, direction: SortDirection) => void;
  onClearSort?: () => void;
}) {
  if (sortOptions?.length) {
    const isActive = sortOptions.some((option) => option.key === sortBy);

    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="flex items-center gap-1 hover:text-foreground"
            type="button"
          >
            <span className="font-medium text-muted-foreground text-xs">
              {label}
            </span>
            <SortIndicator
              className="h-3 w-3"
              direction={sortDir}
              isActive={isActive}
            />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {sortOptions.map((option) => (
            <DropdownMenuItem
              key={option.key}
              onClick={() => {
                if (sortBy !== option.key) {
                  onSort(option.key, "asc");
                } else if (sortDir === "asc") {
                  onSort(option.key, "desc");
                } else {
                  onClearSort?.();
                }
              }}
            >
              <span className="flex-1 text-sm">{option.label}</span>
              <SortIndicator
                className="h-3 w-3"
                direction={sortDir}
                isActive={sortBy === option.key}
              />
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  if (sortKey) {
    return (
      <button
        className="flex items-center gap-1 hover:text-foreground"
        onClick={() => onSort(sortKey, getNextSortDirection(sortBy === sortKey, sortDir))}
        type="button"
      >
        <span className="font-medium text-muted-foreground text-xs">
          {label}
        </span>
        <SortIndicator
          className="h-3 w-3"
          direction={sortDir}
          isActive={sortBy === sortKey}
        />
      </button>
    );
  }

  return (
    <span className="font-medium text-muted-foreground text-xs">{label}</span>
  );
}

function getSelectAllState(
  allSelected?: boolean,
  someSelected?: boolean
): boolean | "indeterminate" {
  if (allSelected) {
    return true;
  }
  if (someSelected) {
    return "indeterminate";
  }
  return false;
}
