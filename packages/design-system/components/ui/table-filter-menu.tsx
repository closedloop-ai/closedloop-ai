"use client";

import { Button } from "@closedloop-ai/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@closedloop-ai/design-system/components/ui/dropdown-menu";
import { ListFilterIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Generic table filter menu — a `Filter` button opening a dropdown of submenus.
 * Each group renders as a single-select radio submenu; selecting a value calls
 * `onValueChange` immediately. Data-agnostic and shared across surfaces (web
 * `apps/app`, desktop renderer): callers build the `groups` from their own
 * filter state.
 */

export type TableFilterOption = { value: string; label: string };

export type TableFilterGroup = {
  id: string;
  label: string;
  icon: ReactNode;
  options: TableFilterOption[];
  value: string;
  onValueChange: (value: string) => void;
};

export function TableFilterMenu({ groups }: { groups: TableFilterGroup[] }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline">
          <ListFilterIcon className="size-4" />
          Filter
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {groups.map((group) => (
          <FilterSubMenu group={group} key={group.id} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function FilterSubMenu({ group }: { group: TableFilterGroup }) {
  const { icon, label, options, value, onValueChange } = group;
  const selectedLabel = options.find((option) => option.value === value)?.label;

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        {icon}
        <span className="flex-1">{label}</span>
        {selectedLabel ? (
          <span className="text-muted-foreground text-xs">{selectedLabel}</span>
        ) : null}
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent className="w-48">
          <DropdownMenuRadioGroup onValueChange={onValueChange} value={value}>
            {options.map((option) => (
              <DropdownMenuRadioItem key={option.value} value={option.value}>
                {option.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  );
}
