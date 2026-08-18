import type { DocumentType } from "@repo/api/src/types/document";
// Icons, labels, badge labels, and pill colors are the single canonical set in
// project-constants (which itself re-binds the FEA-3954 canonical label maps);
// this badge composes them so the two surfaces cannot drift.
import {
  DOCUMENT_TYPE_BADGE_LABELS,
  DOCUMENT_TYPE_COLORS,
  DOCUMENT_TYPE_ICONS,
  DOCUMENT_TYPE_LABELS,
} from "@repo/app/projects/lib/project-constants";
import { Badge } from "@repo/design-system/components/ui/badge";
import { buttonVariants } from "@repo/design-system/components/ui/button";
import { cn } from "@repo/design-system/lib/utils";
import { FileQuestionIcon } from "lucide-react";

// Unknown-type fallback. Distinct from every named-type glyph (FileTextIcon now
// belongs to Doc) so an unrecognized subtype never renders identically to a
// real one.
const DEFAULT_DOCUMENT_TYPE_ICON = FileQuestionIcon;
const DEFAULT_DOCUMENT_TYPE_COLORS = {
  bg: "bg-muted",
  text: "text-muted-foreground",
} as const;

export type DocumentTypeBadgeProps = {
  type: DocumentType | string;
  className?: string;
  appearance?: "compact" | "pill";
};

function getDocumentTypePresentation(type: DocumentType | string) {
  return {
    badgeLabel:
      DOCUMENT_TYPE_BADGE_LABELS[
        type as keyof typeof DOCUMENT_TYPE_BADGE_LABELS
      ] ?? type,
    colors:
      DOCUMENT_TYPE_COLORS[type as keyof typeof DOCUMENT_TYPE_COLORS] ??
      DEFAULT_DOCUMENT_TYPE_COLORS,
    icon:
      DOCUMENT_TYPE_ICONS[type as keyof typeof DOCUMENT_TYPE_ICONS] ??
      DEFAULT_DOCUMENT_TYPE_ICON,
    label:
      DOCUMENT_TYPE_LABELS[type as keyof typeof DOCUMENT_TYPE_LABELS] ?? type,
  };
}

export function DocumentTypeBadge({
  type,
  className,
  appearance = "compact",
}: Readonly<DocumentTypeBadgeProps>) {
  const {
    badgeLabel,
    colors,
    icon: Icon,
    label,
  } = getDocumentTypePresentation(type);

  if (appearance === "pill") {
    return (
      <Badge
        className={cn("border-0", colors.bg, colors.text, className)}
        variant="outline"
      >
        {label}
      </Badge>
    );
  }

  return (
    <span
      className={cn(
        buttonVariants({ variant: "outline", size: "sm" }),
        "pointer-events-none cursor-default hover:bg-input hover:text-foreground dark:hover:bg-input",
        className
      )}
    >
      <Icon aria-hidden />
      {badgeLabel}
    </span>
  );
}
