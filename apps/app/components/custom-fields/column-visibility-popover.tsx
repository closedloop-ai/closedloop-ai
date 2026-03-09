"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Checkbox } from "@repo/design-system/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import { SlidersHorizontalIcon } from "lucide-react";

/** Minimal column descriptor for visibility control. */
export type CustomFieldColumnDef = {
  /** The custom field ID — used as the column key. */
  customFieldId: string;
  /** Display name shown in the popover. */
  name: string;
};

type ColumnVisibilityPopoverProps = {
  fields: CustomFieldColumnDef[];
  visibleColumns: Record<string, boolean>;
  onToggle: (fieldId: string) => void;
};

export function ColumnVisibilityPopover({
  fields,
  visibleColumns,
  onToggle,
}: Readonly<ColumnVisibilityPopoverProps>) {
  if (fields.length === 0) {
    return null;
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline">
          <SlidersHorizontalIcon className="mr-2 h-4 w-4" />
          Columns
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-2">
        <div className="flex flex-col gap-1">
          <p className="mb-1 px-2 font-medium text-muted-foreground text-xs">
            Custom Field Columns
          </p>
          {fields.map((field) => {
            const isVisible = visibleColumns[field.customFieldId] ?? false;
            return (
              <label
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-accent"
                htmlFor={`col-vis-${field.customFieldId}`}
                key={field.customFieldId}
              >
                <Checkbox
                  checked={isVisible}
                  id={`col-vis-${field.customFieldId}`}
                  onCheckedChange={() => onToggle(field.customFieldId)}
                />
                <span className="text-sm">{field.name}</span>
              </label>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
