"use client";

import { Button } from "./button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./popover";
import { Switch } from "./switch";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "./toggle-group";
import {
  AlignLeftIcon,
  LayoutGridIcon,
  ListOrderedIcon,
  RotateCcwIcon,
  Settings2Icon,
} from "lucide-react";
import type { ReactNode } from "react";

export type TableViewMode = "list" | "card";

export type TableViewMenuColumn = {
  id: string;
  label: string;
  icon?: ReactNode;
  visible: boolean;
};

export type TableViewMenuGroupOption = {
  value: string;
  label: string;
};

export type TableViewMenuProps = Readonly<{
  columns?: TableViewMenuColumn[];
  onToggleColumn?: (columnId: string) => void;
  groupByValue?: string;
  groupByOptions?: TableViewMenuGroupOption[];
  onChangeGroupBy?: (value: string) => void;
  view?: TableViewMode;
  onChangeView?: (view: TableViewMode) => void;
  onResetView?: () => void;
  onResetToStackRank?: () => void;
  columnsHeading?: string;
  /** Popover edge to align to the trigger. Defaults to "end" (right-aligned). */
  align?: "start" | "end";
}>;

const RESET_ROW_CLASS =
  "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-left font-medium text-muted-foreground text-sm transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-4 [&_svg]:shrink-0";

function SectionLabel({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <p className="mb-2 px-1 font-medium text-muted-foreground text-xs">
      {children}
    </p>
  );
}

function GroupBySegmented({
  value,
  options,
  onChange,
}: Readonly<{
  value: string;
  options: TableViewMenuGroupOption[];
  onChange: (value: string) => void;
}>) {
  return (
    <div className="px-1 pt-1 pb-4">
      <SectionLabel>Group by</SectionLabel>
      <ToggleGroup
        className="w-full"
        onValueChange={(next) => {
          if (next) {
            onChange(next);
          }
        }}
        type="single"
        value={value}
        variant="outline"
      >
        {options.map((option) => (
          <ToggleGroupItem className="flex-1" key={option.value} value={option.value}>
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

function ViewModeToggle({
  view,
  onChangeView,
}: Readonly<{
  view: TableViewMode;
  onChangeView: (view: TableViewMode) => void;
}>) {
  return (
    <div className="px-1 pt-1 pb-2">
      <SectionLabel>View</SectionLabel>
      <ToggleGroup
        className="w-full"
        onValueChange={(value) => {
          if (value === "list" || value === "card") {
            onChangeView(value);
          }
        }}
        type="single"
        value={view}
        variant="outline"
      >
        <ToggleGroupItem className="flex-1" value="list">
          <AlignLeftIcon className="size-3.5" />
          List
        </ToggleGroupItem>
        <ToggleGroupItem className="flex-1" value="card">
          <LayoutGridIcon className="size-3.5" />
          Card
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}

export function TableViewMenu({
  columns,
  onToggleColumn,
  groupByValue,
  groupByOptions,
  onChangeGroupBy,
  view,
  onChangeView,
  onResetView,
  onResetToStackRank,
  columnsHeading = "Show / Hide Columns",
  align = "end",
}: TableViewMenuProps) {
  const showViewToggle = view != null && onChangeView != null;
  const showGroupByMode =
    groupByValue != null &&
    groupByOptions != null &&
    groupByOptions.length > 0 &&
    onChangeGroupBy != null;
  const showColumnVisibility =
    columns != null && columns.length > 0 && onToggleColumn != null;
  const showReset = onResetToStackRank != null || onResetView != null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button className="h-8 shadow-none" size="sm" variant="outline">
          <Settings2Icon />
          View
        </Button>
      </PopoverTrigger>
      <PopoverContent align={align} className="w-[324px] p-1 pt-2">
        {showViewToggle ? (
          <ViewModeToggle onChangeView={onChangeView} view={view} />
        ) : null}
        {showGroupByMode ? (
          <GroupBySegmented
            onChange={onChangeGroupBy}
            options={groupByOptions}
            value={groupByValue}
          />
        ) : null}
        {showColumnVisibility ? (
          <div className="px-1 pt-1 pb-1">
            <SectionLabel>{columnsHeading}</SectionLabel>
            <div className="flex flex-col">
              {columns.map((column) => (
                <label
                  className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-muted"
                  htmlFor={`col-${column.id}`}
                  key={column.id}
                >
                  {column.icon}
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
          </div>
        ) : null}
        {showReset ? (
          <>
            <div className="my-1 h-px bg-border" />
            <div className="px-1 pt-1 pb-1">
              {onResetToStackRank ? (
                <button
                  className={RESET_ROW_CLASS}
                  onClick={onResetToStackRank}
                  type="button"
                >
                  <ListOrderedIcon />
                  Reset to stack rank
                </button>
              ) : null}
              {onResetView ? (
                <button
                  className={RESET_ROW_CLASS}
                  onClick={onResetView}
                  type="button"
                >
                  <RotateCcwIcon />
                  Reset view
                </button>
              ) : null}
            </div>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
