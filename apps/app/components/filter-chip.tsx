"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { cn } from "@repo/design-system/lib/utils";
import { XIcon } from "lucide-react";

type FilterChipProps = {
  label: string;
  onRemove: () => void;
  children?: React.ReactNode;
  dropdownClassName?: string;
  className?: string;
};

export function FilterChip({
  label,
  onRemove,
  children,
  dropdownClassName,
  className,
}: FilterChipProps) {
  return (
    <div
      className={cn(
        "inline-flex items-center overflow-hidden rounded-md border text-xs",
        className
      )}
    >
      {children ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="flex max-w-[160px] items-center gap-1 px-2 py-1 hover:bg-accent"
              type="button"
            >
              <span className="truncate">{label}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className={cn("w-60", dropdownClassName)}
          >
            {children}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <span className="flex max-w-[160px] items-center gap-1 px-2 py-1">
          <span className="truncate">{label}</span>
        </span>
      )}
      <button
        aria-label={`Remove ${label} filter`}
        className="flex items-center self-stretch border-l px-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        type="button"
      >
        <XIcon className="size-3" />
      </button>
    </div>
  );
}
