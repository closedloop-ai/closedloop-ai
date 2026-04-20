"use client";

import { Priority } from "@repo/api/src/types/common";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import { PriorityIcon } from "@repo/design-system/components/ui/priority-icon";
import { StatusIcon } from "@repo/design-system/components/ui/status-icon";
import { Switch } from "@repo/design-system/components/ui/switch";
import {
  BadgeCheckIcon,
  CalendarIcon,
  ChevronDownIcon,
  ClockIcon,
  FileIcon,
  FolderIcon,
  ListTreeIcon,
  RefreshCwIcon,
  Settings2Icon,
  UserIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import {
  ALL_ARTIFACT_COLUMNS,
  ARTIFACT_COLUMN_LABELS,
  DocumentColumn as Col,
  type ColumnVisibility,
  type DocumentColumn,
} from "@/hooks/use-column-visibility";
import { GROUP_BY_LABELS, GroupByMode } from "@/lib/group-by";

const COLUMN_ICONS: Partial<Record<DocumentColumn, ReactNode>> = {
  [Col.Type]: <FileIcon className="h-4 w-4 text-muted-foreground" />,
  [Col.Assignee]: <UserIcon className="h-4 w-4 text-muted-foreground" />,
  [Col.Loop]: <RefreshCwIcon className="h-4 w-4 text-muted-foreground" />,
  [Col.Parent]: <ListTreeIcon className="h-4 w-4 text-muted-foreground" />,
  [Col.Priority]: <PriorityIcon priority={Priority.Medium} size={16} />,
  [Col.Score]: <BadgeCheckIcon className="h-4 w-4 text-muted-foreground" />,
  [Col.DueDate]: <CalendarIcon className="h-4 w-4 text-muted-foreground" />,
  [Col.Updated]: <ClockIcon className="h-4 w-4 text-muted-foreground" />,
  [Col.Project]: <FolderIcon className="h-4 w-4 text-muted-foreground" />,
};

type TableViewMenuProps = Readonly<{
  visibility: ColumnVisibility;
  onToggle: (column: DocumentColumn) => void;
  /** Override the list of columns shown in the panel. Defaults to ALL_ARTIFACT_COLUMNS. */
  columns?: DocumentColumn[];
  /** Active group-by mode (none | status | assignee | priority). */
  groupBy?: GroupByMode;
  /** Change the active group-by mode. */
  onChangeGroupBy?: (mode: GroupByMode) => void;
}>;

const GROUP_BY_OPTIONS: GroupByMode[] = [
  GroupByMode.None,
  GroupByMode.Status,
  GroupByMode.Assignee,
  GroupByMode.Priority,
];

function GroupByModeSelect({
  groupBy,
  onChangeGroupBy,
}: Readonly<{
  groupBy: GroupByMode;
  onChangeGroupBy: (mode: GroupByMode) => void;
}>) {
  return (
    <div className="flex flex-col px-4 pb-3">
      <div className="flex h-9 items-center justify-between">
        <span className="flex items-center gap-2 text-sm">
          <StatusIcon size={16} status="decorative" />
          Group by
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button className="h-7 text-xs" size="sm" variant="outline">
              {GROUP_BY_LABELS[groupBy]}
              <ChevronDownIcon className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {GROUP_BY_OPTIONS.map((mode) => (
              <DropdownMenuItem
                key={mode}
                onClick={() => onChangeGroupBy(mode)}
              >
                {GROUP_BY_LABELS[mode]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

export function TableViewMenu({
  visibility,
  onToggle,
  columns = ALL_ARTIFACT_COLUMNS,
  groupBy,
  onChangeGroupBy,
}: TableViewMenuProps) {
  const showGroupByMode = groupBy != null && onChangeGroupBy != null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button className="h-8 shadow-none" size="sm" variant="outline">
          <Settings2Icon />
          View
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        {showGroupByMode && (
          <>
            <div className="px-4 pt-4 pb-2">
              <h4 className="font-semibold text-lg">View Options</h4>
            </div>
            <GroupByModeSelect
              groupBy={groupBy}
              onChangeGroupBy={onChangeGroupBy}
            />
            <div className="mx-4 border-t" />
          </>
        )}
        <div className="flex items-center justify-between px-4 pt-4 pb-2">
          <h4 className="font-semibold text-lg">Show/Hide Columns</h4>
        </div>
        <p className="px-4 pb-3 text-muted-foreground text-xs">
          Show or hide columns across all document types
        </p>
        <div className="flex flex-col divide-y px-4 pb-3">
          {columns.map((column) => (
            <div
              className="flex cursor-pointer items-center justify-between py-3"
              key={column}
            >
              <span className="flex items-center gap-2 text-sm">
                {COLUMN_ICONS[column]}
                {ARTIFACT_COLUMN_LABELS[column]}
              </span>
              <Switch
                checked={visibility[column]}
                id={`col-${column}`}
                onCheckedChange={() => onToggle(column)}
              />
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
