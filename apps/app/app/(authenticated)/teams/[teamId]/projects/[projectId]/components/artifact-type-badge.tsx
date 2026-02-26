"use client";

import type { ArtifactType } from "@repo/api/src/types/artifact";
import { Badge } from "@repo/design-system/components/ui/badge";
import { cn } from "@repo/design-system/lib/utils";
import {
  ARTIFACT_TYPE_COLORS,
  ARTIFACT_TYPE_LABELS,
} from "@/lib/project-constants";

type ArtifactTypeBadgeProps = {
  type: ArtifactType;
  className?: string;
};

/**
 * Badge component for displaying artifact types with appropriate colors.
 * Uses the design system Badge as a base and applies type-specific styling.
 */
export function ArtifactTypeBadge({ type, className }: ArtifactTypeBadgeProps) {
  const typeColors = ARTIFACT_TYPE_COLORS[type] ?? {
    bg: "bg-gray-100 dark:bg-gray-800",
    text: "text-gray-700 dark:text-gray-300",
  };
  const typeLabel =
    ARTIFACT_TYPE_LABELS[type as keyof typeof ARTIFACT_TYPE_LABELS] ?? type;

  return (
    <Badge
      className={cn("border-0", typeColors.bg, typeColors.text, className)}
      variant="outline"
    >
      {typeLabel}
    </Badge>
  );
}
