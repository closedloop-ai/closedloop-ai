"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { ListFilterIcon } from "lucide-react";
import type { SessionFacetGroup } from "./sessions-toolbar";

/**
 * The Sessions filter menu. The DS `FilterPopover`'s `facetGroups` path (which
 * Sessions uses for its Status/Harness/Owner/Repository facets) short-circuits
 * before the quick-toggle row, so this local composition renders the same
 * facet submenus without offering controls that are absent from the rows.
 */
export function SessionsFilterMenu({
  facetGroups,
}: {
  facetGroups: SessionFacetGroup[];
}) {
  const activeCount = facetGroups.reduce(
    (sum, group) => sum + group.selectedValues.length,
    0
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="Filter"
          className="h-8 shadow-none"
          size="sm"
          type="button"
          variant="outline"
        >
          <ListFilterIcon />
          Filter
          {activeCount > 0 ? (
            <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 font-medium text-[10px] text-primary-foreground tabular-nums">
              {activeCount}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        <DropdownMenuGroup>
          {facetGroups.map((group) => (
            <FacetSubmenu group={group} key={group.id} />
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function FacetSubmenu({ group }: { group: SessionFacetGroup }) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        {group.icon}
        <span className="flex-1">{group.label}</span>
        {group.selectedValues.length > 0 ? (
          <span className="text-muted-foreground text-xs">
            {group.selectedValues.length}
          </span>
        ) : null}
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent className="w-60">
          {group.options.map((option) => (
            <DropdownMenuCheckboxItem
              checked={group.selectedValues.includes(option.id)}
              key={option.id}
              onCheckedChange={() => group.onToggle(option.id)}
              onSelect={(event) => event.preventDefault()}
            >
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {option.count === undefined ? null : (
                <span className="text-muted-foreground text-xs">
                  {option.count}
                </span>
              )}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  );
}
