"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import { Switch } from "@repo/design-system/components/ui/switch";
import { Settings2Icon } from "lucide-react";
import {
  ALL_ARTIFACT_COLUMNS,
  ARTIFACT_COLUMN_LABELS,
  type ArtifactColumn,
  type ColumnVisibility,
} from "@/hooks/use-column-visibility";

type ColumnVisibilityPanelProps = {
  visibility: ColumnVisibility;
  onToggle: (column: ArtifactColumn) => void;
  /** Override the list of columns shown in the panel. Defaults to ALL_ARTIFACT_COLUMNS. */
  columns?: ArtifactColumn[];
};

export function ColumnVisibilityPanel({
  visibility,
  onToggle,
  columns = ALL_ARTIFACT_COLUMNS,
}: ColumnVisibilityPanelProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button className="h-9 shadow-none" size="sm" variant="outline">
          <Settings2Icon className="h-4 w-4" />
          Options
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        <div className="flex items-center justify-between px-4 pt-4 pb-2">
          <h4 className="font-semibold text-lg">Show/Hide Columns</h4>
        </div>
        <p className="px-4 pb-3 text-muted-foreground text-xs">
          Show or hide columns across all artifact types
        </p>
        <div className="flex flex-col px-4 pb-4">
          {columns.map((column) => (
            <div
              className="flex h-9 cursor-pointer items-center justify-between"
              key={column}
            >
              <span className="text-sm">{ARTIFACT_COLUMN_LABELS[column]}</span>
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
