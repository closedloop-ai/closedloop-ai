"use client";

import { SectionHeader } from "./section-header";
import type { ReactNode } from "react";

type CollapsibleSectionProps = {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  contentClassName?: string;
};

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
