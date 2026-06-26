"use client";

import { cn } from "@repo/design-system/lib/utils";
import type { LucideIcon } from "lucide-react";

export type SourceBadgeProps = {
  Icon: LucideIcon;
  label: string;
  className?: string;
};

/**
 * Small `<icon> label` pill rendered in the head of every feed item to
 * identify its producing source (e.g. "GitHub", "Comments"). Visual
 * primitive — sources render this with their own icon/label combo.
 */
export function SourceBadge({
  Icon,
  label,
  className,
}: Readonly<SourceBadgeProps>) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-sm border bg-muted/30 px-1.5 py-0.5 text-[10px] text-muted-foreground uppercase tracking-wide",
        className
      )}
    >
      <Icon className="h-3 w-3" />
      {label}
    </span>
  );
}
