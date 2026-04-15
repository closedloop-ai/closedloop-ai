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
import type { FeatureWithWorkstream } from "@repo/api/src/types/feature";
import { FeatureStatus } from "@repo/api/src/types/feature";
import { isDisplayableSlug } from "@repo/api/src/types/slug";
import { Card } from "@repo/design-system/components/ui/card";
import { PriorityIcon } from "@repo/design-system/components/ui/priority-icon";
import { ScrollArea } from "@repo/design-system/components/ui/scroll-area";
import { StatusIcon } from "@repo/design-system/components/ui/status-icon";
import { cn } from "@repo/design-system/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { CheckSquareIcon } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AssigneeAvatar } from "@/components/assignee-avatar";
import { EmptyState } from "@/components/empty-state";
import { featureKeys, useUpdateFeature } from "@/hooks/queries/use-features";
import { FEATURE_STATUS_TO_ICON } from "@/lib/project-constants";
import { buildFeatureListParams, DISPLAY_GROUPS } from "../utils";

/** Map column (droppable) id to the status to set when a feature is dropped there */
const COLUMN_TO_STATUS: Record<string, FeatureStatus> = {
  draft: FeatureStatus.Draft,
  in_progress: FeatureStatus.InProgress,
  in_review: FeatureStatus.InReview,
  approved: FeatureStatus.Approved,
  executed: FeatureStatus.Executed,
  done: FeatureStatus.Done,
  obsolete: FeatureStatus.Obsolete,
};

type MyTasksKanbanProps = {
  assigneeId: string | null;
  features: FeatureWithWorkstream[];
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
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);
  const listFilters = useMemo(
    () => buildFeatureListParams(assigneeId),
    [assigneeId]
  );
  const updateFeatureMutation = useUpdateFeature();
  const lastDraggedFeatureIdRef = useRef<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const map = new Map<string, FeatureWithWorkstream[]>();
    for (const group of DISPLAY_GROUPS) {
      const items = features.filter((i: FeatureWithWorkstream) =>
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
      let newStatus: FeatureStatus | undefined = COLUMN_TO_STATUS[overId];
      if (!newStatus) {
        const targetFeature = features.find(
          (i: FeatureWithWorkstream) => i.id === overId
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
        (i: FeatureWithWorkstream) => i.id === featureId
      );
      if (!feature || feature.status === newStatus) {
        setActiveId(null);
        return;
      }
      queryClient.setQueryData(
        featureKeys.list(listFilters),
        (old: FeatureWithWorkstream[] | undefined) => {
          if (!old) {
            return old;
          }
          return old.map((i: FeatureWithWorkstream) =>
            i.id === featureId ? { ...i, status: newStatus } : i
          );
        }
      );
      setActiveId(null);
      updateFeatureMutation.mutate(
        { id: featureId, status: newStatus },
        {
          onError: () => {
            queryClient.invalidateQueries({ queryKey: featureKeys.lists() });
          },
        }
      );
    },
    [features, listFilters, queryClient, updateFeatureMutation]
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  const updateViewportHeight = useCallback(() => {
    const el = containerRef.current;
    if (!el) {
      return;
    }
    const top = el.getBoundingClientRect().top;
    // Keep a small bottom gap so the horizontal scrollbar remains visible.
    const next = Math.max(240, Math.floor(window.innerHeight - top - 12));
    setViewportHeight((prev) => (prev === next ? prev : next));
  }, []);

  useEffect(() => {
    updateViewportHeight();

    const onResize = () => {
      updateViewportHeight();
    };

    window.addEventListener("resize", onResize);

    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => updateViewportHeight())
        : null;

    if (observer && containerRef.current) {
      observer.observe(containerRef.current);
    }

    return () => {
      window.removeEventListener("resize", onResize);
      observer?.disconnect();
    };
  }, [updateViewportHeight]);

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
    ? features.find((i: FeatureWithWorkstream) => i.id === activeId)
    : null;

  return (
    <div className="flex h-full min-h-0 flex-col" ref={containerRef}>
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
                  lastDraggedFeatureIdRef={lastDraggedFeatureIdRef}
                  status={group.statuses[0]}
                />
              );
            })}
          </div>
        </ScrollArea>
        <DragOverlay>
          {activeFeature ? <KanbanCardPreview feature={activeFeature} /> : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

type KanbanColumnProps = {
  groupKey: string;
  groupLabel: string;
  items: FeatureWithWorkstream[];
  lastDraggedFeatureIdRef: React.MutableRefObject<string | null>;
  status: FeatureStatus;
};

function KanbanColumn({
  groupKey,
  groupLabel,
  items,
  lastDraggedFeatureIdRef,
  status,
}: Readonly<KanbanColumnProps>) {
  const { isOver, setNodeRef } = useDroppable({ id: groupKey });

  return (
    <div
      className="flex min-h-0 w-[270px] shrink-0 flex-col overflow-hidden rounded-md border bg-muted/30"
      ref={setNodeRef}
    >
      <div className="flex shrink-0 items-center gap-2 px-2.5 py-3">
        <StatusIcon size={16} status={FEATURE_STATUS_TO_ICON[status]} />
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
          {items.map((feature) => (
            <MyTasksCard
              feature={feature}
              key={feature.id}
              lastDraggedFeatureIdRef={lastDraggedFeatureIdRef}
            />
          ))}
        </div>
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
  feature: FeatureWithWorkstream;
}>) {
  return (
    <div className="px-3 py-1">
      <div className="min-w-0">
        <div className="flex min-w-0 flex-col gap-0.5">
          {isDisplayableSlug(feature.slug) && (
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
              {feature.slug}
            </span>
          )}
          <p className="min-w-0 truncate font-medium text-sm">
            {feature.title}
          </p>
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
              status={FEATURE_STATUS_TO_ICON[feature.status]}
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
}: Readonly<{ feature: FeatureWithWorkstream }>) {
  return (
    <Card className="cursor-grabbing rounded-md py-2 shadow-lg">
      <KanbanCardContent feature={feature} />
    </Card>
  );
}

type MyTasksCardProps = {
  feature: FeatureWithWorkstream;
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
      className={isDragging ? "invisible cursor-grabbing" : "cursor-grab"}
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
    >
      <Link href={`/features/${feature.slug}`} onClick={handleLinkClick}>
        <Card className="rounded-md py-2 shadow-none transition-colors hover:bg-accent/50">
          <KanbanCardContent disableAvatarLink feature={feature} />
        </Card>
      </Link>
    </div>
  );
}
