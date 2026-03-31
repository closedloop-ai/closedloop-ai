"use client";

import type { DragEndEvent } from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import { EntityType } from "@repo/api/src/types/entity-link";
import type { ReactNode } from "react";
import { DndProvider } from "@/components/dnd/dnd-provider";
import { useReorderArtifacts } from "@/hooks/queries/use-artifacts";
import { useBatchMoveEntities } from "@/hooks/queries/use-entity-links";
import { useReorderProjects } from "@/hooks/queries/use-projects";

type DragHandlerWrapperProps = {
  children: ReactNode;
};

export function DragHandlerWrapper({
  children,
}: Readonly<DragHandlerWrapperProps>) {
  const batchMoveMutation = useBatchMoveEntities();
  const reorderArtifacts = useReorderArtifacts();
  const reorderProjects = useReorderProjects();

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (!over || active.id === over.id) {
      return;
    }

    // Cross-project move: dropping on a sidebar project droppable
    if (over.data.current?.type === "project") {
      const targetProjectId = over.data.current.projectId as string;
      const draggedArtifactId = active.id as string;
      batchMoveMutation.mutate({
        entityId: draggedArtifactId,
        entityType: EntityType.Artifact,
        targetProjectId,
        includeDownstream: true,
      });
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

  return <DndProvider onDragEnd={handleDragEnd}>{children}</DndProvider>;
}
