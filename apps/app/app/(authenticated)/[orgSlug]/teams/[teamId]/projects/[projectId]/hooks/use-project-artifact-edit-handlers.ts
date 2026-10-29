"use client";

import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import type { RowEditHandlers } from "@repo/app/documents/components/table/row-edit-context";
import { useUpdateDocument } from "@repo/app/documents/hooks/use-documents";
import { useMemo } from "react";

/** Canonical document-field writers shared by Project list and board layouts. */
export function useProjectArtifactEditHandlers(
  teamMembers: RowEditHandlers["teamMembers"]
): RowEditHandlers {
  const updateDocument = useUpdateDocument();
  return useMemo(
    () => ({
      onUpdateAssignee: (itemId, assigneeId) => {
        updateDocument.mutate({ assigneeId, id: itemId });
      },
      onUpdateDueDate: () => undefined,
      onUpdatePriority: (itemId, priority) => {
        updateDocument.mutate({
          id: itemId,
          priority,
          surface: ArtifactStatusEditSurface.InlineCell,
        });
      },
      onUpdateStatus: (itemId, status) => {
        updateDocument.mutate({
          id: itemId,
          status,
          surface: ArtifactStatusEditSurface.InlineCell,
        });
      },
      onUpdateTitle: (itemId, title, expectedTitle) =>
        updateDocument.mutateAsync({ expectedTitle, id: itemId, title }),
      surfaceVariant: "team",
      teamMembers,
    }),
    [teamMembers, updateDocument]
  );
}
