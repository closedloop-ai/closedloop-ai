import type { DocumentType } from "@repo/api/src/types/document";
import { buttonVariants } from "@repo/design-system/components/ui/button";
import { cn } from "@repo/design-system/lib/utils";
import {
  DOCUMENT_TYPE_BADGE_LABELS,
  DOCUMENT_TYPE_ICONS,
} from "@/lib/project-constants";

export type DocumentTypeBadgeProps = {
  type: DocumentType;
  className?: string;
};

export function DocumentTypeBadge({
  type,
  className,
}: Readonly<DocumentTypeBadgeProps>) {
  const Icon = DOCUMENT_TYPE_ICONS[type];
  const label = DOCUMENT_TYPE_BADGE_LABELS[type];
  return (
    <span
      className={cn(
        buttonVariants({ variant: "outline", size: "sm" }),
        "pointer-events-none cursor-default hover:bg-input hover:text-foreground dark:hover:bg-input",
        className
      )}
    >
      <Icon aria-hidden />
      {label}
    </span>
  );
}
