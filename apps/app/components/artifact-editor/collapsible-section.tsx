"use client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/design-system/components/ui/collapsible";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";

type CollapsibleSectionProps = {
  /**
   * Section title displayed in the trigger
   */
  title: string;
  /**
   * Whether the section is currently expanded
   */
  open: boolean;
  /**
   * Handler called when the open state changes
   */
  onOpenChange: (open: boolean) => void;
  /**
   * Content to display when expanded
   */
  children: React.ReactNode;
  /**
   * Optional className for CollapsibleContent
   */
  contentClassName?: string;
};

/**
 * Reusable collapsible section with consistent chevron toggle styling.
 * Used in metadata panels for Properties, Execution Log, and Comments sections.
 */
export function CollapsibleSection({
  title,
  open,
  onOpenChange,
  children,
  contentClassName = "space-y-4 px-3 pb-3",
}: Readonly<CollapsibleSectionProps>) {
  return (
    <Collapsible onOpenChange={onOpenChange} open={open}>
      <CollapsibleTrigger className="flex w-full items-center justify-between rounded-lg p-3 font-medium text-sm transition-colors hover:bg-accent">
        <span>{title}</span>
        {open ? (
          <ChevronUpIcon className="h-4 w-4" />
        ) : (
          <ChevronDownIcon className="h-4 w-4" />
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className={contentClassName}>
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
