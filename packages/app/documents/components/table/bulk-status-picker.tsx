"use client";

import {
  type ArtifactStatus,
  DOCUMENT_STATUS_OPTIONS,
  FEATURE_STATUS_OPTIONS,
} from "@repo/api/src/types/document";
import { ArtifactStatusIcon } from "@repo/app/documents/components/artifact-status-icon";
import { useBatchUpdateStatus } from "@repo/app/documents/hooks/use-documents";
import { ARTIFACT_STATUS_LABELS } from "@repo/app/projects/lib/project-constants";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { toast } from "@repo/design-system/components/ui/sonner";
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

  // The selection can mix Documents and Features, which have disjoint status
  // vocabularies (PRD-495). Offer both (IN_REVIEW is shared — dedupe); the
  // server rejects the batch if the chosen status is invalid for any selected
  // artifact's subtype.
  const statusOptions = [
    ...new Set<ArtifactStatus>([
      ...DOCUMENT_STATUS_OPTIONS,
      ...FEATURE_STATUS_OPTIONS,
    ]),
  ];

  function handleStatusChange(status: ArtifactStatus) {
    const documentIds = [...selectedIds];
    batchUpdateStatus.mutate(
      { documentIds, status },
      {
        onSuccess: () => {
          toast.success(
            `Updated ${count} ${count === 1 ? "item" : "items"} to ${ARTIFACT_STATUS_LABELS[status]}`
          );
          onComplete();
        },
        onError: () => {
          toast.error(
            `Could not set ${count === 1 ? "the item" : "all items"} to ${ARTIFACT_STATUS_LABELS[status]} — that status isn't valid for every selected item.`
          );
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
        {statusOptions.map((value) => (
          <DropdownMenuItem
            key={value}
            onClick={() => handleStatusChange(value)}
          >
            <ArtifactStatusIcon size={16} status={value} />
            {ARTIFACT_STATUS_LABELS[value]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
