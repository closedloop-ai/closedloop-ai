"use client";

import { SectionHeader } from "./relationships/section-header";

type CollapsibleSectionProps = {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  contentClassName?: string;
};

/**
 * Collapsible block with a shared `SectionHeader` chrome (ghost chevron)
 * and plain conditional body rendering. Used for document-detail subsections
 * without an "add" action in the header.
 */
export function CollapsibleSection({
  title,
  open,
  onOpenChange,
  children,
  contentClassName = "space-y-4 pt-3 pb-3",
}: Readonly<CollapsibleSectionProps>) {
  return (
    <div className="bg-background">
      <SectionHeader
        isOpen={open}
        onToggle={() => onOpenChange(!open)}
        title={title}
      />
      {open ? <div className={contentClassName}>{children}</div> : null}
    </div>
  );
}
