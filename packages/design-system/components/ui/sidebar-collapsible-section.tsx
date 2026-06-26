"use client";

import { ChevronDownIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { cn } from "@repo/design-system/lib/utils";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./collapsible";
import { SidebarGroup, SidebarGroupLabel } from "./sidebar";

export type SidebarCollapsibleSectionProps = {
  title: ReactNode;
  action?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
  /** Extra classes for the section's SidebarGroup wrapper (e.g. padding). */
  className?: string;
  /** localStorage key used when a section's expanded state must survive reloads. */
  persistenceKey?: string;
};

/**
 * Collapsible sidebar nav section with a chevron toggle in the group label
 * and an optional trailing action (e.g. an add button). Matches the finalized
 * app sidebar sections (Artifacts / Your Teams / Labs).
 */
export function SidebarCollapsibleSection({
  title,
  action,
  defaultOpen = true,
  children,
  className,
  persistenceKey,
}: SidebarCollapsibleSectionProps) {
  const [open, setOpen] = useState(() =>
    readPersistedOpen(persistenceKey, defaultOpen)
  );

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    writePersistedOpen(persistenceKey, nextOpen);
  }

  return (
    <SidebarGroup className={cn("p-1", className)}>
      <Collapsible onOpenChange={handleOpenChange} open={open}>
        <SidebarGroupLabel className="gap-2">
          <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-1 rounded-md outline-hidden ring-sidebar-ring hover:text-sidebar-foreground focus-visible:ring-2">
            <span className="truncate">{title}</span>
            <ChevronDownIcon
              className={cn(
                "size-3.5 shrink-0 transition-transform duration-150",
                !open && "-rotate-90"
              )}
            />
          </CollapsibleTrigger>
          {action ? <div className="shrink-0">{action}</div> : null}
        </SidebarGroupLabel>
        <CollapsibleContent>{children}</CollapsibleContent>
      </Collapsible>
    </SidebarGroup>
  );
}

function readPersistedOpen(
  persistenceKey: string | undefined,
  defaultOpen: boolean
): boolean {
  if (!persistenceKey || globalThis.window === undefined) {
    return defaultOpen;
  }

  try {
    const value = globalThis.localStorage.getItem(persistenceKey);
    if (value === "true") {
      return true;
    }
    if (value === "false") {
      return false;
    }
  } catch {
    // Storage access can fail in restricted browser contexts; default state is safe.
  }

  return defaultOpen;
}

function writePersistedOpen(
  persistenceKey: string | undefined,
  open: boolean
): void {
  if (!persistenceKey || globalThis.window === undefined) {
    return;
  }

  try {
    globalThis.localStorage.setItem(persistenceKey, String(open));
  } catch {
    // Storage persistence is best-effort; the in-memory toggle still applies.
  }
}
