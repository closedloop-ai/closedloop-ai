"use client";

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
};

export function DocumentTableToolbar({
  filterText,
  onFilterTextChange,
  leadingContent,
  filterPopoverProps,
  tableViewMenuProps,
  activeFiltersBarProps,
}: DocumentTableToolbarProps) {
  return (
    <>
      <div className="flex min-w-fit items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2">{leadingContent}</div>
        <div className="flex items-center gap-2">
          <div className="relative min-w-[200px] max-w-[350px]">
            <div className="pointer-events-none absolute inset-y-0 left-3 flex items-center">
              <SearchIcon className="h-4 w-4 text-muted-foreground" />
            </div>
            <Input
              aria-label="Filter items"
              className="h-8 pl-9 shadow-none"
              onChange={(event) => onFilterTextChange(event.target.value)}
              placeholder="Filter items..."
              value={filterText}
            />
          </div>
          {filterPopoverProps ? (
            <FilterPopover {...filterPopoverProps} />
          ) : null}
          <TableViewMenu {...tableViewMenuProps} />
        </div>
      </div>
      {activeFiltersBarProps?.filtersReturn.isAnyFilterActive ? (
        <ActiveFiltersBar {...activeFiltersBarProps} />
      ) : null}
    </>
  );
}
