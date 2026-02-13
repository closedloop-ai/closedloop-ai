"use client";

import type { DragEndEvent } from "@dnd-kit/core";
import type { Artifact } from "@repo/api/src/types/artifact";
import type { ReactNode } from "react";
import { useState } from "react";
import { DndProvider } from "@/components/dnd/dnd-provider";
import { MoveRelatedConfirmationDialog } from "@/components/move-related-confirmation-dialog";
import {
  useArtifact,
  useBatchMoveArtifacts,
  useRelatedArtifacts,
} from "@/hooks/queries/use-artifacts";

type DragHandlerWrapperProps = {
  children: ReactNode;
};

export function DragHandlerWrapper({ children }: DragHandlerWrapperProps) {
  const [dialogState, setDialogState] = useState<{
    open: boolean;
    artifactId: string | null;
    targetProjectId: string | null;
  }>({
    open: false,
    artifactId: null,
    targetProjectId: null,
  });

  const batchMoveMutation = useBatchMoveArtifacts();

  // Fetch related artifacts only when dialog is triggered
  const { data: relatedIds = [], refetch: refetchRelated } =
    useRelatedArtifacts(dialogState.artifactId ?? "", { enabled: false });

  // Fetch the dragged artifact data for dialog display
  const { data: draggedArtifact } = useArtifact(dialogState.artifactId ?? "", {
    enabled: !!dialogState.artifactId,
  });

  // Fetch related artifact details for display
  const relatedArtifacts: Artifact[] = [];
  // Note: In a production implementation, you'd fetch these artifacts in parallel
  // For now, we'll rely on the artifact IDs for the move operation

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;

    if (!over) {
      return;
    }

    // Check if this is a cross-project move (dropping on a project in sidebar)
    // vs in-section reorder (dropping on another artifact row)
    // Project IDs are ULIDs starting with "01" and are used as droppable IDs
    // Artifact IDs are also ULIDs but will be within a sortable context
    const targetProjectId = over.id as string;
    const draggedArtifactId = active.id as string;

    // If the drop target looks like a project ID (from sidebar droppable)
    // we treat it as a cross-project move
    // This is detected by the droppable context - if it's a DroppableProjectItem
    // Check if we have related artifacts to show confirmation
    try {
      const { data: relatedIds } = await refetchRelated();

      if (relatedIds && relatedIds.length > 0) {
        // Show confirmation dialog
        setDialogState({
          open: true,
          artifactId: draggedArtifactId,
          targetProjectId,
        });
      } else {
        // No related artifacts, move immediately
        await batchMoveMutation.mutateAsync({
          artifactIds: [draggedArtifactId],
          targetProjectId,
        });
      }
    } catch {
      // If fetching related fails, move just the dragged artifact
      await batchMoveMutation.mutateAsync({
        artifactIds: [draggedArtifactId],
        targetProjectId,
      });
    }
  };

  const handleConfirmMove = async (moveAll: boolean) => {
    if (!(dialogState.artifactId && dialogState.targetProjectId)) {
      return;
    }

    const artifactIds = moveAll
      ? [dialogState.artifactId, ...relatedIds]
      : [dialogState.artifactId];

    await batchMoveMutation.mutateAsync({
      artifactIds,
      targetProjectId: dialogState.targetProjectId,
    });

    setDialogState({ open: false, artifactId: null, targetProjectId: null });
  };

  return (
    <>
      <DndProvider onDragEnd={handleDragEnd}>{children}</DndProvider>
      {draggedArtifact && (
        <MoveRelatedConfirmationDialog
          artifact={draggedArtifact}
          onConfirm={handleConfirmMove}
          onOpenChange={(open) => {
            if (!open) {
              setDialogState({
                open: false,
                artifactId: null,
                targetProjectId: null,
              });
            }
          }}
          open={dialogState.open}
          relatedArtifacts={relatedArtifacts}
        />
      )}
    </>
  );
}
