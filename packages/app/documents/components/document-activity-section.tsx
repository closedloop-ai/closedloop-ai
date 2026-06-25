"use client";

import { formatDateTimeOrFallback } from "@repo/app/shared/lib/date-utils";
import { CollapsibleSection } from "@repo/design-system/components/ui/collapsible-section";
import { type ReactNode, useState } from "react";

export type DocumentActivitySectionProps = {
  createdAt: string | Date;
  updatedAt: string | Date;
  createdByContent?: ReactNode;
  emptyCreatorLabel?: string;
  defaultOpen?: boolean;
};

export function DocumentActivitySection({
  createdAt,
  updatedAt,
  createdByContent,
  emptyCreatorLabel = "Unknown user",
  defaultOpen = false,
}: Readonly<DocumentActivitySectionProps>) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <CollapsibleSection onOpenChange={setIsOpen} open={isOpen} title="Activity">
      <div className="space-y-1 text-muted-foreground text-sm">
        <p>Created: {formatDateTimeOrFallback(createdAt)}</p>
        <p>
          Created by: {createdByContent ?? <span>{emptyCreatorLabel}</span>}
        </p>
        <p>Updated: {formatDateTimeOrFallback(updatedAt)}</p>
      </div>
    </CollapsibleSection>
  );
}
