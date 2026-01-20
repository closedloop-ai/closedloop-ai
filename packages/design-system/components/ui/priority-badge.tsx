"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@repo/design-system/lib/utils";

const priorityBadgeVariants = cva(
  "inline-flex items-center justify-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-colors",
  {
    variants: {
      priority: {
        NOT_SET: "border-muted-foreground/30 bg-muted/50 text-muted-foreground",
        LOW: "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-300",
        MEDIUM:
          "border-yellow-200 bg-yellow-50 text-yellow-700 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-300",
        HIGH: "border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300",
      },
    },
    defaultVariants: {
      priority: "NOT_SET",
    },
  }
);

type Priority = "NOT_SET" | "LOW" | "MEDIUM" | "HIGH";

const priorityLabels: Record<Priority, string> = {
  NOT_SET: "Not Set",
  LOW: "Low",
  MEDIUM: "Medium",
  HIGH: "High",
};

interface PriorityBadgeProps
  extends Omit<React.HTMLAttributes<HTMLSpanElement>, "children">,
    VariantProps<typeof priorityBadgeVariants> {
  /** The priority level to display */
  priority: Priority;
}

/**
 * PriorityBadge displays a color-coded badge for project priority levels
 */
function PriorityBadge({ priority, className, ...props }: PriorityBadgeProps) {
  return (
    <span
      data-slot="priority-badge"
      className={cn(priorityBadgeVariants({ priority }), className)}
      {...props}
    >
      {priorityLabels[priority]}
    </span>
  );
}

export { PriorityBadge, priorityBadgeVariants, priorityLabels };
export type { PriorityBadgeProps, Priority };
