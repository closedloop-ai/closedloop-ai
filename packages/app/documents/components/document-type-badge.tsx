import { DocumentType } from "@repo/api/src/types/document";
import { Badge } from "@repo/design-system/components/ui/badge";
import { buttonVariants } from "@repo/design-system/components/ui/button";
import { cn } from "@repo/design-system/lib/utils";
import { BoxIcon, FileIcon, FileTextIcon, ListCheckIcon } from "lucide-react";

const DOCUMENT_TYPE_ICONS = {
  [DocumentType.Prd]: FileIcon,
  [DocumentType.ImplementationPlan]: ListCheckIcon,
  [DocumentType.Template]: FileTextIcon,
  [DocumentType.Feature]: BoxIcon,
} as const;

const DOCUMENT_TYPE_LABELS = {
  [DocumentType.Prd]: "PRD",
  [DocumentType.ImplementationPlan]: "Implementation Plan",
  [DocumentType.Template]: "Template",
  [DocumentType.Feature]: "Feature",
} as const;

const DOCUMENT_TYPE_BADGE_LABELS = {
  [DocumentType.Prd]: "PRD",
  [DocumentType.ImplementationPlan]: "Plan",
  [DocumentType.Template]: "Template",
  [DocumentType.Feature]: "Feature",
} as const;

const DOCUMENT_TYPE_COLORS = {
  [DocumentType.Prd]: {
    bg: "bg-blue-100 dark:bg-blue-900/50",
    text: "text-blue-700 dark:text-blue-300",
  },
  [DocumentType.ImplementationPlan]: {
    bg: "bg-emerald-100 dark:bg-emerald-900/50",
    text: "text-emerald-700 dark:text-emerald-300",
  },
  [DocumentType.Template]: {
    bg: "bg-indigo-100 dark:bg-indigo-900/50",
    text: "text-indigo-700 dark:text-indigo-300",
  },
  [DocumentType.Feature]: {
    bg: "bg-amber-100 dark:bg-amber-900/50",
    text: "text-amber-700 dark:text-amber-300",
  },
} as const;

const DEFAULT_DOCUMENT_TYPE_ICON = FileTextIcon;
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
