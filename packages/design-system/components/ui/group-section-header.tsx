"use client";

import { cn } from "@repo/design-system/lib/utils";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";

type GroupSectionHeaderProps = Readonly<{
  icon: ReactNode;
  label: string;
  count: number;
  isOpen: boolean;
  onToggle: () => void;
  className?: string;
}>;

export function GroupSectionHeader({
  icon,
  label,
  count,
  isOpen,
  onToggle,
  className,
}: GroupSectionHeaderProps) {
  return (
    <button
      className={cn(
        "flex w-full items-center gap-2.5 border-b bg-muted/50 py-2.5 pr-4 pl-3.5 font-medium text-sm hover:bg-accent/50",
        className
      )}
      onClick={onToggle}
      type="button"
    >
      {isOpen ? (
        <ChevronDownIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
      ) : (
        <ChevronRightIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
      )}
      {icon}
      <span>{label}</span>
      <span className="text-muted-foreground text-xs">{count}</span>
    </button>
  );
}
