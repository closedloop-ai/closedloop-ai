"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import { Separator } from "@repo/design-system/components/ui/separator";
import { Switch } from "@repo/design-system/components/ui/switch";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import { RotateCcwIcon, Settings2Icon } from "lucide-react";

export type ViewMenuColumn = {
  id: string;
  label: string;
  icon: React.ReactNode;
  visible: boolean;
};

export type GroupByOption = { value: string; label: string };

// Mirrors the production artifacts-table View menu: a Group by segmented control
// over a Show / Hide Columns list, with a Reset view action.
export const AgentsViewMenu = ({
  groupBy,
  groupByOptions,
  onGroupByChange,
  columns,
  onToggleColumn,
  onReset,
  align = "start",
}: {
  groupBy: string;
  groupByOptions: readonly GroupByOption[];
  onGroupByChange: (value: string) => void;
  columns: readonly ViewMenuColumn[];
  onToggleColumn: (id: string) => void;
  onReset: () => void;
  align?: "start" | "end";
}) => (
  <Popover>
    <PopoverTrigger asChild>
      <Button className="h-8 shadow-none" size="sm" variant="outline">
        <Settings2Icon />
        View
      </Button>
    </PopoverTrigger>
    <PopoverContent align={align} className="w-64 p-2">
      <p className="mb-2 px-1 font-medium text-muted-foreground text-xs">
        Group by
      </p>
      <ToggleGroup
        className="w-full"
        onValueChange={(value) => {
          if (value) {
            onGroupByChange(value);
          }
        }}
        type="single"
        value={groupBy}
        variant="outline"
      >
        {groupByOptions.map((option) => (
          <ToggleGroupItem
            className="flex-1 text-xs"
            key={option.value}
            value={option.value}
          >
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <Separator className="my-2.5" />

      <p className="mb-1.5 px-1 font-medium text-muted-foreground text-xs">
        Show / Hide Columns
      </p>
      <div className="flex flex-col">
        {columns.map((column) => (
          <label
            className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-muted"
            htmlFor={`col-${column.id}`}
            key={column.id}
          >
            <span className="text-muted-foreground">{column.icon}</span>
            <span className="min-w-0 flex-1 truncate font-medium text-sm">
              {column.label}
            </span>
            <Switch
              checked={column.visible}
              id={`col-${column.id}`}
              onCheckedChange={() => onToggleColumn(column.id)}
            />
          </label>
        ))}
      </div>

      <Separator className="my-2" />

      <button
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-muted-foreground text-sm transition-colors hover:bg-muted"
        onClick={onReset}
        type="button"
      >
        <RotateCcwIcon className="size-4" />
        Reset view
      </button>
    </PopoverContent>
  </Popover>
);
