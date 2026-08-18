"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Checkbox } from "@repo/design-system/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { BotIcon, FolderGitIcon, ListFilterIcon } from "lucide-react";

export type FilterOption = { value: string; label: string; count?: number };

export type FilterDimension = {
  key: string;
  label: string;
  icon: React.ReactNode;
  options: readonly FilterOption[];
  selected: ReadonlySet<string>;
  onToggle: (value: string) => void;
};

const FilterSubMenu = ({ dimension }: { dimension: FilterDimension }) => (
  <DropdownMenuSub>
    <DropdownMenuSubTrigger>
      {dimension.icon}
      <span className="flex-1">{dimension.label}</span>
      {dimension.selected.size > 0 ? (
        <span className="text-muted-foreground text-xs tabular-nums">
          {dimension.selected.size}
        </span>
      ) : null}
    </DropdownMenuSubTrigger>
    <DropdownMenuSubContent className="max-h-72 w-56 overflow-y-auto">
      {dimension.options.map((option) => (
        <DropdownMenuItem
          className="gap-2.5"
          key={option.value}
          onSelect={(event) => {
            event.preventDefault();
            dimension.onToggle(option.value);
          }}
        >
          <Checkbox
            checked={dimension.selected.has(option.value)}
            className="[&_svg]:!text-primary-foreground pointer-events-none"
          />
          <span className="min-w-0 flex-1 truncate">{option.label}</span>
          {option.count === undefined ? null : (
            <span className="text-muted-foreground text-xs tabular-nums">
              {option.count}
            </span>
          )}
        </DropdownMenuItem>
      ))}
    </DropdownMenuSubContent>
  </DropdownMenuSub>
);

// Generic Filter dropdown: one submenu per dimension, with a count badge for
// the total number of active selections. Reused by the inventory table and the
// detail Sessions / Branches tables.
export const TableFilterMenu = ({
  dimensions,
  align = "start",
}: {
  dimensions: readonly FilterDimension[];
  align?: "start" | "end";
}) => {
  const total = dimensions.reduce(
    (sum, dimension) => sum + dimension.selected.size,
    0
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button className="h-8 shadow-none" size="sm" variant="outline">
          <ListFilterIcon />
          Filter
          {total > 0 ? (
            <span className="ml-1 flex min-w-5 items-center justify-center rounded-full bg-primary px-1 font-medium text-[11px] text-primary-foreground">
              {total}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-52">
        {dimensions.map((dimension) => (
          <FilterSubMenu dimension={dimension} key={dimension.key} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export const AgentsFilterMenu = ({
  sourceOptions,
  harnessOptions,
  sourceSelected,
  harnessSelected,
  onToggleSource,
  onToggleHarness,
}: {
  sourceOptions: readonly FilterOption[];
  harnessOptions: readonly FilterOption[];
  sourceSelected: ReadonlySet<string>;
  harnessSelected: ReadonlySet<string>;
  onToggleSource: (value: string) => void;
  onToggleHarness: (value: string) => void;
}) => (
  <TableFilterMenu
    dimensions={[
      {
        key: "source",
        label: "Source",
        icon: <FolderGitIcon className="size-4 text-muted-foreground" />,
        options: sourceOptions,
        selected: sourceSelected,
        onToggle: onToggleSource,
      },
      {
        key: "harness",
        label: "Harness",
        icon: <BotIcon className="size-4 text-muted-foreground" />,
        options: harnessOptions,
        selected: harnessSelected,
        onToggle: onToggleHarness,
      },
    ]}
  />
);
