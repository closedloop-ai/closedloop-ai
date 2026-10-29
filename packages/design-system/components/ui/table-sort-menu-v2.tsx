"use client";

// Grid Table Toolbar v2 promotion candidate, derived from the approved Generic
// Artifact prototype's list controls.

import { Button } from "@closedloop-ai/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@closedloop-ai/design-system/components/ui/dropdown-menu";
import type { SortDirection } from "@closedloop-ai/design-system/components/ui/sortable-column-header";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import { SortAscIcon, XIcon } from "lucide-react";
import {
  appendTableSort,
  removeTableSort,
  resolveFieldLabel,
  setTableSortDirection,
  type TableFieldOption,
  type TableSortRule,
} from "./table-toolbar-model";

/**
 * The toolbar's Sort control: a button that names the active sort, and a
 * dropdown of the fields a table can sort by.
 *
 * This is the toolbar half of sorting; the column headers
 * (`SortableColumnHeader` / `TableGridHeaderV2`) are the other half, and both
 * drive the same `sortBy`/`sortDir` state. It exists because a header is only
 * reachable for a column that is currently VISIBLE and on screen — a wide table
 * scrolled right, or a column hidden via the options menu, has no header to
 * click, and sorting by it is still a reasonable thing to want.
 *
 * `sortBy === null` is "not sorted": the trigger reads "Sort" and no clear
 * affordance renders. Once sorted the trigger takes the active treatment and
 * grows an attached clear button, so the state and the way out of it are the
 * same control.
 */
export function TableSortMenu({
  align = "start",
  maxSortRules,
  onClear,
  onSort,
  onSortsChange,
  options,
  sortBy,
  sortDirection = "asc",
  sorts,
}: {
  align?: "start" | "center" | "end";
  /**
   * How many ordering rules the CALLER can actually apply. Omitted, the menu
   * stacks without limit.
   *
   * A host whose query resolves only one rule passes `1`: the menu then keeps
   * every control live — the direction sub-menu and Remove still write through
   * `onSortsChange` — but choosing another field REPLACES the rule instead of
   * appending a second one the caller would drop. Offering an ordering the
   * caller refuses is a control that reports a state the data never takes.
   */
  maxSortRules?: number;
  onClear: () => void;
  onSort?: (fieldId: string, direction: SortDirection) => void;
  onSortsChange?: (sorts: readonly TableSortRule[]) => void;
  /**
   * The fields this table sorts by, already merged by the caller — a Sessions
   * toolbar passes its sortable columns, the Generic Artifact toolbar passes
   * its sortable columns plus its sortable custom fields.
   */
  options: readonly TableFieldOption[];
  /** Active sort field, or `null` when the table is unsorted. */
  sortBy: string | null;
  /** Direction a fresh selection applies. Defaults to ascending. */
  sortDirection?: SortDirection;
  /** Ordered sort clauses. When supplied, the menu supports multiple fields. */
  sorts?: readonly TableSortRule[];
}) {
  const activeSorts =
    sorts ??
    (sortBy === null ? [] : [{ direction: sortDirection, fieldId: sortBy }]);
  const isActive = activeSorts.length > 0;
  const activeLabel = activeSorts
    .map((sort) => resolveFieldLabel(options, sort.fieldId, sort.fieldId))
    .join(", then ");
  const availableOptions = options.filter(
    (option) => !activeSorts.some((sort) => sort.fieldId === option.id)
  );
  const atSortCap =
    maxSortRules !== undefined && activeSorts.length >= maxSortRules;
  const addSort = (fieldId: string) => {
    if (onSortsChange && !atSortCap) {
      onSortsChange(appendTableSort(activeSorts, fieldId, sortDirection));
      return;
    }
    onSort?.(fieldId, sortDirection);
  };
  const changeDirection = (fieldId: string, direction: SortDirection) =>
    onSortsChange?.(
      setTableSortDirection(activeSorts, fieldId, direction)
    );
  const removeSort = (fieldId: string) => {
    const next = removeTableSort(activeSorts, fieldId);
    if (next.length === 0) {
      onClear();
      return;
    }
    onSortsChange?.(next);
  };

  return (
    <DropdownMenu>
      <div className="flex items-center">
        <DropdownMenuTrigger asChild>
          <Button
            // Named only while sorted, and then by the FIELD — the visible
            // "Sorts: 1" says how many, not by what. Unsorted, the label is
            // omitted so the accessible name falls back to the visible "Sort"
            // rather than becoming a sentence about the absence of a sort.
            aria-label={isActive ? `Sorted by ${activeLabel}` : undefined}
            className={cn(
              isActive &&
                "rounded-r-none border-primary/20 bg-primary/10 text-primary hover:bg-primary/15"
            )}
            size="sm"
            variant="outline"
          >
            <SortAscIcon />
            {isActive ? `Sorts: ${activeSorts.length}` : "Sort"}
          </Button>
        </DropdownMenuTrigger>
        {isActive ? (
          <button
            aria-label="Clear sort"
            className="flex h-8 w-8 items-center justify-center rounded-r-md border border-primary/20 border-l-0 bg-primary/10 text-primary transition-colors hover:bg-primary/20"
            onClick={onClear}
            type="button"
          >
            <XIcon className="size-4" />
          </button>
        ) : null}
      </div>
      <DropdownMenuContent align={align} className="w-64">
        {activeSorts.length > 0 ? (
          <>
            <DropdownMenuLabel>Applied sorts</DropdownMenuLabel>
            {activeSorts.map((sort, index) => (
              <DropdownMenuSub key={sort.fieldId}>
                <DropdownMenuSubTrigger>
                  <span className="w-5 text-muted-foreground tabular-nums">
                    {index + 1}.
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {resolveFieldLabel(options, sort.fieldId, sort.fieldId)}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {sort.direction === "asc" ? "Ascending" : "Descending"}
                  </span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-44">
                  <DropdownMenuItem
                    onSelect={() => changeDirection(sort.fieldId, "asc")}
                  >
                    Ascending
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => changeDirection(sort.fieldId, "desc")}
                  >
                    Descending
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => removeSort(sort.fieldId)}>
                    Remove sort
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ))}
            <DropdownMenuSeparator />
          </>
        ) : null}
        {/* At the cap a pick REPLACES, so the section must not read as an
            addition — the words are the only thing that tells the reader which
            of the two this click does. */}
        <DropdownMenuLabel>
          {isActive && !atSortCap ? "Add another sort" : "Sort by"}
        </DropdownMenuLabel>
        {availableOptions.map((option) => (
          <DropdownMenuItem
            key={option.id}
            onSelect={() => addSort(option.id)}
          >
            {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
