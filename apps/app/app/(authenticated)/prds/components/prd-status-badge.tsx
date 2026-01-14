"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { cn } from "@repo/design-system/lib/utils";

type PRDStatusBadgeProps = {
  status: string;
};

const statusStyles: Record<string, string> = {
  Draft: "bg-muted text-muted-foreground border-muted",
  Review: "bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-400 dark:border-yellow-800",
  Approved: "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800",
  Archived: "bg-gray-100 text-gray-600 border-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:border-gray-700",
};

export function PRDStatusBadge({ status }: PRDStatusBadgeProps) {
  return (
    <Badge
      variant="outline"
      className={cn("font-medium", statusStyles[status] ?? statusStyles.Draft)}
    >
      {status}
    </Badge>
  );
}
