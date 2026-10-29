"use client";

import {
  type ArtifactStatusCapability,
  ArtifactStatusEditSurface,
} from "@repo/api/src/types/artifact-status-contract";
import {
  BATCH_ITEM_FAILURE_MESSAGE,
  type BatchMutationResponse,
} from "@repo/api/src/types/batch-mutation-result";
import {
  type ArtifactStatus,
  DOCUMENT_STATUS_OPTIONS,
  DocumentType,
  ISSUE_STATUS_OPTIONS,
} from "@repo/api/src/types/document";
import {
  DocumentStatusMutationErrorCode,
  DocumentStatusMutationOperation,
} from "@repo/api/src/types/document-status-mutation";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import { ArtifactStatusIcon } from "@repo/app/documents/components/artifact-status-icon";
import { useBatchUpdateStatus } from "@repo/app/documents/hooks/use-documents";
import {
  type DocumentRowData,
  documentRowStatusEvidence,
} from "@repo/app/documents/lib/artifact-row-adapter";
import { documentArtifactStatusCapability } from "@repo/app/documents/lib/artifact-status-capability";
import { ARTIFACT_STATUS_LABELS } from "@repo/app/projects/lib/project-constants";
import { ApiError } from "@repo/app/shared/api/api-error";
import { batchMutationSelectionOutcome } from "@repo/app/shared/bulk-actions/batch-mutation-selection";
import { BULK_SELECTION_CHANGED_MESSAGE } from "@repo/app/shared/bulk-actions/bulk-selection-copy";
import { ArtifactStatus as UniversalArtifactStatus } from "@repo/app/shared/components/artifact-status/artifact-status";
import { artifactStatusLabel } from "@repo/app/shared/components/artifact-status/artifact-status-presentation";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { documentStatusFacet } from "@repo/app/shared/lib/artifact-status-adapter";
import { ArtifactStatusVariant } from "@repo/app/shared/lib/artifact-status-view-contract";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { toast } from "@repo/design-system/components/ui/sonner";
import type {
  TableBulkActionOption,
  TableBulkPickerDescriptor,
  TableBulkSelectionControls,
} from "@repo/design-system/components/ui/table-bulk-actions";
import { TableBulkActionUndo } from "@repo/design-system/components/ui/table-bulk-actions";
import { ArrowRightLeftIcon } from "lucide-react";

/**
 * Setting a status on the selection, as a bulk-action descriptor (ISS-8942).
 * This used to be a component wired straight into the project table's selection
 * bar — beside the rail's contract rather than inside it.
 *
 * It carries its own `render` because that bar is not the Sessions rail: its
 * controls are outline buttons on a light surface and this one opens a menu.
 * The chrome is all that is local — the options and the handler under it are
 * the descriptor's own, so the rail would render the identical action.
 */
export function useBulkStatusAction(
  selectedRows: readonly DocumentRowData[],
  selectedRowIds: readonly string[],
  config?: { preservePageAction?: boolean }
):
  | (TableBulkPickerDescriptor & {
      id: typeof BULK_STATUS_ACTION_ID;
      applicableIds: readonly string[];
      executeForRegistry: (
        rowIds: readonly string[],
        statusId: string
      ) => Promise<BatchMutationResponse>;
    })
  | null {
  const batchUpdateStatus = useBatchUpdateStatus(
    config?.preservePageAction ? { suppressDefaultErrorToast: true } : undefined
  );
  const champion = useFeatureFlagEnabledOptional(
    UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY
  );
  const capabilities = champion
    ? selectedRows.map(resolveBulkStatusCapability)
    : [];
  const applicableRows = selectedRows.filter(
    (_row, index) => !champion || capabilities[index]?.editable
  );
  const applicableIds = applicableRows.map((row) => row.id);
  const applicableCapabilities = capabilities.filter(
    (capability) => capability.editable
  );
  // A mixed selection can include Branch/Session IDs. Never offer a Document
  // mutation that would silently act on only the subset found in selectedRows.
  const selectionEditable = config?.preservePageAction
    ? true
    : !champion ||
      (selectedRows.length === selectedRowIds.length &&
        capabilities.every((capability) => capability.editable));

  // The selection can mix Documents and Features, which have disjoint status
  // vocabularies (PRD-495). Offer both (IN_REVIEW is shared — dedupe); the
  // server rejects the batch if the chosen status is invalid for any selected
  // artifact's subtype.
  const allStatuses = [
    ...new Set<ArtifactStatus>([
      ...DOCUMENT_STATUS_OPTIONS,
      ...ISSUE_STATUS_OPTIONS,
    ]),
  ];
  const statuses = champion
    ? allowedBulkStatuses(applicableRows, applicableCapabilities, allStatuses)
    : allStatuses;
  const options: readonly TableBulkActionOption[] = statuses.map((status) => {
    if (champion) {
      const facet = documentStatusFacet(
        ISSUE_STATUSES.has(status) ? DocumentType.Feature : DocumentType.Prd,
        status
      );
      const label = artifactStatusLabel(facet);
      return {
        content: (
          <UniversalArtifactStatus
            facet={facet}
            variant={ArtifactStatusVariant.BulkOption}
          />
        ),
        id: status,
        label,
      };
    }
    return {
      content: (
        <>
          <ArtifactStatusIcon size={16} status={status} />
          {ARTIFACT_STATUS_LABELS[status]}
        </>
      ),
      id: status,
      label: ARTIFACT_STATUS_LABELS[status],
    };
  });
  const statusById = new Map(
    statuses.map((status) => [String(status), status])
  );

  const executeForRegistry = (
    rowIds: readonly string[],
    statusId: string
  ): Promise<BatchMutationResponse> => {
    const status = statusById.get(statusId);
    if (!status) {
      throw new RangeError("Status is not available for this selection");
    }
    return batchUpdateStatus.mutateAsync({
      documentIds: [...rowIds],
      status,
      surface: ArtifactStatusEditSurface.Bulk,
    });
  };

  function select(
    rowIds: readonly string[],
    option: TableBulkActionOption,
    selection: TableBulkSelectionControls
  ): Promise<boolean> | boolean {
    if (!selectionEditable) {
      return false;
    }
    const status = statusById.get(option.id);
    if (!status) {
      return false;
    }
    const count = rowIds.length;
    return new Promise<boolean>((resolve) => {
      batchUpdateStatus.mutate(
        {
          documentIds: [...rowIds],
          status,
          surface: ArtifactStatusEditSurface.Bulk,
        },
        {
          onSuccess: (response: BatchMutationResponse) => {
            const outcome = batchMutationSelectionOutcome(
              response.results,
              rowIds
            );
            if (outcome.failureCode) {
              selection.retain(outcome.failedIds);
              toast.error(BATCH_ITEM_FAILURE_MESSAGE[outcome.failureCode]);
              resolve(false);
              return;
            }
            toast.success(
              `Updated ${count} ${count === 1 ? "item" : "items"} to ${option.label}`
            );
            selection.clear();
            resolve(true);
          },
          onError: (error) => {
            toast.error(statusUpdateErrorMessage(error, count, option.label));
            resolve(false);
          },
        }
      );
    });
  }

  if (!(selectionEditable && statuses.length > 0)) {
    return null;
  }

  return {
    applicableIds,
    executeForRegistry,
    emptyLabel: "No statuses available",
    icon: <ArrowRightLeftIcon className="h-4 w-4" />,
    id: BULK_STATUS_ACTION_ID,
    isPending: batchUpdateStatus.isPending,
    kind: "picker",
    // ISS-10161: bulk status is non-destructive and so IS undoable under the
    // 2026-09-16 ruling — the undo is simply not built yet. Declared as the gap
    // it is rather than sharing a value with a destructive action.
    undo: TableBulkActionUndo.NotImplemented,
    label: BULK_STATUS_ACTION_LABEL,
    onSelect: select,
    options,
    render: ({ selectOption }) => (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            className="h-8 text-xs"
            disabled={batchUpdateStatus.isPending}
            size="sm"
            variant="outline"
          >
            <ArrowRightLeftIcon className="h-4 w-4" />
            {BULK_STATUS_ACTION_LABEL}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center">
          {options.map((option) => (
            <DropdownMenuItem
              key={option.id}
              onClick={async () => {
                await selectOption(option);
              }}
            >
              {option.content}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    ),
  };
}

function resolveBulkStatusCapability(
  row: DocumentRowData
): ArtifactStatusCapability {
  return documentArtifactStatusCapability({
    documentType: row.type,
    operation: DocumentStatusMutationOperation.Bulk,
    rawStatus: documentRowStatusEvidence(row),
    statusMutation: row.statusMutation,
  });
}

function allowedBulkStatuses(
  rows: readonly DocumentRowData[],
  capabilities: readonly ArtifactStatusCapability[],
  allStatuses: readonly ArtifactStatus[]
): ArtifactStatus[] {
  if (rows.every((row) => row.statusMutation === undefined)) {
    return [...allStatuses];
  }
  return allStatuses.filter((status) =>
    capabilities.every(
      (capability) =>
        capability.editable && capability.allowedTargets.includes(status)
    )
  );
}

export const BULK_STATUS_ACTION_ID = "bulk-status";
const BULK_STATUS_ACTION_LABEL = "Change Status";

export function statusUpdateErrorMessage(
  error: unknown,
  count: number,
  statusLabel: string
): string {
  if (
    error instanceof ApiError &&
    error.code === DocumentStatusMutationErrorCode.StaleStatus
  ) {
    return count === 1
      ? "Could not update the item because the selection changed. Refresh and try again."
      : BULK_SELECTION_CHANGED_MESSAGE;
  }

  return `Could not set ${count === 1 ? "the item" : "all items"} to ${statusLabel} — that status isn't valid for every selected item.`;
}

const ISSUE_STATUSES = new Set<string>(ISSUE_STATUS_OPTIONS);
