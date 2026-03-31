"use client";

import type { DragEndEvent } from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import type { LinkedEntity } from "@repo/api/src/types/entity-link";
import {
  EntityType,
  LinkDirection,
  LinkQueryMode,
  LinkType,
} from "@repo/api/src/types/entity-link";
import { useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useState } from "react";
import { DndProvider } from "@/components/dnd/dnd-provider";
import { MoveDownstreamConfirmationDialog } from "@/components/move-downstream-confirmation-dialog";
import { useReorderArtifacts } from "@/hooks/queries/use-artifacts";
import {
  entityLinkKeys,
  useBatchMoveEntities,
} from "@/hooks/queries/use-entity-links";
import { useReorderProjects } from "@/hooks/queries/use-projects";
import { useApiClient } from "@/hooks/use-api-client";

type DragHandlerWrapperProps = {
  children: ReactNode;
};

export function DragHandlerWrapper({
  children,
}: Readonly<DragHandlerWrapperProps>) {
  const [dialogState, setDialogState] = useState<{
    open: boolean;
    artifactId: string | null;
    targetProjectId: string | null;
    downstreamEntities: LinkedEntity[];
  }>({
    open: false,
    artifactId: null,
    targetProjectId: null,
    downstreamEntities: [],
  });

  const queryClient = useQueryClient();
  const apiClient = useApiClient();
  const batchMoveMutation = useBatchMoveEntities();
  const reorderArtifacts = useReorderArtifacts();
  const reorderProjects = useReorderProjects();

  const fetchDownstream = (artifactId: string): Promise<LinkedEntity[]> => {
    const params = new URLSearchParams({
      entityId: artifactId,
      entityType: EntityType.Artifact,
      direction: LinkDirection.Target,
      linkType: LinkType.Produces,
      mode: LinkQueryMode.Tree,
    });
    return queryClient
      .fetchQuery({
        queryKey: entityLinkKeys.list({
          entityId: artifactId,
          entityType: EntityType.Artifact,
          direction: LinkDirection.Target,
          linkType: LinkType.Produces,
          mode: LinkQueryMode.Tree,
          resolved: true,
        }),
        queryFn: () =>
          apiClient.get<LinkedEntity[]>(
            `/entity-links/resolved?${params.toString()}`
          ),
      })
      .catch(() => [] as LinkedEntity[]);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;

    if (!over || active.id === over.id) {
      return;
    }

    // Cross-project move: dropping on a sidebar project droppable
    if (over.data.current?.type === "project") {
      const targetProjectId = over.data.current.projectId as string;
      const draggedArtifactId = active.id as string;

      const downstream = await fetchDownstream(draggedArtifactId);

      if (downstream.length > 0) {
        setDialogState({
          open: true,
          artifactId: draggedArtifactId,
          targetProjectId,
          downstreamEntities: downstream,
        });
      } else {
        batchMoveMutation.mutate({
          entityId: draggedArtifactId,
          entityType: EntityType.Artifact,
          targetProjectId,
          includeDownstream: false,
        });
      }
      return;
    }

    // Within-section reorder: dropping on another item in the same section
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

      if (activeSortable.containerId === "projects-list") {
        reorderProjects.mutate(newOrder);
      } else {
        reorderArtifacts.mutate(newOrder);
      }
    }
  };

  const handleConfirmMove = (moveAll: boolean) => {
    if (!(dialogState.artifactId && dialogState.targetProjectId)) {
      return;
    }

    batchMoveMutation.mutate(
      {
        entityId: dialogState.artifactId,
        entityType: EntityType.Artifact,
        targetProjectId: dialogState.targetProjectId,
        includeDownstream: moveAll,
      },
      {
        onSuccess: () => {
          setDialogState({
            open: false,
            artifactId: null,
            targetProjectId: null,
            downstreamEntities: [],
          });
        },
      }
    );
  };

  return (
    <>
      <DndProvider onDragEnd={handleDragEnd}>{children}</DndProvider>
      <MoveDownstreamConfirmationDialog
        downstreamEntities={dialogState.downstreamEntities}
        onConfirm={handleConfirmMove}
        onOpenChange={(open) => {
          if (!open) {
            setDialogState({
              open: false,
              artifactId: null,
              targetProjectId: null,
              downstreamEntities: [],
            });
          }
        }}
        open={dialogState.open}
      />
    </>
  );
}
