"use client";

import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";

type GroupHeaderRowProps = {
  title: string;
  count: number;
  isOpen: boolean;
  onToggle: () => void;
};

export function GroupHeaderRow({
  title,
  count,
  isOpen,
  onToggle,
}: GroupHeaderRowProps) {
  return (
    <button
      className="flex h-12 w-full cursor-pointer items-center gap-1 border-b bg-background px-1 text-left hover:bg-muted/50"
      onClick={onToggle}
      type="button"
    >
      <div className="flex shrink-0 items-center justify-center p-1.5">
        {isOpen ? (
          <ChevronDownIcon className="h-5 w-5 text-muted-foreground" />
        ) : (
          <ChevronRightIcon className="h-5 w-5 text-muted-foreground" />
        )}
      </div>
      <span className="font-medium text-foreground text-sm">{title}</span>
      <span className="ml-1 text-muted-foreground text-xs">({count})</span>
    </button>
  );
}
