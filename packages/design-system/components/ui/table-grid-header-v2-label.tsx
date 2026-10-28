"use client";

/**
 * The column header's LABEL and its options menu, lifted out of
 * `table-grid-header-v2.tsx` (ISS-9313) when wiring the column registry's
 * alignment and accessible-name declarations pushed that file past the
 * 1,000-line ceiling in `AGENTS.md`.
 *
 * They are one responsibility — what a header cell renders INSIDE its own
 * track — and they move together: `HeaderActionsMenu` renders `HeaderLabel`,
 * and both take the same `alignEnd` flag, so splitting anywhere between them
 * would have cut a seam that is not there. The cell itself, the roving-focus
 * wiring and the leading identity column stay in the parent, which owns where
 * a header sits rather than what it says.
 *
 * `packages/design-system/components/ui` is excluded from Biome (see the root
 * `biome.jsonc` `files.includes`), so nothing in CI enforces the ceiling here
 * — which is exactly why it is enforced by hand.
 */

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@closedloop-ai/design-system/components/ui/dropdown-menu";
import {
  getNextSortDirection,
  type SortDirection,
  SortIndicator,
} from "@closedloop-ai/design-system/components/ui/sortable-column-header";
import type { ColumnMovePlacement } from "@closedloop-ai/design-system/lib/column-order";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import {
  ArrowDownIcon,
  ArrowLeftRightIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  FilterIcon,
  Rows3Icon,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "./grid-table-v2-tooltip";
// Type-only, so it erases: the parent runtime-imports this module, and this
// module never imports the parent at runtime.
import type { TableGridHeaderV2Actions } from "./table-grid-header-v2";

export function HeaderLabel({
  alignEnd,
  draggable,
  label,
  tooltip,
}: {
  alignEnd?: boolean;
  draggable?: boolean;
  label: string;
  tooltip?: string;
}) {
  const labelNode = (
    <span
      className={cn(
        "line-clamp-2 min-w-0 whitespace-normal font-medium text-[11px] text-muted-foreground leading-[1.25]",
        // Not `flex-1` when end-aligned: a label that eats the row's free space
        // leaves the container's `justify-end` nothing to distribute, which is
        // the ISS-5333 bug. `text-right` still matters once it wraps to line two.
        alignEnd ? "text-right" : "flex-1",
        draggable && "cursor-grab active:cursor-grabbing",
        // ISS-11837: a draggable label's only pointer action is the drag, so it
        // keeps the grab cursor. `cn` is tailwind-merge, so a later
        // `cursor-pointer` from the "Drag to reorder column" tooltip would
        // replace `cursor-grab` and promise a click that does nothing.
        tooltip && !draggable && "cursor-pointer"
      )}
    >
      {label}
    </span>
  );
  if (!tooltip) {
    return labelNode;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{labelNode}</TooltipTrigger>
      <TooltipContent className="max-w-[232px] text-left" sideOffset={8}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}

export function HeaderActionsMenu({
  actions,
  alignEnd,
  columnId,
  controlName,
  draggable,
  filterable = false,
  groupable = false,
  label,
  movable = false,
  onSort,
  sortable = true,
  sortBy,
  sortDir,
  tooltip,
}: {
  actions: TableGridHeaderV2Actions;
  alignEnd?: boolean;
  columnId: string;
  /**
   * What the trigger BUTTON calls this column. Separate from `label`, which is
   * what the header DISPLAYS: a column may render no visible label on purpose,
   * and interpolating that blank into the button's name would leave an operable
   * control called " column options".
   */
  controlName: string;
  draggable?: boolean;
  filterable?: boolean;
  groupable?: boolean;
  label: string;
  movable?: boolean;
  onSort: (column: string, direction: SortDirection) => void;
  sortable?: boolean;
  sortBy: string | null;
  sortDir: SortDirection;
  tooltip?: string;
}) {
  const filterContent = actions.getFilterContent?.(columnId);
  const showsFilterSubmenu = filterable && Boolean(filterContent);
  const showsFilterItem =
    filterable && !actions.getFilterContent && Boolean(actions.onFilter);
  const showsGroupItem = groupable && Boolean(actions.onGroup);
  // ISS-11837: the separator divides Move column from the items above it, so
  // a menu whose only item is Move column (a column that cannot sort, filter
  // or group) renders none rather than opening on a divider.
  const showsItemsBeforeMove =
    sortable || showsFilterSubmenu || showsFilterItem || showsGroupItem;
  return (
    <div
      className={cn(
        "group/menu flex min-w-0 items-center gap-1",
        alignEnd ? "justify-end" : "flex-1"
      )}
    >
      {/* End-aligned: the caret and the options chevron LEAD the label instead
          of trailing it. Trailing them right-aligns the CARET while leaving the
          label inset from the rail by their width — 32px unsorted, 48px sorted,
          and a different inset in each of this cell's three branches — so
          adjacent right-aligned headers line up with neither each other nor
          their own digits. Leading them puts the LABEL last, on the values' x.
          DOM order still matches visual order, so focus order holds (WCAG 2.4.3). */}
      {alignEnd ? null : (
        <HeaderLabel
          alignEnd={alignEnd}
          draggable={draggable}
          label={label}
          tooltip={tooltip}
        />
      )}
      {sortBy === columnId ? (
        <SortIndicator
          className="size-3 shrink-0"
          direction={sortDir}
          isActive
        />
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            aria-label={`${controlName} column options`}
            className={cn(
              "flex size-5 shrink-0 items-center justify-center rounded-[5px] text-muted-foreground opacity-0 transition-[opacity,background,color] duration-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/header:opacity-100 data-[state=open]:bg-muted data-[state=open]:text-foreground data-[state=open]:opacity-100",
              // `ml-auto` pushes the chevron to the rail, which is right when it
              // TRAILS the label and wrong when it leads it.
              alignEnd ? null : "ml-auto"
            )}
            data-no-column-drag
            draggable={false}
            type="button"
          >
            <ChevronDownIcon className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-[245px] rounded-lg shadow-[0_12px_32px_oklch(0.15_0_0/0.10),0_2px_6px_oklch(0.15_0_0/0.04)]"
        >
          {sortable ? (
            <>
              <DropdownMenuItem
                className="rounded-md px-3 py-[7px] text-[13px]"
                onSelect={() => onSort(columnId, "asc")}
              >
                <ArrowUpIcon />
                Sort ascending
              </DropdownMenuItem>
              <DropdownMenuItem
                className="rounded-md px-3 py-[7px] text-[13px]"
                onSelect={() => onSort(columnId, "desc")}
              >
                <ArrowDownIcon />
                Sort descending
              </DropdownMenuItem>
            </>
          ) : null}
          {showsFilterSubmenu ? (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="rounded-md px-3 py-[7px] text-[13px]">
                <FilterIcon />
                Filter
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-60">
                {filterContent}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ) : showsFilterItem ? (
            <DropdownMenuItem
              className="rounded-md px-3 py-[7px] text-[13px]"
              onSelect={() => actions.onFilter?.(columnId)}
            >
              <FilterIcon />
              Filter
            </DropdownMenuItem>
          ) : null}
          {/* whitlockk review: `groupable` is only a COLUMN capability — it says the
              column can be grouped by, not that the host wired grouping. Gating
              on `actions.onGroup` as well (exactly as the filter path gates on
              `getFilterContent`/`onFilter`) stops a table passing only
              `actions.onFilter` from rendering an enabled Group item whose
              optional callback does nothing when selected. */}
          {showsGroupItem ? (
            <DropdownMenuItem
              className="rounded-md px-3 py-[7px] text-[13px]"
              onSelect={() => actions.onGroup?.(columnId)}
            >
              <Rows3Icon />
              Group
            </DropdownMenuItem>
          ) : null}
          {movable ? (
            <>
              {showsItemsBeforeMove ? <DropdownMenuSeparator /> : null}
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="rounded-md px-3 py-[7px] text-[13px]">
                  <ArrowLeftRightIcon />
                  Move column
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-44">
                  <DropdownMenuItem
                    onSelect={() => actions.onMove?.(columnId, "start")}
                  >
                    Move to start
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => actions.onMove?.(columnId, "left")}
                  >
                    Move left
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => actions.onMove?.(columnId, "right")}
                  >
                    Move right
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => actions.onMove?.(columnId, "end")}
                  >
                    Move to end
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {alignEnd ? (
        <HeaderLabel
          alignEnd={alignEnd}
          draggable={draggable}
          label={label}
          tooltip={tooltip}
        />
      ) : null}
    </div>
  );
}
