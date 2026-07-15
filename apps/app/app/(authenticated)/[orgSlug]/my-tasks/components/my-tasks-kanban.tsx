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
  type ArtifactStatus,
  DocumentStatus,
  DocumentType,
  FeatureStatus,
} from "@repo/api/src/types/document";
import { isDisplayableSlug } from "@repo/api/src/types/slug";
import { ArtifactStatusIcon } from "@repo/app/documents/components/artifact-status-icon";
import { DocumentStatusIcon } from "@repo/app/documents/components/document-status-icon";
import { FeatureStatusIcon } from "@repo/app/documents/components/feature-status-icon";
import { documentKeys } from "@repo/app/documents/hooks/document-keys";
import { useUpdateDocument } from "@repo/app/documents/hooks/use-documents";
import type { DocumentRowData } from "@repo/app/documents/lib/artifact-row-adapter";
import {
  getDocumentRoute,
  withOrgSlug,
} from "@repo/app/documents/lib/document-navigation";
import { DOCUMENT_TYPE_ICONS } from "@repo/app/projects/lib/project-constants";
import { AssigneeAvatar } from "@repo/app/shared/components/assignee-avatar";
import { useElementViewportHeight } from "@repo/app/shared/hooks/use-element-viewport-height";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import {
  KanbanBoardLayout,
  KanbanColumn,
} from "@repo/design-system/components/ui/layout/kanban-board";
import { Link } from "@repo/navigation/link";
import { useQueryClient } from "@tanstack/react-query";
import { CheckSquareIcon, TerminalIcon } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useOrgSlug } from "@/hooks/use-org-slug";
import { buildArtifactListParams, DISPLAY_GROUPS } from "../utils";
import { KanbanArtifactCard } from "./kanban-artifact-card";

/**
 * Resolve the status to set when an artifact is dropped on a column. The board
 * mixes Documents and Features with disjoint vocabularies (PRD-495), so the
 * target depends on the dragged artifact's type. Returns null when a column has
 * no valid target for that type (e.g. a Document dropped on "To Do"); the drop
 * is then a no-op.
 */
function columnTargetStatus(
  columnKey: string,
  artifactType: DocumentRowData["type"]
): ArtifactStatus | null {
  const isFeature = artifactType === DocumentType.Feature;
  switch (columnKey) {
    case "backlog":
      return isFeature ? FeatureStatus.Backlog : DocumentStatus.Draft;
    case "todo":
      return isFeature ? FeatureStatus.Todo : null;
    case "in_progress":
      return isFeature ? FeatureStatus.InProgress : null;
    case "in_review":
      return isFeature ? FeatureStatus.InReview : DocumentStatus.InReview;
    case "blocked":
      return isFeature
        ? FeatureStatus.Blocked
        : DocumentStatus.ChangesRequested;
    case "approved":
      return isFeature ? null : DocumentStatus.Approved;
    case "executed":
      return isFeature ? null : DocumentStatus.Executed;
    case "done":
      // Documents have no "done"; their terminal sign-off is the dedicated
      // "approved" column. Returning Approved here would set the status then
      // re-render the card into the approved column (a visual teleport), so a
      // Document dropped on "done" is a no-op (PRD-495).
      return isFeature ? FeatureStatus.Done : null;
    case "closed":
      return isFeature ? FeatureStatus.Canceled : DocumentStatus.Obsolete;
    default:
      return null;
  }
}

type MyTasksKanbanProps = {
  artifacts: DocumentRowData[];
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
    const map = new Map<string, DocumentRowData[]>();
    for (const group of DISPLAY_GROUPS) {
      const items = artifacts.filter((i: DocumentRowData) =>
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
      const artifactId = String(active.id);
      const artifact = artifacts.find(
        (i: DocumentRowData) => i.id === artifactId
      );
      if (!artifact) {
        setActiveId(null);
        return;
      }
      // `over` is either a column droppable id or another artifact's id. Resolve
      // it to a column, then pick the target status for THIS artifact's type
      // (Documents and Features have disjoint vocabularies — PRD-495).
      const overId = String(over.id);
      let columnKey: string | undefined = DISPLAY_GROUPS.find(
        (g) => g.key === overId
      )?.key;
      if (!columnKey) {
        const targetArtifact = artifacts.find(
          (i: DocumentRowData) => i.id === overId
        );
        if (targetArtifact) {
          columnKey = DISPLAY_GROUPS.find((g) =>
            g.statuses.includes(targetArtifact.status)
          )?.key;
        }
      }
      const newStatus = columnKey
        ? columnTargetStatus(columnKey, artifact.type)
        : null;
      if (!newStatus || artifact.status === newStatus) {
        setActiveId(null);
        return;
      }
      queryClient.setQueryData(
        documentKeys.list(listFilters),
        (old: DocumentRowData[] | undefined) => {
          if (!old) {
            return old;
          }
          return old.map((i: DocumentRowData) =>
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
    ? artifacts.find((i: DocumentRowData) => i.id === activeId)
    : null;

  return (
    <div className="flex h-full min-h-0 flex-col" ref={setContainerRef}>
      <DndContext
        onDragEnd={handleDragEnd}
        onDragStart={handleDragStart}
        sensors={sensors}
      >
        <KanbanBoardLayout
          style={viewportHeight ? { height: viewportHeight } : undefined}
        >
          {DISPLAY_GROUPS.map((group) => {
            const items = grouped.get(group.key) ?? [];
            return (
              <MyTasksKanbanColumn
                groupKey={group.key}
                groupLabel={group.label}
                items={items}
                key={group.key}
                lastDraggedArtifactIdRef={lastDraggedArtifactIdRef}
                status={group.statuses[0]}
              />
            );
          })}
        </KanbanBoardLayout>
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
  items: DocumentRowData[];
  lastDraggedArtifactIdRef: React.MutableRefObject<string | null>;
  status: ArtifactStatus;
};

function MyTasksKanbanColumn({
  groupKey,
  groupLabel,
  items,
  lastDraggedArtifactIdRef,
  status,
}: Readonly<KanbanColumnProps>) {
  const { isOver, setNodeRef } = useDroppable({ id: groupKey });

  return (
    <div ref={setNodeRef}>
      <KanbanColumn
        className="w-[270px] rounded-md bg-muted/30 shadow-none"
        count={items.length}
        highlighted={isOver}
        icon={<ArtifactStatusIcon size={16} status={status} />}
        title={groupLabel}
      >
        <div className="flex flex-col gap-1.5">
          {items.map((artifact) => (
            <MyTasksCard
              artifact={artifact}
              key={artifact.id}
              lastDraggedArtifactIdRef={lastDraggedArtifactIdRef}
            />
          ))}
        </div>
      </KanbanColumn>
    </div>
  );
}

function getKanbanArtifactCardProps(
  artifact: DocumentRowData,
  disableAvatarLink = false
): React.ComponentProps<typeof KanbanArtifactCard> {
  // Non-document artifact types (e.g. SESSION) have no DocumentType icon entry;
  // fall back to a generic icon so the card renders instead of crashing.
  const TypeIcon = DOCUMENT_TYPE_ICONS[artifact.type] ?? TerminalIcon;
  const showSlug = isDisplayableSlug(artifact.slug);

  return {
    assigneeLabel: artifact.assignee
      ? artifact.assignee.firstName
      : "Unassigned",
    icon: <TypeIcon className="size-4 shrink-0" />,
    kindLabel: artifact.type,
    priorityLabel: artifact.priority,
    statusLabel: artifact.status,
    subtitle: showSlug ? artifact.slug : undefined,
    title: artifact.title,
    updatedLabel: (
      <div className="flex items-center justify-end gap-1">
        <AssigneeAvatar
          assignee={artifact.assignee}
          className="size-4 shrink-0"
          disableLink={disableAvatarLink}
          disableTooltip
        />
        {/* The card knows its artifact type, so render the exact vocabulary's
            icon (Documents and Features diverge on IN_REVIEW — PRD-495). */}
        {artifact.type === DocumentType.Feature ? (
          <FeatureStatusIcon
            size={16}
            status={artifact.status as FeatureStatus}
          />
        ) : (
          <DocumentStatusIcon
            size={16}
            status={artifact.status as DocumentStatus}
          />
        )}
      </div>
    ),
  };
}

/** Card for DragOverlay so the dragging item doesn't affect layout */
function KanbanCardPreview({
  artifact,
}: Readonly<{ artifact: DocumentRowData }>) {
  return (
    <KanbanArtifactCard
      {...getKanbanArtifactCardProps(artifact)}
      variant="drag-preview"
    />
  );
}

type MyTasksCardProps = {
  artifact: DocumentRowData;
  lastDraggedArtifactIdRef: React.MutableRefObject<string | null>;
};

function MyTasksCard({
  artifact,
  lastDraggedArtifactIdRef,
}: Readonly<MyTasksCardProps>) {
  const orgSlug = useOrgSlug();
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

  const href = withOrgSlug(orgSlug, getDocumentRoute(artifact)) ?? "#";

  return (
    <div
      className={isDragging ? "invisible cursor-grabbing" : "cursor-grab"}
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
    >
      <Link href={href} onClick={handleLinkClick}>
        <KanbanArtifactCard
          {...getKanbanArtifactCardProps(artifact, true)}
          variant="lane"
        />
      </Link>
    </div>
  );
}
