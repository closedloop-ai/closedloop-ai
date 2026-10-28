"use client";

import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  useDraggable,
  useDroppable,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import {
  type ArtifactStatus,
  type DocumentListPage,
  DocumentStatus,
  DocumentType,
  IssueStatus,
} from "@repo/api/src/types/document";
import { isDisplayableSlug } from "@repo/api/src/types/slug";
import { documentKeys } from "@repo/app/documents/hooks/document-keys";
import { useUpdateDocument } from "@repo/app/documents/hooks/use-documents";
import {
  type DocumentRowData,
  documentRowStatusEvidence,
} from "@repo/app/documents/lib/artifact-row-adapter";
import {
  getDocumentRoute,
  withOrgSlug,
} from "@repo/app/documents/lib/document-navigation";
import { DOCUMENT_TYPE_ICONS } from "@repo/app/projects/lib/project-constants";
import { AssigneeAvatar } from "@repo/app/shared/components/assignee-avatar";
import { useArtifactBoardPointerSensors } from "@repo/app/shared/components/generic-artifact-surface/artifact-board/artifact-board-dnd";
import { UNASSIGNED_ASSIGNEE_LABEL } from "@repo/app/shared/lib/user-utils";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import {
  KanbanBoardLayout,
  KanbanColumn,
} from "@repo/design-system/components/ui/layout/kanban-board";
import { Link } from "@repo/navigation/link";
import { type QueryKey, useQueryClient } from "@tanstack/react-query";
import { CheckSquareIcon, TerminalIcon } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useOrgSlug } from "@/hooks/use-org-slug";
import { useKanbanArtifactStatus } from "../hooks/use-kanban-artifact-status";
import {
  type KanbanStatusGroupPresentation,
  useKanbanBoardStatusPolicy,
} from "../hooks/use-kanban-board-status-policy";
import { DISPLAY_GROUPS } from "../utils";
import { KanbanArtifactCard } from "./kanban-artifact-card";
import {
  type KanbanPriorityLabel,
  useKanbanPriorityLabel,
} from "./use-kanban-priority-label";

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
      return isFeature ? IssueStatus.Backlog : DocumentStatus.Draft;
    case "todo":
      return isFeature ? IssueStatus.Todo : null;
    case "in_progress":
      return isFeature ? IssueStatus.InProgress : null;
    case "in_review":
      return isFeature ? IssueStatus.InReview : DocumentStatus.InReview;
    case "blocked":
      return isFeature ? IssueStatus.Blocked : DocumentStatus.ChangesRequested;
    case "approved":
      return isFeature ? null : DocumentStatus.Approved;
    case "executed":
      return isFeature ? null : DocumentStatus.Executed;
    case "done":
      // Documents have no "done"; their terminal sign-off is the dedicated
      // "approved" column. Returning Approved here would set the status then
      // re-render the card into the approved column (a visual teleport), so a
      // Document dropped on "done" is a no-op (PRD-495).
      return isFeature ? IssueStatus.Done : null;
    case "closed":
      return isFeature ? IssueStatus.Canceled : DocumentStatus.Obsolete;
    default:
      return null;
  }
}

type MyTasksKanbanProps = {
  artifacts: DocumentRowData[];
  assigneeId: string | null;
  isLoading: boolean;
  isUserLoading: boolean;
  /**
   * The RESOLVED cache key of the page read (ISS-4576) — produced by
   * `documentsPageQueryKey`, the same helper `useDocumentsPage` keys its query
   * with.
   *
   * The key is threaded in rather than rebuilt from params here because
   * `documentKeys.list` hashes its filters object verbatim: a key rebuilt from
   * the page's own params would omit the `includeTotal` flag the hook adds,
   * hash to a DIFFERENT entry, and make the optimistic write land somewhere
   * nothing is subscribed to — the drag would appear to do nothing until the
   * mutation's invalidation refetched.
   */
  pageQueryKey: QueryKey;
};

export function MyTasksKanban({
  artifacts,
  assigneeId,
  isLoading,
  isUserLoading,
  pageQueryKey,
}: Readonly<MyTasksKanbanProps>) {
  const queryClient = useQueryClient();
  const updateArtifactMutation = useUpdateDocument();
  const lastDraggedArtifactIdRef = useRef<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const { canMoveArtifactTo, groupKeyForArtifact, groups } =
    useKanbanBoardStatusPolicy(artifacts);

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
          columnKey = groupKeyForArtifact(targetArtifact);
        }
      }
      const newStatus = columnKey
        ? columnTargetStatus(columnKey, artifact.type)
        : null;
      if (
        !newStatus ||
        artifact.status === newStatus ||
        !canMoveArtifactTo(artifact, newStatus)
      ) {
        setActiveId(null);
        return;
      }
      const expectedStatus = documentRowStatusEvidence(artifact);
      if (expectedStatus === null || expectedStatus.trim().length === 0) {
        setActiveId(null);
        return;
      }
      // The board reads the paged envelope, so the optimistic write patches
      // `items` in place and leaves `total`/`hasMore` alone — a status change
      // moves a card between columns, it does not change how many tasks exist.
      queryClient.setQueryData(
        pageQueryKey,
        (old: DocumentListPage | undefined) => {
          if (!old) {
            return old;
          }
          return {
            ...old,
            items: old.items.map((i) =>
              i.id === artifactId
                ? {
                    ...i,
                    rawStatus: newStatus,
                    status: newStatus,
                  }
                : i
            ),
          };
        }
      );
      setActiveId(null);
      updateArtifactMutation.mutate(
        {
          expectedStatus,
          id: artifactId,
          status: newStatus,
          surface: ArtifactStatusEditSurface.Board,
        },
        {
          onError: () => {
            queryClient.invalidateQueries({ queryKey: documentKeys.lists() });
          },
        }
      );
    },
    [
      artifacts,
      canMoveArtifactTo,
      groupKeyForArtifact,
      pageQueryKey,
      queryClient,
      updateArtifactMutation,
    ]
  );

  // My Tasks keeps pointer-only drag semantics, while sharing the champion's
  // mouse/touch activation profile so narrow-screen scroll remains stable.
  const sensors = useArtifactBoardPointerSensors();

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

  // No local empty branch: the read is server-paged now, so "zero cards" can
  // mean an empty queue, a filter that excluded this page, or a page past the
  // end — three different facts one "No assigned tasks" state would flatten.
  // `MyTasksCardView` owns that decision because it holds the server total
  // (ISS-4576).

  const activeArtifact = activeId
    ? artifacts.find((i: DocumentRowData) => i.id === activeId)
    : null;

  // The board is sized by the flex column it lives in, NOT by a measured
  // viewport-bottom height. `MyTasksCardView` renders it above the pagination
  // footer, so a board pinned to the viewport bottom overflows its own sibling
  // and swallows the pager's clicks (ISS-4576). Growing into the space the
  // footer leaves is also what the list view already does.
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DndContext
        onDragEnd={handleDragEnd}
        onDragStart={handleDragStart}
        sensors={sensors}
      >
        {/* No min-height floor here, deliberately. A floor on this element is
            what the deleted hook's `minHeight: 240` was, and it is causally
            part of ISS-4576: the board cannot shrink past it, so once the
            column is tight it overflows this flex parent (which has no
            `overflow-hidden`) and repaints over the footer, intercepting the
            pager exactly as before. Verified by CI, not theory -- re-adding
            `min-h-60` reproduced the interception on run 30780191886. A floor
            belongs on a scroll container that owns the body AND the footer,
            never on a board that shares a column with one. */}
        <KanbanBoardLayout className="flex-1" stackBelow>
          {groups.map((group) => {
            return (
              <MyTasksKanbanColumn
                group={group}
                key={group.key}
                lastDraggedArtifactIdRef={lastDraggedArtifactIdRef}
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
  group: KanbanStatusGroupPresentation;
  lastDraggedArtifactIdRef: React.MutableRefObject<string | null>;
};

function MyTasksKanbanColumn({
  group,
  lastDraggedArtifactIdRef,
}: Readonly<KanbanColumnProps>) {
  const { isOver, setNodeRef } = useDroppable({ id: group.key });

  // Full-width when the board stacks below `sm` so a 360px screen shows one
  // readable column; the fixed 270px width returns side-by-side at `sm+`.
  return (
    <div className="w-full sm:w-auto" ref={setNodeRef}>
      <KanbanColumn
        className="w-full rounded-md bg-muted/30 shadow-none sm:w-[270px]"
        count={group.items.length}
        highlighted={isOver}
        icon={group.headerIcon}
        title={group.headerTitle}
      >
        <div className="flex flex-col gap-1.5">
          {group.items.map((artifact) => (
            <MyTasksCard
              artifact={artifact}
              key={artifact.id}
              laneStatuses={group.statuses}
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
  priorityChipLabel: KanbanPriorityLabel,
  statusContent: React.ReactNode,
  trailingStatusIcon: React.ReactNode,
  disableAvatarLink = false
): React.ComponentProps<typeof KanbanArtifactCard> {
  // Non-document artifact types (e.g. SESSION) have no DocumentType icon entry;
  // fall back to a generic icon so the card renders instead of crashing.
  const TypeIcon = DOCUMENT_TYPE_ICONS[artifact.type] ?? TerminalIcon;
  const showSlug = isDisplayableSlug(artifact.slug);

  return {
    assigneeLabel: artifact.assignee
      ? artifact.assignee.firstName
      : UNASSIGNED_ASSIGNEE_LABEL,
    icon: <TypeIcon className="size-4 shrink-0" />,
    kindLabel: artifact.type,
    priorityLabel: priorityChipLabel(artifact.priority),
    statusLabel: statusContent,
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
            icon (Documents and Features diverge on IN_REVIEW — PRD-495). The
            chip beside it resolves through the SAME per-type vocabulary
            (`useKanbanStatusLabel`), so the two cannot disagree about whether
            this build recognizes the status. */}
        {trailingStatusIcon}
      </div>
    ),
  };
}

/** Card for DragOverlay so the dragging item doesn't affect layout */
function KanbanCardPreview({
  artifact,
}: Readonly<{ artifact: DocumentRowData }>) {
  // The resolved label shape, not the gate's boolean — see the hook's own
  // docstring for why the read cannot live in this module.
  const priorityChipLabel = useKanbanPriorityLabel();
  const { statusContent, trailingStatusIcon } =
    useKanbanArtifactStatus(artifact);

  return (
    <KanbanArtifactCard
      {...getKanbanArtifactCardProps(
        artifact,
        priorityChipLabel,
        statusContent,
        trailingStatusIcon
      )}
      variant="drag-preview"
    />
  );
}

type MyTasksCardProps = {
  artifact: DocumentRowData;
  laneStatuses: readonly ArtifactStatus[];
  lastDraggedArtifactIdRef: React.MutableRefObject<string | null>;
};

function MyTasksCard({
  artifact,
  laneStatuses,
  lastDraggedArtifactIdRef,
}: Readonly<MyTasksCardProps>) {
  const orgSlug = useOrgSlug();
  const priorityChipLabel = useKanbanPriorityLabel();
  const { draggableOptions, statusContent, trailingStatusIcon } =
    useKanbanArtifactStatus(artifact, laneStatuses);
  const { attributes, isDragging, listeners, setNodeRef, transform } =
    useDraggable({ id: artifact.id, ...draggableOptions });
  const draggable = draggableOptions.disabled !== true;

  const style =
    !isDragging && transform
      ? { transform: CSS.Transform.toString(transform) }
      : undefined;
  let dragClassName = "cursor-default";
  if (isDragging) {
    dragClassName = "invisible cursor-grabbing";
  } else if (draggable) {
    dragClassName = "cursor-grab";
  }

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
      className={dragClassName}
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
    >
      <Link href={href} onClick={handleLinkClick}>
        <KanbanArtifactCard
          {...getKanbanArtifactCardProps(
            artifact,
            priorityChipLabel,
            statusContent,
            trailingStatusIcon,
            true
          )}
          variant="lane"
        />
      </Link>
    </div>
  );
}
