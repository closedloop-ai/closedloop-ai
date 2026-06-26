"use client";

import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { getRowTypeConfig } from "@repo/app/documents/components/table/row-type-registry";
import { useDeleteBranch } from "@repo/app/documents/hooks/use-branch-view";
import { useDeleteDocument } from "@repo/app/documents/hooks/use-documents";
import { useCallback } from "react";

/**
 * Shared delete dispatch for table rows (FEA-1763 / PLN-874 Task 3.5).
 * The delete endpoint is type-scoped — `DELETE /branches/:id` for BRANCH
 * artifacts, the documents route for everything else — and this hook is the
 * one place that routing decision lives; pages pass the returned callback to
 * `DocumentsView`'s `onDelete` instead of re-implementing the dispatch.
 * Rows the registry marks non-deletable (sessions, projects) resolve false
 * without calling any endpoint.
 */
export function useDeleteRowItem(): (
  item: DocumentRowItem
) => Promise<boolean> {
  const deleteBranchMutation = useDeleteBranch();
  const deleteDocumentMutation = useDeleteDocument();
  const { mutateAsync: deleteBranch } = deleteBranchMutation;
  const { mutateAsync: deleteDocument } = deleteDocumentMutation;

  return useCallback(
    async (item: DocumentRowItem) => {
      if (getRowTypeConfig(item)?.deletable !== true) {
        return false;
      }
      const result =
        item.kind === "branch"
          ? await deleteBranch(item.data.id)
          : await deleteDocument(item.data.id);
      return result.deleted ?? false;
    },
    [deleteBranch, deleteDocument]
  );
}
