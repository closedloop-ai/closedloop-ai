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
import { StatusIcon } from "@repo/design-system/components/ui/status-icon";
import { useQueryClient } from "@tanstack/react-query";
import { BoxIcon, CheckSquareIcon } from "lucide-react";
import Link from "next/link";
import { useCallback, useMemo, useRef, useState } from "react";
import { AssigneeAvatar } from "@/components/assignee-avatar";
import { EmptyState } from "@/components/empty-state";
import { documentKeys, useUpdateDocument } from "@/hooks/queries/use-documents";
import { DOCUMENT_STATUS_TO_ICON } from "@/lib/project-constants";
import { buildFeatureListParams, DISPLAY_GROUPS } from "../utils";

/** Map column (droppable) id to the status to set when a feature is dropped there */
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
  assigneeId: string | null;
  features: DocumentWithWorkstream[];
  isLoading: boolean;
  isUserLoading: boolean;
};

export function MyTasksKanban({
  assigneeId,
  features,
  isLoading,
  isUserLoading,
}: Readonly<MyTasksKanbanProps>) {
  const queryClient = useQueryClient();
  const listFilters = useMemo(
    () => buildFeatureListParams(assigneeId),
    [assigneeId]
  );
  const updateFeatureMutation = useUpdateDocument();
  const lastDraggedFeatureIdRef = useRef<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const map = new Map<string, DocumentWithWorkstream[]>();
    for (const group of DISPLAY_GROUPS) {
      const items = features.filter((i: DocumentWithWorkstream) =>
        group.statuses.includes(i.status)
      );
      map.set(group.key, items);
    }
    return map;
  }, [features]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    lastDraggedFeatureIdRef.current = String(event.active.id);
    setActiveId(String(event.active.id));
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      setTimeout(() => {
        lastDraggedFeatureIdRef.current = null;
      }, 250);

      if (!over || active.id === over.id) {
        setActiveId(null);
        return;
      }
      const overId = String(over.id);
      let newStatus: DocumentStatus | undefined = COLUMN_TO_STATUS[overId];
      if (!newStatus) {
        const targetFeature = features.find(
          (i: DocumentWithWorkstream) => i.id === overId
        );
        if (targetFeature) {
          newStatus = targetFeature.status;
        }
      }
      if (!newStatus) {
        setActiveId(null);
        return;
      }
      const featureId = String(active.id);
      const feature = features.find(
        (i: DocumentWithWorkstream) => i.id === featureId
      );
      if (!feature || feature.status === newStatus) {
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
            i.id === featureId ? { ...i, status: newStatus } : i
          );
        }
      );
      setActiveId(null);
      updateFeatureMutation.mutate(
        { id: featureId, status: newStatus },
        {
          onError: () => {
            queryClient.invalidateQueries({ queryKey: documentKeys.lists() });
          },
        }
      );
    },
    [features, listFilters, queryClient, updateFeatureMutation]
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

  if (features.length === 0) {
    return (
      <EmptyState
        description="Tasks assigned to you will appear here."
        icon={CheckSquareIcon}
        title="No assigned tasks"
      />
    );
  }

  const activeFeature = activeId
    ? features.find((i: DocumentWithWorkstream) => i.id === activeId)
    : null;

  return (
    <DndContext
      onDragEnd={handleDragEnd}
      onDragStart={handleDragStart}
      sensors={sensors}
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-5">
        {DISPLAY_GROUPS.map((group) => {
          const items = grouped.get(group.key) ?? [];
          return (
            <KanbanColumn
              groupKey={group.key}
              groupLabel={group.label}
              items={items}
              key={group.key}
              lastDraggedFeatureIdRef={lastDraggedFeatureIdRef}
            />
          );
        })}
      </div>
      <DragOverlay>
        {activeFeature ? <KanbanCardPreview feature={activeFeature} /> : null}
      </DragOverlay>
    </DndContext>
  );
}

type KanbanColumnProps = {
  groupKey: string;
  groupLabel: string;
  items: DocumentWithWorkstream[];
  lastDraggedFeatureIdRef: React.MutableRefObject<string | null>;
};

function KanbanColumn({
  groupKey,
  groupLabel,
  items,
  lastDraggedFeatureIdRef,
}: Readonly<KanbanColumnProps>) {
  const { isOver, setNodeRef } = useDroppable({ id: groupKey });

  return (
    <div
      className="flex flex-col rounded-lg border bg-muted/30"
      ref={setNodeRef}
    >
      <div className="border-b px-2.5 py-1.5">
        <span className="font-medium text-sm">{groupLabel}</span>
        <span className="ml-1.5 text-muted-foreground text-sm">
          {items.length}
        </span>
      </div>
      <div
        className={`flex flex-col gap-1.5 p-1.5 ${isOver ? "bg-accent/30" : ""}`}
      >
        {items.map((feature) => (
          <MyTasksCard
            feature={feature}
            key={feature.id}
            lastDraggedFeatureIdRef={lastDraggedFeatureIdRef}
          />
        ))}
      </div>
    </div>
  );
}

/** Shared card body for kanban cards and overlay preview */
function KanbanCardContent({
  disableAvatarLink = false,
  feature,
}: Readonly<{
  disableAvatarLink?: boolean;
  feature: DocumentWithWorkstream;
}>) {
  return (
    <div className="px-3 py-1">
      <div className="flex min-w-0 items-start gap-2">
        <BoxIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-1.5">
            {isDisplayableSlug(feature.slug) && (
              <span className="shrink-0 font-mono text-muted-foreground text-xs">
                {feature.slug}
              </span>
            )}
            <p className="min-w-0 truncate font-medium text-sm">
              {feature.title}
            </p>
          </div>
        </div>
      </div>
      <div className="mt-1.5 flex items-center justify-end gap-2">
        <div className="flex shrink-0 items-center gap-1">
          <div className="flex size-6 shrink-0 items-center justify-center">
            <PriorityIcon priority={feature.priority} size={14} />
          </div>
          <div className="flex size-6 shrink-0 items-center justify-center">
            <AssigneeAvatar
              assignee={feature.assignee}
              className="size-4 shrink-0"
              disableLink={disableAvatarLink}
            />
          </div>
          <div className="flex size-6 shrink-0 items-center justify-center">
            <StatusIcon
              size={16}
              status={DOCUMENT_STATUS_TO_ICON[feature.status]}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Card for DragOverlay so the dragging item doesn't affect layout */
function KanbanCardPreview({
  feature,
}: Readonly<{ feature: DocumentWithWorkstream }>) {
  return (
    <Card className="cursor-grabbing py-3 shadow-lg">
      <KanbanCardContent feature={feature} />
    </Card>
  );
}

type MyTasksCardProps = {
  feature: DocumentWithWorkstream;
  lastDraggedFeatureIdRef: React.MutableRefObject<string | null>;
};

function MyTasksCard({
  feature,
  lastDraggedFeatureIdRef,
}: Readonly<MyTasksCardProps>) {
  const { attributes, isDragging, listeners, setNodeRef, transform } =
    useDraggable({ id: feature.id });

  const style =
    !isDragging && transform
      ? { transform: CSS.Transform.toString(transform) }
      : undefined;

  const handleLinkClick = useCallback(
    (e: React.MouseEvent) => {
      if (lastDraggedFeatureIdRef.current === feature.id) {
        e.preventDefault();
        lastDraggedFeatureIdRef.current = null;
      }
    },
    [feature.id, lastDraggedFeatureIdRef]
  );

  return (
    <div
      className={`touch-none ${isDragging ? "invisible cursor-grabbing" : "cursor-grab"}`}
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
    >
      <Link href={`/features/${feature.slug}`} onClick={handleLinkClick}>
        <Card className="py-3 transition-colors hover:bg-accent/50">
          <KanbanCardContent disableAvatarLink feature={feature} />
        </Card>
      </Link>
    </div>
  );
}
