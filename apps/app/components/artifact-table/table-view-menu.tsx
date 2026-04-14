"use client";

import { Button } from "@repo/design-system/components/ui/button";
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
  type ArtifactColumn,
  ArtifactColumn as Col,
  type ColumnVisibility,
} from "@/hooks/use-column-visibility";

const COLUMN_ICONS: Partial<Record<ArtifactColumn, ReactNode>> = {
  [Col.Type]: <FileIcon className="h-4 w-4 text-muted-foreground" />,
  [Col.Assignee]: <UserIcon className="h-4 w-4 text-muted-foreground" />,
  [Col.Loop]: <RefreshCwIcon className="h-4 w-4 text-muted-foreground" />,
  [Col.Parent]: <ListTreeIcon className="h-4 w-4 text-muted-foreground" />,
  [Col.Priority]: <PriorityIcon priority="MEDIUM" size={16} />,
  [Col.Score]: <BadgeCheckIcon className="h-4 w-4 text-muted-foreground" />,
  [Col.DueDate]: <CalendarIcon className="h-4 w-4 text-muted-foreground" />,
  [Col.Updated]: <ClockIcon className="h-4 w-4 text-muted-foreground" />,
  [Col.Project]: <FolderIcon className="h-4 w-4 text-muted-foreground" />,
};

type TableViewMenuProps = {
  visibility: ColumnVisibility;
  onToggle: (column: ArtifactColumn) => void;
  /** Override the list of columns shown in the panel. Defaults to ALL_ARTIFACT_COLUMNS. */
  columns?: ArtifactColumn[];
  /** Whether items are grouped by status. */
  groupByStatus?: boolean;
  /** Toggle group-by-status on/off. */
  onToggleGroupByStatus?: () => void;
};

export function TableViewMenu({
  visibility,
  onToggle,
  columns = ALL_ARTIFACT_COLUMNS,
  groupByStatus,
  onToggleGroupByStatus,
}: TableViewMenuProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button className="h-9 shadow-none" size="sm" variant="outline">
          <Settings2Icon className="h-4 w-4" />
          View
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        {onToggleGroupByStatus != null && (
          <>
            <div className="px-4 pt-4 pb-2">
              <h4 className="font-semibold text-lg">View Options</h4>
            </div>
            <div className="flex flex-col px-4 pb-3">
              <div className="flex h-9 cursor-pointer items-center justify-between">
                <span className="flex items-center gap-2 text-sm">
                  <StatusIcon size={16} status="decorative" />
                  Group by Status
                </span>
                <Switch
                  checked={groupByStatus}
                  id="group-by-status"
                  onCheckedChange={onToggleGroupByStatus}
                />
              </div>
            </div>
            <div className="mx-4 border-t" />
          </>
        )}
        <div className="flex items-center justify-between px-4 pt-4 pb-2">
          <h4 className="font-semibold text-lg">Show/Hide Columns</h4>
        </div>
        <p className="px-4 pb-3 text-muted-foreground text-xs">
          Show or hide columns across all artifact types
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
