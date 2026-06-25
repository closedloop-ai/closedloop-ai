"use client";

import {
  DOCUMENT_STATUS_OPTIONS,
  type DocumentStatus,
} from "@repo/api/src/types/document";
import { useBatchUpdateStatus } from "@repo/app/documents/hooks/use-documents";
import {
  DOCUMENT_STATUS_LABELS,
  DOCUMENT_STATUS_TO_ICON,
} from "@repo/app/projects/lib/project-constants";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { toast } from "@repo/design-system/components/ui/sonner";
import { StatusIcon } from "@repo/design-system/components/ui/status-icon";
import { ArrowRightLeftIcon } from "lucide-react";

type BulkStatusPickerProps = {
  selectedIds: Set<string>;
  onComplete: () => void;
};

export function BulkStatusPicker({
  selectedIds,
  onComplete,
}: BulkStatusPickerProps) {
  const batchUpdateStatus = useBatchUpdateStatus();
  const count = selectedIds.size;

  function handleStatusChange(status: DocumentStatus) {
    const documentIds = [...selectedIds];
    batchUpdateStatus.mutate(
      { documentIds, status },
      {
        onSuccess: () => {
          toast.success(
            `Updated ${count} ${count === 1 ? "item" : "items"} to ${DOCUMENT_STATUS_LABELS[status]}`
          );
          onComplete();
        },
      }
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          className="h-8 text-xs"
          disabled={batchUpdateStatus.isPending}
          size="sm"
          variant="outline"
        >
          <ArrowRightLeftIcon className="h-4 w-4" />
          Change Status
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center">
        {DOCUMENT_STATUS_OPTIONS.map((value) => (
          <DropdownMenuItem
            key={value}
            onClick={() => handleStatusChange(value)}
          >
            <StatusIcon size={16} status={DOCUMENT_STATUS_TO_ICON[value]} />
            {DOCUMENT_STATUS_LABELS[value]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
