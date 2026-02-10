"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { cn } from "@repo/design-system/lib/utils";
import {
  ARTIFACT_SUBTYPE_COLORS,
  ARTIFACT_SUBTYPE_LABELS,
} from "@/lib/project-constants";

type ArtifactSubtypeBadgeProps = {
  subtype: string;
  className?: string;
};

/**
 * Badge component for displaying artifact subtypes with appropriate colors.
 * Uses the design system Badge as a base and applies subtype-specific styling.
 */
export function ArtifactSubtypeBadge({
  subtype,
  className,
}: ArtifactSubtypeBadgeProps) {
  const subtypeColors = ARTIFACT_SUBTYPE_COLORS[subtype] ?? {
    bg: "bg-gray-100 dark:bg-gray-800",
    text: "text-gray-700 dark:text-gray-300",
  };
  const subtypeLabel = ARTIFACT_SUBTYPE_LABELS[subtype] ?? subtype;

  return (
    <Badge
      className={cn(
        "border-0",
        subtypeColors.bg,
        subtypeColors.text,
        className
      )}
      variant="outline"
    >
      {subtypeLabel}
    </Badge>
  );
}
