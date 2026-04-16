"use client";

import type { DocumentStatus } from "@repo/api/src/types/document";
import { StatusIcon } from "@repo/design-system/components/ui/status-icon";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { DOCUMENT_STATUS_TO_ICON } from "@/lib/project-constants";

type StatusSectionHeaderProps = {
  status: DocumentStatus;
  label: string;
  count: number;
  isOpen: boolean;
  onToggle: () => void;
};

export function StatusSectionHeader({
  status,
  label,
  count,
  isOpen,
  onToggle,
}: StatusSectionHeaderProps) {
  const iconStatus = DOCUMENT_STATUS_TO_ICON[status];
  return (
    <button
      className="flex w-full items-center gap-2.5 border-b bg-muted/50 py-2.5 pr-4 pl-[18px] font-medium text-sm hover:bg-accent/50"
      onClick={onToggle}
      type="button"
    >
      {isOpen ? (
        <ChevronDownIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
      ) : (
        <ChevronRightIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
      )}
      <StatusIcon size={16} status={iconStatus} />
      <span>{label}</span>
      <span className="text-muted-foreground text-xs">{count}</span>
    </button>
  );
}
