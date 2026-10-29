"use client";

import {
  ArtifactBulkAction,
  type ArtifactBulkAction as ArtifactBulkActionValue,
} from "@repo/api/src/types/artifact-bulk-action";
import type { ProjectWithDetails } from "@repo/api/src/types/project";
import type { DetailedArtifact } from "@repo/api/src/types/project-tree";
import { useBulkPriorityAction } from "@repo/app/documents/components/table/bulk-priority-picker";
import {
  statusUpdateErrorMessage,
  useBulkStatusAction,
} from "@repo/app/documents/components/table/bulk-status-picker";
import {
  DOCUMENTS_RAIL_DELETE_ACTION_ID,
  DOCUMENTS_RAIL_MERGE_ACTION_ID,
  documentsRailActions,
} from "@repo/app/documents/components/table/documents-bulk-rail";
import { computeDeleteDialogCopy } from "@repo/app/documents/components/table/documents-view-helpers";
import { MergeDocumentsDialog } from "@repo/app/documents/components/table/merge-documents-dialog";
import {
  bulkReceiptFromCommittedIds,
  invalidateForBulkArtifactMutation,
} from "@repo/app/documents/hooks/bulk-artifact-invalidation";
import {
  useBatchDeleteDocuments,
  useMergeDocuments,
} from "@repo/app/documents/hooks/use-documents";
import {
  type DocumentRowData,
  documentRowFromArtifact,
} from "@repo/app/documents/lib/artifact-row-adapter";
import { findMergeCandidates } from "@repo/app/documents/lib/table-row-actions";
import { useApiClientOptional } from "@repo/app/shared/api/use-api-client-optional";
import { useMixedBulkActionConfirmation } from "@repo/app/shared/bulk-actions/mixed-action-confirmation";
import {
  descriptorBulkExecutor,
  registeredArtifactDescriptors,
} from "@repo/app/shared/bulk-actions/registered-artifact-actions";
import {
  genericBulkKind,
  genericBulkPageKinds,
} from "@repo/app/shared/bulk-actions/row-kind";
import { useArtifactBulkActions } from "@repo/app/shared/bulk-actions/use-artifact-bulk-actions";
import { DeleteConfirmationDialog } from "@repo/app/shared/components/delete-confirmation-dialog";
import {
  ARTIFACT_NOUN,
  ArtifactBulkActionBar,
} from "@repo/app/shared/components/generic-artifact-surface/bulk-action-bar";
import type { GenericArtifact } from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import {
  ARTIFACT_BULK_ACTION_BAR_FEATURE_FLAG_KEY,
  ARTIFACT_PRIORITY_SURFACES_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { useBulkTagFamilyActions } from "@repo/app/tags/components/bulk-tag-action";
import {
  BULK_REMOVE_TAG_ACTION_ID,
  BULK_TAG_ACTION_ID,
} from "@repo/app/tags/lib/bulk-tag-labels";
import {
  type TableBulkActionDescriptor,
  TableBulkActionUndo,
} from "@repo/design-system/components/ui/table-bulk-actions";
import type { User } from "@repo/design-system/components/ui/user-select-popover";
import { useQueryClient } from "@tanstack/react-query";
import { FolderInputIcon } from "lucide-react";
import { useState } from "react";
import { ProjectSelectionActions } from "./project-artifact-selection-actions";
import { executeProjectSelectionPriority } from "./project-selection-priority";

/** The one gate for the portable and legacy project list action host. */
export function ProjectListSelectionActions(props: {
  artifactsById: ReadonlyMap<string, DetailedArtifact>;
  favoriteIds: ReadonlySet<string>;
  favoritesLoaded: boolean;
  moveEnabled: boolean;
  onClear: () => void;
  onFavorite: () => void;
  onMove: (projectId: string, rowIds?: readonly string[]) => Promise<unknown>;
  onRetain: (ids: readonly string[]) => void;
  project: ProjectWithDetails;
  projects: readonly ProjectWithDetails[];
  selectedIds: ReadonlySet<string>;
  selectedRows: readonly GenericArtifact[];
  users: readonly User[];
}) {
  const enabled = useFeatureFlagEnabledOptional(
    ARTIFACT_BULK_ACTION_BAR_FEATURE_FLAG_KEY
  );
  if (!enabled) {
    return (
      <ProjectSelectionActions
        moveEnabled={props.moveEnabled}
        onClear={props.onClear}
        onFavorite={props.onFavorite}
        onMove={props.onMove}
        projects={[...props.projects]}
        selectedIds={props.selectedIds}
      />
    );
  }
  return <ProjectRegisteredSelectionActions {...props} />;
}

/** Registry host for Project lists and the board's selected roots. */
export function ProjectRegisteredSelectionActions({
  artifactsById,
  project,
  favoriteIds,
  favoritesLoaded,
  onClear,
  onMove,
  onRetain,
  projects,
  selectedRows,
  users,
  moveEnabled = true,
}: {
  artifactsById: ReadonlyMap<string, DetailedArtifact>;
  project: DocumentRowData["project"];
  favoriteIds: ReadonlySet<string>;
  favoritesLoaded: boolean;
  onClear: () => void;
  onMove: (projectId: string, rowIds?: readonly string[]) => Promise<unknown>;
  onRetain: (ids: readonly string[]) => void;
  projects: readonly ProjectWithDetails[];
  selectedRows: readonly GenericArtifact[];
  users: readonly User[];
  moveEnabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const apiClient = useApiClientOptional();
  const priorityEnabled = useFeatureFlagEnabledOptional(
    ARTIFACT_PRIORITY_SURFACES_FEATURE_FLAG_KEY
  );
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteTargetIds, setDeleteTargetIds] = useState<readonly string[]>([]);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const { requestConfirmation, confirmationDialog } =
    useMixedBulkActionConfirmation();
  const deleteMutation = useBatchDeleteDocuments();
  const mergeMutation = useMergeDocuments();
  const ids = selectedRows.map((row) => row.id);
  const rows = selectedRows.flatMap((row) => {
    const kind = genericBulkKind(row.kind);
    return kind
      ? [{ id: row.id, kind, label: row.title || row.slug || row.id }]
      : [];
  });
  const documentRows = selectedRows.flatMap((row) => {
    const artifact = artifactsById.get(row.id);
    const document = artifact && documentRowFromArtifact(artifact, project);
    return document ? [document] : [];
  });
  const status = useBulkStatusAction(
    documentRows,
    documentRows.map((row) => row.id),
    { preservePageAction: true }
  );
  const statusApplicableIds = new Set(status?.applicableIds ?? []);
  const tagTargets = selectedRows.map((row) => ({
    artifactId: row.id,
    canApply: true,
    rowId: row.id,
  }));
  const tags = useBulkTagFamilyActions({
    addTargets: tagTargets,
    removeTargets: tagTargets,
    noun: ARTIFACT_NOUN,
  });
  const move: TableBulkActionDescriptor = {
    emptyLabel: "No matches",
    icon: <FolderInputIcon />,
    id: ArtifactBulkAction.ChangeProject,
    kind: "picker",
    label: "Move to project",
    options: projects.map((project) => ({
      id: project.id,
      label: project.name,
    })),
    undo: TableBulkActionUndo.NotImplemented,
    onSelect: async (rowIds, option) => {
      try {
        await onMove(option.id, rowIds);
        return true;
      } catch {
        return false;
      }
    },
  };
  const baseDocumentActions = documentsRailActions({
    canBulkDelete: true,
    canBulkMove: false,
    canMerge: findMergeCandidates(new Set(ids), documentRows) !== null,
    mutations: [],
    onBulkDelete: () => setDeleteOpen(true),
    onBulkMove: () => undefined,
    onMerge: () => setMergeOpen(true),
  });
  const baseDeleteAction = baseDocumentActions.find(
    (action) => action.id === DOCUMENTS_RAIL_DELETE_ACTION_ID
  );
  const deleteAction =
    baseDeleteAction?.kind === "command"
      ? {
          ...baseDeleteAction,
          onSelect: (rowIds: readonly string[]) => {
            setDeleteTargetIds(rowIds);
            setDeleteOpen(true);
          },
        }
      : undefined;
  const mergeAction = baseDocumentActions.find(
    (action) => action.id === DOCUMENTS_RAIL_MERGE_ACTION_ID
  );
  const priority = useBulkPriorityAction();
  const presentations: Partial<
    Record<ArtifactBulkActionValue, TableBulkActionDescriptor>
  > = {
    [ArtifactBulkAction.ChangeStatus]: status ?? undefined,
    [ArtifactBulkAction.ChangePriority]: priorityEnabled ? priority : undefined,
    [ArtifactBulkAction.AddTag]: tags.find(
      (action) => action.id === BULK_TAG_ACTION_ID
    ),
    [ArtifactBulkAction.RemoveTag]: tags.find(
      (action) => action.id === BULK_REMOVE_TAG_ACTION_ID
    ),
    [ArtifactBulkAction.ChangeProject]: moveEnabled ? move : undefined,
    [ArtifactBulkAction.Delete]: deleteAction,
  };
  const selection = { clear: onClear, retain: onRetain };
  const executors = Object.fromEntries(
    Object.entries(presentations).flatMap(([action, descriptor]) =>
      descriptor
        ? [[action, descriptorBulkExecutor(descriptor, selection)]]
        : []
    )
  );
  if (priorityEnabled && priority) {
    executors[ArtifactBulkAction.ChangePriority] = (applicableRows, value) => {
      if (!apiClient) {
        throw new Error("Bulk priority API is unavailable");
      }
      return executeProjectSelectionPriority(applicableRows, value, apiClient);
    };
  }
  if (status) {
    executors[ArtifactBulkAction.ChangeStatus] = async (
      applicableRows,
      value
    ) => {
      const option = status.options.find((candidate) => candidate.id === value);
      if (!option) {
        throw new RangeError("Status is not available for this selection");
      }
      try {
        const response = await status.executeForRegistry(
          applicableRows.map((row) => row.id),
          option.id
        );
        return {
          results: response.results,
          transactionIds: response.transactionId
            ? [response.transactionId]
            : [],
        };
      } catch (error) {
        return {
          results: [],
          transactionIds: [],
          failureMessage: statusUpdateErrorMessage(
            error,
            applicableRows.length,
            option.label
          ),
        };
      }
    };
  }
  const entries = useArtifactBulkActions({
    rows: rows.length === selectedRows.length ? rows : [],
    host: {
      executors,
      pageKinds: genericBulkPageKinds(),
      canApply: (action, row) =>
        action !== ArtifactBulkAction.ChangeStatus ||
        statusApplicableIds.has(row.id),
      canPerform: (action) =>
        action !== ArtifactBulkAction.ChangeFavorite || favoritesLoaded,
    },
    extras: mergeAction
      ? [
          {
            id: mergeAction.id,
            supportedIds: ids,
            execute: (value) =>
              descriptorBulkExecutor(mergeAction, selection)(rows, value),
          },
        ]
      : [],
  });
  const actions = registeredArtifactDescriptors({
    entries,
    presentations,
    extras: mergeAction ? [mergeAction] : [],
    favoriteIds,
    users,
    onCommitted: (committedIds) =>
      invalidateForBulkArtifactMutation(
        queryClient,
        bulkReceiptFromCommittedIds(committedIds)
      ),
    onMixedSelection: requestConfirmation,
  });
  if (ids.length === 0) {
    return null;
  }
  const mergeCandidates = findMergeCandidates(new Set(ids), documentRows);
  const deleteCopy = computeDeleteDialogCopy({
    bulkCount: deleteTargetIds.length,
    deleteTarget: null,
    config: null,
  });
  const confirmDelete = async () => {
    if (deleteTargetIds.length === 0) {
      return false;
    }
    const result = await deleteMutation.mutateAsync([...deleteTargetIds]);
    const failedIds = new Set(result.failedIds);
    const targetedIds = new Set(deleteTargetIds);
    const retainedIds = ids.filter(
      (id) => !targetedIds.has(id) || failedIds.has(id)
    );
    if (retainedIds.length > 0) {
      onRetain(retainedIds);
    } else {
      onClear();
    }
    return result.failedIds.length === 0;
  };
  return (
    <>
      <div data-preserve-artifact-selection="">
        <ArtifactBulkActionBar
          actions={actions}
          noun={ARTIFACT_NOUN}
          onClear={onClear}
          onRetainSelection={onRetain}
          rowIds={ids}
        />
      </div>
      {confirmationDialog}
      <DeleteConfirmationDialog
        description={deleteCopy.description}
        isPending={deleteMutation.isPending}
        itemName={deleteCopy.itemName}
        onConfirm={confirmDelete}
        onOpenChange={setDeleteOpen}
        open={deleteOpen}
        title={deleteCopy.title}
      />
      {mergeCandidates ? (
        <MergeDocumentsDialog
          artifacts={mergeCandidates}
          error={mergeError}
          isPending={mergeMutation.isPending}
          onConfirm={async (primaryDocumentId, secondaryDocumentId) => {
            setMergeError(null);
            try {
              await mergeMutation.mutateAsync({
                primaryDocumentId,
                secondaryDocumentId,
              });
              setMergeOpen(false);
              onClear();
            } catch (error) {
              setMergeError(
                error instanceof Error
                  ? error.message
                  : "Failed to merge artifacts"
              );
            }
          }}
          onOpenChange={setMergeOpen}
          open={mergeOpen}
        />
      ) : null}
    </>
  );
}
