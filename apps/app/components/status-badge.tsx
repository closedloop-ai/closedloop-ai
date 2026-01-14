"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { cn } from "@repo/design-system/lib/utils";

type StatusBadgeProps = {
  status: string;
  colorMap: Record<string, string>;
  defaultStyle?: string;
};

export function StatusBadge({
  status,
  colorMap,
  defaultStyle,
}: StatusBadgeProps) {
  return (
    <Badge
      className={cn(
        "font-medium",
        colorMap[status] ?? defaultStyle ?? colorMap[Object.keys(colorMap)[0]]
      )}
      variant="outline"
    >
      {status}
    </Badge>
  );
}

// Pre-configured color maps for common use cases
export const PRD_STATUS_COLORS: Record<string, string> = {
  Draft: "bg-muted text-muted-foreground border-muted",
  Review:
    "bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-400 dark:border-yellow-800",
  Approved:
    "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800",
  Archived:
    "bg-gray-100 text-gray-600 border-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:border-gray-700",
};

export const IMPL_PLAN_STATUS_COLORS: Record<string, string> = {
  Draft:
    "bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-400 dark:border-yellow-800",
  Ready:
    "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800",
  "In Progress":
    "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800",
  Generating:
    "bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-900/30 dark:text-purple-400 dark:border-purple-800",
  Failed:
    "bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800",
  Archived:
    "bg-gray-100 text-gray-600 border-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:border-gray-700",
};

export function PRDStatusBadge({ status }: { status: string }) {
  return <StatusBadge colorMap={PRD_STATUS_COLORS} status={status} />;
}

export function ImplementationPlanStatusBadge({ status }: { status: string }) {
  return <StatusBadge colorMap={IMPL_PLAN_STATUS_COLORS} status={status} />;
}
