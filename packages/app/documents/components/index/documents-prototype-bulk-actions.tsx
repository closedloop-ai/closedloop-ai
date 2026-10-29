"use client";

import type { DocumentWithProject } from "@repo/api/src/types/document";
import { MoveEntityDialog } from "@repo/app/documents/components/move-entity-dialog";
import { DocumentsSelectionBar } from "@repo/app/documents/components/table/documents-selection-bar";
import { computeDeleteDialogCopy } from "@repo/app/documents/components/table/documents-view-helpers";
import { useDeleteRowItem } from "@repo/app/documents/hooks/use-delete-row-item";
import { runBulkDelete } from "@repo/app/documents/lib/table-row-actions";
import { DeleteConfirmationDialog } from "@repo/app/shared/components/delete-confirmation-dialog";
import type { User } from "@repo/design-system/components/ui/user-select-popover";
import { useState } from "react";

export function DocumentsPrototypeBulkActions({
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
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const performDelete = useDeleteRowItem();
  const selectedIds = documents.map((document) => document.id);
  const copy = computeDeleteDialogCopy({
    bulkCount: documents.length,
    deleteTarget: null,
    config: null,
  });

  async function confirmDelete() {
    setDeletePending(true);
    try {
      const success = await runBulkDelete(
        new Set(selectedIds),
        documents,
        performDelete
      );
      if (success) {
        setDeleteOpen(false);
        onClear();
      }
      return success;
    } finally {
      setDeletePending(false);
    }
  }

  return (
    <>
      <DocumentsSelectionBar
        announcesSelection={false}
        canBulkDelete={true}
        canBulkMove={false}
        canBulkMoveOnRail={true}
        canMerge={false}
        canUseDocumentActions={true}
        onBulkDelete={() => setDeleteOpen(true)}
        onBulkMove={() => setMoveOpen(true)}
        onClear={onClear}
        onMerge={onClear}
        onRetain={onRetain}
        selectedIds={selectedIds}
        selectedRows={documents}
        users={users}
      />
      <DeleteConfirmationDialog
        description={copy.description}
        isPending={deletePending}
        itemName={copy.itemName}
        onConfirm={confirmDelete}
        onOpenChange={setDeleteOpen}
        open={deleteOpen}
        title={copy.title}
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
