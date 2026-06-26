"use client";

import { cn } from "@repo/design-system/lib/utils";
import { ReviewFindingPriority } from "@/lib/engineer/review-finding-priority";

const PRIORITY_CLASSES: Record<ReviewFindingPriority, string> = {
  [ReviewFindingPriority.P0]:
    "border-destructive/50 bg-destructive/10 text-destructive",
  [ReviewFindingPriority.P1]:
    "border-destructive/50 bg-destructive/10 text-destructive",
  [ReviewFindingPriority.P2]:
    "border-warning/50 bg-warning/12 text-warning-foreground",
  [ReviewFindingPriority.P3]: "border-info/50 bg-info/10 text-info",
};

/**
 * Renders the `[P0]`/`[P1]`/`[P2]`/`[P3]` priority chip from a parsed
 * AI review finding. Returns null when no priority was assigned so the
 * card's title row can omit the row entirely.
 */
export function PrCommentPriorityBadge({
  priority,
}: Readonly<{ priority: ReviewFindingPriority | null }>) {
  if (priority === null) {
    return null;
  }
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-sm border px-1.5 py-0 font-semibold text-[11px]",
        PRIORITY_CLASSES[priority]
      )}
    >
      [{priority}]
    </span>
  );
}
