"use client";

import { cn } from "@closedloop-ai/design-system/lib/utils";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ChevronDownIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
  FilterIcon,
  Rows3Icon,
  ArrowUpIcon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import type { SortDirection } from "./sortable-column-header";

/**
 * Per-column options menu for `TableGridHeader` (GridTable v2), lifted from the
 * `generic-artifact` prototype's `table-grid-header.tsx`.
 *
 * Lives in its own module rather than inside `table-grid-header.tsx`: that file
 * is already ~750 lines and owns header layout, drag-reorder, and resize; a
 * fourth responsibility would push it toward the 1,000-line ceiling with no
 * cohesion gained.
 *
 * The hover/focus choreography here is the point of the ticket, not decoration
 * — see `COLUMN_MENU_TRIGGER_CLASS`.
 */

/**
 * Optional per-column actions. Every member is optional and a column only
 * offers the item when BOTH the action is wired here and the column opts in
 * (`filterable` / `groupable` / `movable`), so a table that wires nothing keeps
 * a header with no menu button at all — byte-identical to before.
 */
export type TableGridHeaderActions = {
  onFilter?: (columnId: string) => void;
  onGroup?: (columnId: string) => void;
  onMove?: (
    columnId: string,
    direction: "start" | "left" | "right" | "end"
  ) => void;
};

/**
 * The trigger's class list, exported so the interaction contract can be
 * asserted against ONE string instead of a copy in the test.
 *
 * Three states are load-bearing and each has been lost by a from-scratch
 * re-derivation before:
 *  - `opacity-0` + `group-hover/header:opacity-100` — the resting header stays a
 *    clean row of labels; the control appears on hover.
 *  - `focus-visible:opacity-100` — the hover reveal's KEYBOARD twin. Without it
 *    the control is mouse-only: a keyboard user can focus an invisible button
 *    (WCAG 2.4.7 Focus Visible).
 *  - `data-[state=open]:opacity-100` — Radix stamps `data-state="open"` on the
 *    trigger while its menu is open. Without this the trigger fades out the
 *    moment the pointer moves off the header and onto the menu it just opened,
 *    so the control vanishes underneath its own popup.
 */
export const COLUMN_MENU_TRIGGER_CLASS = cn(
  // `size-6` (24px), not the 20px this shipped with: the control is invisible
  // until the header is hovered, so the target has to be forgiving once found.
  // The glyph stays `size-3.5` — the hit box grew, the mark did not.
  "ml-auto flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0",
  "transition-[opacity,background-color,color] duration-100",
  "hover:bg-muted hover:text-foreground",
  "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
  "group-hover/header:opacity-100",
  "data-[state=open]:bg-muted data-[state=open]:text-foreground data-[state=open]:opacity-100"
);

/**
 * True when a column has a REASON to open a menu — that is, at least one item
 * the header itself cannot already perform.
 *
 * Sort deliberately does not count. Clicking the header label already sorts, so
 * a menu offering only "Sort ascending / Sort descending" would put two controls
 * on one action and make every sortable column grow a chevron the moment a table
 * wires `actions` at all. Sort still RIDES ALONG once filter, group or move has
 * earned the menu (see `ColumnOptionsMenu`) — it is a convenience inside the
 * menu, never the thing that summons it.
 *
 * Rendering a trigger that opens an empty menu is a lying affordance, so the
 * header asks this first.
 */
export function hasColumnMenuItems({
  actions,
  filterable,
  groupable,
  movable,
}: {
  actions?: TableGridHeaderActions;
  filterable?: boolean;
  groupable?: boolean;
  movable?: boolean;
}): boolean {
  if (actions == null) {
    return false;
  }
  return (
    (filterable === true && actions.onFilter != null) ||
    (groupable === true && actions.onGroup != null) ||
    (movable === true && actions.onMove != null)
  );
}

export function ColumnOptionsMenu({
  actions,
  columnId,
  filterable = false,
  groupable = false,
  label,
  movable = false,
  onSort,
  sortable = false,
  sortDir,
}: {
  actions: TableGridHeaderActions;
  columnId: string;
  filterable?: boolean;
  groupable?: boolean;
  label: string;
  movable?: boolean;
  onSort: (column: string, direction: SortDirection) => void;
  sortable?: boolean;
  sortDir: SortDirection;
}) {
  const showFilter = filterable && actions.onFilter != null;
  const showGroup = groupable && actions.onGroup != null;
  const showMove = movable && actions.onMove != null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          // Named per column, because a table of eight identical "Column
          // options" buttons is unusable in a screen reader's control list.
          aria-label={`${label} column options`}
          className={COLUMN_MENU_TRIGGER_CLASS}
          // ISS-5812: `draggable={false}` here does NOT stop a column drag —
          // the HTML drag model walks UP from the pressed node to the nearest
          // `draggable` ancestor (the header cell), so a child opting itself out
          // is simply not a match. What keeps a press here opening the menu is
          // Radix's own `pointerdown` handling on the trigger. Kept so the
          // chevron is never itself the drag source.
          data-no-column-drag
          draggable={false}
          type="button"
        >
          <ChevronDownIcon className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {sortable ? (
          <>
            <DropdownMenuItem
              onSelect={() => onSort(columnId, "asc")}
            >
              <ArrowUpIcon />
              Sort ascending
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => onSort(columnId, "desc")}
            >
              <ArrowDownIcon />
              Sort descending
            </DropdownMenuItem>
          </>
        ) : null}
        {showFilter ? (
          <DropdownMenuItem
            onSelect={() => actions.onFilter?.(columnId)}
          >
            <FilterIcon />
            Filter
          </DropdownMenuItem>
        ) : null}
        {showGroup ? (
          <DropdownMenuItem
            onSelect={() => actions.onGroup?.(columnId)}
          >
            <Rows3Icon />
            Group by this column
          </DropdownMenuItem>
        ) : null}
        {showMove ? (
          <>
            {sortable || showFilter || showGroup ? (
              <DropdownMenuSeparator />
            ) : null}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <ArrowRightIcon />
                Move
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem
                  onSelect={() => actions.onMove?.(columnId, "start")}
                >
                  <ChevronsLeftIcon />
                  To start
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => actions.onMove?.(columnId, "left")}
                >
                  <ArrowLeftIcon />
                  Left
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => actions.onMove?.(columnId, "right")}
                >
                  <ArrowRightIcon />
                  Right
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => actions.onMove?.(columnId, "end")}
                >
                  <ChevronsRightIcon />
                  To end
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
