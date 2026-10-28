"use client";

import { Button } from "@closedloop-ai/design-system/components/ui/button";
import { DropdownMenuTrigger } from "@closedloop-ai/design-system/components/ui/dropdown-menu";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import { ListFilterIcon, XIcon } from "lucide-react";

/** Private trigger presentation for the owning FilterPopover. */
export function FilterPopoverTrigger({
  filterCount,
  label,
  onClear,
}: {
  filterCount: number;
  label: string;
  onClear?: () => void;
}) {
  return (
    <div className="flex items-center">
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={label}
          className={cn(
            "h-8 shadow-none",
            filterCount > 0 &&
              onClear &&
              "rounded-r-none border-primary/20 bg-primary/10 text-primary hover:bg-primary/15"
          )}
          size="sm"
          variant="outline"
        >
          <ListFilterIcon />
          {label}
          {filterCount > 0 ? (
            <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 font-medium text-[10px] text-primary-foreground tabular-nums">
              {filterCount}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      {filterCount > 0 && onClear ? (
        <button
          aria-label="Clear filters"
          className="flex h-8 w-8 items-center justify-center rounded-r-md border border-l-0 border-primary/20 bg-primary/10 text-primary transition-colors hover:bg-primary/20"
          onClick={onClear}
          type="button"
        >
          <XIcon className="size-4" />
        </button>
      ) : null}
    </div>
  );
}
