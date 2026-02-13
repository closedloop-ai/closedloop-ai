"use client";

import type { DragEndEvent } from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import type { Artifact } from "@repo/api/src/types/artifact";
import type { ReactNode } from "react";
import { useState } from "react";
import { DndProvider } from "@/components/dnd/dnd-provider";
import { MoveRelatedConfirmationDialog } from "@/components/move-related-confirmation-dialog";
import {
  useArtifact,
  useBatchMoveArtifacts,
  useRelatedArtifacts,
  useReorderArtifacts,
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
  const reorderArtifacts = useReorderArtifacts();

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

    if (!over || active.id === over.id) {
      return;
    }

    // Cross-project move: dropping on a sidebar project droppable
    if (over.data.current?.type === "project") {
      const targetProjectId = over.data.current.projectId as string;
      const draggedArtifactId = active.id as string;

      try {
        const { data: relatedIds } = await refetchRelated();

        if (relatedIds && relatedIds.length > 0) {
          setDialogState({
            open: true,
            artifactId: draggedArtifactId,
            targetProjectId,
          });
        } else {
          await batchMoveMutation.mutateAsync({
            artifactIds: [draggedArtifactId],
            targetProjectId,
          });
        }
      } catch {
        await batchMoveMutation.mutateAsync({
          artifactIds: [draggedArtifactId],
          targetProjectId,
        });
      }
      return;
    }

    // Within-section reorder: dropping on another artifact in the same section
    const activeSortable = active.data.current?.sortable;
    const overSortable = over.data.current?.sortable;
    if (
      activeSortable &&
      overSortable &&
      activeSortable.containerId === overSortable.containerId
    ) {
      const newOrder = arrayMove(
        activeSortable.items as string[],
        activeSortable.index,
        overSortable.index
      );
      reorderArtifacts.mutate(newOrder);
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
