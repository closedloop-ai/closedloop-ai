"use client";

import type { DocumentType } from "@repo/api/src/types/document";
import { Badge } from "@repo/design-system/components/ui/badge";
import { cn } from "@repo/design-system/lib/utils";
import {
  DOCUMENT_TYPE_COLORS,
  DOCUMENT_TYPE_LABELS,
} from "@/lib/project-constants";

type DocumentTypeBadgeProps = {
  type: DocumentType;
  className?: string;
};

/**
 * Badge component for displaying artifact types with appropriate colors.
 * Uses the design system Badge as a base and applies type-specific styling.
 */
export function DocumentTypeBadge({ type, className }: DocumentTypeBadgeProps) {
  const typeColors = DOCUMENT_TYPE_COLORS[type] ?? {
    bg: "bg-gray-100 dark:bg-gray-800",
    text: "text-gray-700 dark:text-gray-300",
  };
  const typeLabel =
    DOCUMENT_TYPE_LABELS[type as keyof typeof DOCUMENT_TYPE_LABELS] ?? type;

  return (
    <Badge
      className={cn("border-0", typeColors.bg, typeColors.text, className)}
      variant="outline"
    >
      {typeLabel}
    </Badge>
  );
}
