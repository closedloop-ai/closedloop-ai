"use client";

import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import {
  DocumentStatus,
  type DocumentWithWorkstream,
} from "@repo/api/src/types/document";
import { isDisplayableSlug } from "@repo/api/src/types/slug";
import { Card } from "@repo/design-system/components/ui/card";
import { PriorityIcon } from "@repo/design-system/components/ui/priority-icon";
import { ScrollArea } from "@repo/design-system/components/ui/scroll-area";
import { StatusIcon } from "@repo/design-system/components/ui/status-icon";
import { cn } from "@repo/design-system/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { CheckSquareIcon } from "lucide-react";
import Link from "next/link";
import { useCallback, useMemo, useRef, useState } from "react";
import { AssigneeAvatar } from "@/components/assignee-avatar";
import { EmptyState } from "@/components/empty-state";
import { documentKeys, useUpdateDocument } from "@/hooks/queries/use-documents";
import { useElementViewportHeight } from "@/hooks/use-element-viewport-height";
import { getDocumentRoute } from "@/lib/document-navigation";
import {
  DOCUMENT_STATUS_TO_ICON,
  DOCUMENT_TYPE_ICONS,
} from "@/lib/project-constants";
import { buildArtifactListParams, DISPLAY_GROUPS } from "../utils";

/** Map column (droppable) id to the status to set when an artifact is dropped there */
const COLUMN_TO_STATUS: Record<string, DocumentStatus> = {
  draft: DocumentStatus.Draft,
  in_progress: DocumentStatus.InProgress,
  in_review: DocumentStatus.InReview,
  approved: DocumentStatus.Approved,
  executed: DocumentStatus.Executed,
  done: DocumentStatus.Done,
  obsolete: DocumentStatus.Obsolete,
};

type MyTasksKanbanProps = {
  artifacts: DocumentWithWorkstream[];
  assigneeId: string | null;
  isLoading: boolean;
  isUserLoading: boolean;
};

export function MyTasksKanban({
  artifacts,
  assigneeId,
  isLoading,
  isUserLoading,
}: Readonly<MyTasksKanbanProps>) {
  const queryClient = useQueryClient();
  const [viewportHeight, setContainerRef] = useElementViewportHeight({
    bottomGap: 12,
    minHeight: 240,
  });
  const listFilters = useMemo(
    () => buildArtifactListParams(assigneeId),
    [assigneeId]
  );
  const updateArtifactMutation = useUpdateDocument();
  const lastDraggedArtifactIdRef = useRef<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const map = new Map<string, DocumentWithWorkstream[]>();
    for (const group of DISPLAY_GROUPS) {
      const items = artifacts.filter((i: DocumentWithWorkstream) =>
        group.statuses.includes(i.status)
      );
      map.set(group.key, items);
    }
    return map;
  }, [artifacts]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    lastDraggedArtifactIdRef.current = String(event.active.id);
    setActiveId(String(event.active.id));
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      setTimeout(() => {
        lastDraggedArtifactIdRef.current = null;
      }, 250);

      if (!over || active.id === over.id) {
        setActiveId(null);
        return;
      }
      const overId = String(over.id);
      let newStatus: DocumentStatus | undefined = COLUMN_TO_STATUS[overId];
      if (!newStatus) {
        const targetArtifact = artifacts.find(
          (i: DocumentWithWorkstream) => i.id === overId
        );
        if (targetArtifact) {
          newStatus = targetArtifact.status;
        }
      }
      if (!newStatus) {
        setActiveId(null);
        return;
      }
      const artifactId = String(active.id);
      const artifact = artifacts.find(
        (i: DocumentWithWorkstream) => i.id === artifactId
      );
      if (!artifact || artifact.status === newStatus) {
        setActiveId(null);
        return;
      }
      queryClient.setQueryData(
        documentKeys.list(listFilters),
        (old: DocumentWithWorkstream[] | undefined) => {
          if (!old) {
            return old;
          }
          return old.map((i: DocumentWithWorkstream) =>
            i.id === artifactId ? { ...i, status: newStatus } : i
          );
        }
      );
      setActiveId(null);
      updateArtifactMutation.mutate(
        { id: artifactId, status: newStatus },
        {
          onError: () => {
            queryClient.invalidateQueries({ queryKey: documentKeys.lists() });
          },
        }
      );
    },
    [artifacts, listFilters, queryClient, updateArtifactMutation]
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  if (isUserLoading || (assigneeId && isLoading)) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-muted-foreground">
        Loading...
      </div>
    );
  }

  if (!assigneeId) {
    return (
      <EmptyState
        description="Sign in to see your assigned tasks."
        icon={CheckSquareIcon}
        title="My Tasks"
      />
    );
  }

  if (artifacts.length === 0) {
    return (
      <EmptyState
        description="Tasks assigned to you will appear here."
        icon={CheckSquareIcon}
        title="No assigned tasks"
      />
    );
  }

  const activeArtifact = activeId
    ? artifacts.find((i: DocumentWithWorkstream) => i.id === activeId)
    : null;

  return (
    <div className="flex h-full min-h-0 flex-col" ref={setContainerRef}>
      <DndContext
        onDragEnd={handleDragEnd}
        onDragStart={handleDragStart}
        sensors={sensors}
      >
        <ScrollArea
          className="min-h-0 shrink-0"
          scrollbars="horizontal"
          style={viewportHeight ? { height: viewportHeight } : undefined}
          type="always"
        >
          <div
            className="flex min-w-max gap-3 px-4 pb-4"
            style={viewportHeight ? { height: viewportHeight } : undefined}
          >
            {DISPLAY_GROUPS.map((group) => {
              const items = grouped.get(group.key) ?? [];
              return (
                <KanbanColumn
                  groupKey={group.key}
                  groupLabel={group.label}
                  items={items}
                  key={group.key}
                  lastDraggedArtifactIdRef={lastDraggedArtifactIdRef}
                  status={group.statuses[0]}
                />
              );
            })}
          </div>
        </ScrollArea>
        <DragOverlay>
          {activeArtifact ? (
            <KanbanCardPreview artifact={activeArtifact} />
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

type KanbanColumnProps = {
  groupKey: string;
  groupLabel: string;
  items: DocumentWithWorkstream[];
  lastDraggedArtifactIdRef: React.MutableRefObject<string | null>;
  status: DocumentStatus;
};

function KanbanColumn({
  groupKey,
  groupLabel,
  items,
  lastDraggedArtifactIdRef,
  status,
}: Readonly<KanbanColumnProps>) {
  const { isOver, setNodeRef } = useDroppable({ id: groupKey });

  return (
    <div
      className="flex min-h-0 w-[270px] shrink-0 flex-col overflow-hidden rounded-md border bg-muted/30"
      ref={setNodeRef}
    >
      <div className="flex shrink-0 items-center gap-2 px-2.5 py-3">
        <StatusIcon size={16} status={DOCUMENT_STATUS_TO_ICON[status]} />
        <span className="font-medium text-base">{groupLabel}</span>
        <span className="text-muted-foreground text-sm">{items.length}</span>
      </div>
      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto",
          isOver && "bg-accent/30"
        )}
      >
        <div className="flex flex-col gap-1.5 p-1.5">
          {items.map((artifact) => (
            <MyTasksCard
              artifact={artifact}
              key={artifact.id}
              lastDraggedArtifactIdRef={lastDraggedArtifactIdRef}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Shared card body for kanban cards and overlay preview */
function KanbanCardContent({
  artifact,
  disableAvatarLink = false,
}: Readonly<{
  artifact: DocumentWithWorkstream;
  disableAvatarLink?: boolean;
}>) {
  const TypeIcon = DOCUMENT_TYPE_ICONS[artifact.type];
  const showSlug = isDisplayableSlug(artifact.slug);

  return (
    <div className="px-3 py-1">
      <div className="min-w-0">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex min-w-0 shrink-0 items-center gap-1 text-muted-foreground">
            <TypeIcon className="size-3 shrink-0" />
            {showSlug && (
              <span className="truncate font-mono text-[11px]">
                {artifact.slug}
              </span>
            )}
          </div>
          <p className="min-w-0 truncate font-medium text-sm">
            {artifact.title}
          </p>
        </div>
      </div>
      <div className="mt-1.5 flex items-center justify-end gap-2">
        <div className="flex shrink-0 items-center gap-1">
          <div className="flex size-6 shrink-0 items-center justify-center">
            <PriorityIcon priority={artifact.priority} size={14} />
          </div>
          <div className="flex size-6 shrink-0 items-center justify-center">
            <AssigneeAvatar
              assignee={artifact.assignee}
              className="size-4 shrink-0"
              disableLink={disableAvatarLink}
            />
          </div>
          <div className="flex size-6 shrink-0 items-center justify-center">
            <StatusIcon
              size={16}
              status={DOCUMENT_STATUS_TO_ICON[artifact.status]}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Card for DragOverlay so the dragging item doesn't affect layout */
function KanbanCardPreview({
  artifact,
}: Readonly<{ artifact: DocumentWithWorkstream }>) {
  return (
    <Card className="cursor-grabbing rounded-md py-2 shadow-lg">
      <KanbanCardContent artifact={artifact} />
    </Card>
  );
}

type MyTasksCardProps = {
  artifact: DocumentWithWorkstream;
  lastDraggedArtifactIdRef: React.MutableRefObject<string | null>;
};

function MyTasksCard({
  artifact,
  lastDraggedArtifactIdRef,
}: Readonly<MyTasksCardProps>) {
  const { attributes, isDragging, listeners, setNodeRef, transform } =
    useDraggable({ id: artifact.id });

  const style =
    !isDragging && transform
      ? { transform: CSS.Transform.toString(transform) }
      : undefined;

  const handleLinkClick = useCallback(
    (e: React.MouseEvent) => {
      if (lastDraggedArtifactIdRef.current === artifact.id) {
        e.preventDefault();
        lastDraggedArtifactIdRef.current = null;
      }
    },
    [artifact.id, lastDraggedArtifactIdRef]
  );

  const href = getDocumentRoute(artifact) ?? "#";

  return (
    <div
      className={isDragging ? "invisible cursor-grabbing" : "cursor-grab"}
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
    >
      <Link href={href} onClick={handleLinkClick}>
        <Card className="rounded-md py-2 shadow-none transition-colors hover:bg-accent/50">
          <KanbanCardContent artifact={artifact} disableAvatarLink />
        </Card>
      </Link>
    </div>
  );
}
