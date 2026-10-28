"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import {
  PRIORITY_LABELS,
  type PriorityValue,
} from "@closedloop-ai/design-system/lib/priority-order";
import { cn } from "@closedloop-ai/design-system/lib/utils";

const priorityBadgeVariants = cva(
  "inline-flex items-center justify-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-colors",
  {
    variants: {
      priority: {
        LOW: "border-info/30 bg-info/10 text-info-foreground",
        MEDIUM: "border-warning/30 bg-warning/10 text-warning-foreground",
        HIGH: "border-destructive/30 bg-destructive/10 text-destructive",
        URGENT: "border-destructive/50 bg-destructive/20 text-destructive font-semibold",
      },
    },
    defaultVariants: {
      priority: "MEDIUM",
    },
  }
);

type Priority = PriorityValue;

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
      {PRIORITY_LABELS[priority]}
    </span>
  );
}

export { PriorityBadge, priorityBadgeVariants };
export type { PriorityBadgeProps, Priority };
