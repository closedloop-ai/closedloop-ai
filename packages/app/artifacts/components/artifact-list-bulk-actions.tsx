"use client";

import type { DocumentWithProject } from "@repo/api/src/types/document";
import { MoveEntityDialog } from "@repo/app/documents/components/move-entity-dialog";
import { useDocumentsBulkActionDescriptors } from "@repo/app/documents/components/table/documents-bulk-actions";
import { DocumentsBulkRail } from "@repo/app/documents/components/table/documents-bulk-rail";
import { useDeleteRowItem } from "@repo/app/documents/hooks/use-delete-row-item";
import { runBulkDelete } from "@repo/app/documents/lib/table-row-actions";
import { DeleteConfirmationDialog } from "@repo/app/shared/components/delete-confirmation-dialog";
import { ArtifactBulkActionBar } from "@repo/app/shared/components/generic-artifact-surface/bulk-action-bar";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { ARTIFACT_BULK_ACTION_BAR_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { TableBulkActionUndo } from "@repo/design-system/components/ui/table-bulk-actions";
import type { User } from "@repo/design-system/components/ui/user-select-popover";
import { TrashIcon } from "lucide-react";
import { useState } from "react";

/**
 * Document and Issue records share the production bulk mutation authority. The
 * Artifact List shell that hosts this owns the selection announcer
 * (ISS-12640: one polite selection status per surface).
 */
export function ArtifactListBulkActions({
  documents,
  onClear,
  onRetain,
  users,
}: {
  documents: DocumentWithProject[];
  onClear: () => void;
  onRetain: (ids: readonly string[]) => void;
  users?: readonly User[];
}) {
  return documents.length > 0 ? (
    <SelectedArtifactListBulkActions
      documents={documents}
      onClear={onClear}
      onRetain={onRetain}
      users={users}
    />
  ) : null;
}

function SelectedArtifactListBulkActions({
  documents,
  onClear,
  onRetain,
  users,
}: {
  documents: DocumentWithProject[];
  onClear: () => void;
  onRetain: (ids: readonly string[]) => void;
  users?: readonly User[];
}) {
  const railEnabled = useFeatureFlagEnabledOptional(
    ARTIFACT_BULK_ACTION_BAR_FEATURE_FLAG_KEY
  );
  const ids = documents.map((document) => document.id);
  const actions = useDocumentsBulkActionDescriptors(documents, ids);
  const deleteRow = useDeleteRowItem();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  return (
    <>
      {railEnabled && (
        <DocumentsBulkRail
          canBulkDelete={true}
          canBulkMove={true}
          canMerge={false}
          onBulkDelete={() => setDeleteOpen(true)}
          onBulkMove={() => setMoveOpen(true)}
          onClear={onClear}
          onMerge={onClear}
          onRetain={onRetain}
          selectedIds={ids}
          selectedRows={documents}
          users={users}
        />
      )}
      {!railEnabled && ids.length > 0 && (
        <ArtifactBulkActionBar
          actions={[
            ...actions,
            {
              id: "delete",
              kind: "command",
              label: "Delete",
              icon: <TrashIcon aria-hidden />,
              undo: TableBulkActionUndo.Unsupported,
              onSelect: () => setDeleteOpen(true),
            },
          ]}
          onClear={onClear}
          onRetainSelection={onRetain}
          rowIds={ids}
        />
      )}
      <DeleteConfirmationDialog
        isPending={deletePending}
        itemName={`${ids.length} items`}
        onConfirm={async () => {
          setDeletePending(true);
          try {
            const success = await runBulkDelete(
              new Set(ids),
              documents,
              deleteRow
            );
            if (success) {
              setDeleteOpen(false);
              onClear();
            }
            return success;
          } finally {
            setDeletePending(false);
          }
        }}
        onOpenChange={setDeleteOpen}
        open={deleteOpen}
        title="Delete"
      />
      {moveOpen && (
        <MoveEntityDialog
          entities={documents.map((document) => ({
            id: document.id,
            projectId: document.projectId,
          }))}
          onOpenChange={setMoveOpen}
          onSuccess={onClear}
          open={moveOpen}
        />
      )}
    </>
  );
}
