"use client";

import { ScrollFadeTrack } from "@repo/app/shared/components/scroll-fade-track";
import { Input } from "@repo/design-system/components/ui/input";
import { SearchIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { ActiveFiltersBar } from "./active-filters-bar";
import { FilterPopover } from "./filter-popover";
import { TableViewMenu } from "./table-view-menu";

type DocumentTableToolbarProps = {
  filterText: string;
  onFilterTextChange: (value: string) => void;
  leadingContent?: ReactNode;
  filterPopoverProps?: ComponentProps<typeof FilterPopover>;
  tableViewMenuProps: ComponentProps<typeof TableViewMenu>;
  activeFiltersBarProps?: ComponentProps<typeof ActiveFiltersBar>;
  /**
   * ISS-4682: what this search box actually searches, when it is narrower than
   * the default "everything on this surface".
   *
   * A server-paged surface runs its predicate over the ONE page it was sent, so
   * a user with 137 tasks searches a title, gets nothing, and concludes it is
   * absent. The footer's "on this page" wording softens that after the fact; the
   * control itself has to say it up front. Both strings move together so the
   * accessible name never contradicts the visible placeholder.
   *
   * Defaults preserve the existing copy for every surface that does not opt in.
   */
  searchPlaceholder?: string;
  searchLabel?: string;
};

const DEFAULT_SEARCH_PLACEHOLDER = "Filter items...";
const DEFAULT_SEARCH_LABEL = "Filter items";

export function DocumentTableToolbar({
  filterText,
  onFilterTextChange,
  leadingContent,
  filterPopoverProps,
  tableViewMenuProps,
  activeFiltersBarProps,
  searchPlaceholder,
  searchLabel,
}: DocumentTableToolbarProps) {
  return (
    <>
      {/* Wraps below the toolbar's intrinsic width instead of forcing the page
          wider than the viewport: at mobile width (FEA-3861's no-h-scroll
          invariant) the filter-category control, search, and menus stack onto a
          second row rather than overflowing. `min-w-0` lets the search input
          shrink with the available track; it keeps its comfortable width on
          wider screens via `sm:min-w-[200px]`. */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        {/* Holds the filter-category control (a wide ToggleGroup on My Tasks).
            At mobile width the track scrolls horizontally within the toolbar so
            it never widens the page past the viewport (FEA-3861's no-h-scroll
            invariant); the shared ScrollFadeTrack fades the clipped edge. */}
        <ScrollFadeTrack>{leadingContent}</ScrollFadeTrack>
        {/* `w-full` forces this search-plus-menus row onto its own full-width
            line below `sm`, so the non-shrinking filter/view menu buttons can
            never share the leading track's flex line and overflow the
            `overflow-hidden` page ancestor. `sm:w-auto sm:flex-1` restores the
            single-line layout on wider screens. */}
        <div className="flex w-full min-w-0 items-center justify-end gap-2 sm:w-auto sm:flex-1">
          <div className="relative min-w-0 flex-1 sm:min-w-[200px] sm:max-w-[350px] sm:flex-initial">
            <div className="pointer-events-none absolute inset-y-0 left-3 flex items-center">
              <SearchIcon className="h-4 w-4 text-muted-foreground" />
            </div>
            <Input
              aria-label={searchLabel ?? DEFAULT_SEARCH_LABEL}
              className="h-8 pl-9 shadow-none"
              onChange={(event) => onFilterTextChange(event.target.value)}
              placeholder={searchPlaceholder ?? DEFAULT_SEARCH_PLACEHOLDER}
              value={filterText}
            />
          </div>
          {filterPopoverProps ? (
            <FilterPopover {...filterPopoverProps} />
          ) : null}
          <TableViewMenu {...tableViewMenuProps} />
        </div>
      </div>
      {/* Also rendered when the surface supplied its own chips, so a
          server-side narrowing (My Tasks' recency window) is visible even with
          no facet filter active — otherwise the board would quietly return
          fewer rows with nothing on screen saying why. */}
      {activeFiltersBarProps &&
      (activeFiltersBarProps.filtersReturn.isAnyFilterActive ||
        activeFiltersBarProps.extraChips) ? (
        <ActiveFiltersBar {...activeFiltersBarProps} />
      ) : null}
    </>
  );
}
