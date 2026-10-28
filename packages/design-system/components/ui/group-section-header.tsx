"use client";

import { cn } from "@closedloop-ai/design-system/lib/utils";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";

type GroupSectionHeaderProps = Readonly<{
  icon: ReactNode;
  label: string;
  /**
   * Rows in this group. Omit when the caller only holds a PAGE of a larger set:
   * a bare number beside the label reads as the population, so no number is
   * more honest than one that silently means "on this page".
   */
  count?: number;
  /**
   * This group's rows began on an earlier page. Without the marker, a group too
   * large for one page renders the same header twice in a row and reads as two
   * groups sharing a name.
   */
  isContinued?: boolean;
  isOpen: boolean;
  onToggle: () => void;
  className?: string;
}>;

export function GroupSectionHeader({
  icon,
  label,
  count,
  isContinued,
  isOpen,
  onToggle,
  className,
}: GroupSectionHeaderProps) {
  return (
    <button
      aria-expanded={isOpen}
      className={cn(
        "flex w-full items-center gap-2.5 border-b bg-muted/50 py-2.5 pr-4 pl-3.5 font-medium text-sm hover:bg-accent/50",
        className
      )}
      data-grid-group-toggle=""
      onClick={onToggle}
      type="button"
    >
      {isOpen ? (
        <ChevronDownIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
      ) : (
        <ChevronRightIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
      )}
      {icon}
      <span className="min-w-0 truncate">{label}</span>
      {/* Before the count, not after: "In Review 7 (continued)" scans as one
          phrase and reads as "7 continued", which inverts what the number
          means. The marker qualifies the header; the number lands last. */}
      {isContinued ? (
        <span className="shrink-0 text-muted-foreground text-xs">
          (continued)
        </span>
      ) : null}
      {count === undefined ? null : (
        <span className="shrink-0 text-muted-foreground text-xs">{count}</span>
      )}
    </button>
  );
}
