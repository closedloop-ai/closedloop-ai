"use client";

import type { DragEndEvent } from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import type { Artifact } from "@repo/api/src/types/artifact";
import { useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useState } from "react";
import { DndProvider } from "@/components/dnd/dnd-provider";
import { MoveRelatedConfirmationDialog } from "@/components/move-related-confirmation-dialog";
import {
  artifactKeys,
  useArtifact,
  useBatchMoveArtifacts,
  useReorderArtifacts,
} from "@/hooks/queries/use-artifacts";
import { useApiClient } from "@/hooks/use-api-client";

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

  const queryClient = useQueryClient();
  const apiClient = useApiClient();
  const batchMoveMutation = useBatchMoveArtifacts();
  const reorderArtifacts = useReorderArtifacts();

  // Fetch the dragged artifact data for dialog display
  const { data: draggedArtifact } = useArtifact(
    dialogState.artifactId ?? "",
    undefined,
    {
      enabled: !!dialogState.artifactId,
    }
  );

  // Fetch related artifact details for display
  const relatedArtifacts: Artifact[] = [];

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
        const relatedIds = await queryClient.fetchQuery({
          queryKey: artifactKeys.related(draggedArtifactId),
          queryFn: () =>
            apiClient.get<string[]>(`/artifacts/${draggedArtifactId}/related`),
        });

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

    const cachedRelatedIds =
      queryClient.getQueryData<string[]>(
        artifactKeys.related(dialogState.artifactId)
      ) ?? [];

    const artifactIds = moveAll
      ? [dialogState.artifactId, ...cachedRelatedIds]
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
