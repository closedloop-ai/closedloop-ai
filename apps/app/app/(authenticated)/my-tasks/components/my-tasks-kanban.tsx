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
import type { IssueWithWorkstream } from "@repo/api/src/types/issue";
import { IssueStatus } from "@repo/api/src/types/issue";
import { isDisplayableSlug } from "@repo/api/src/types/slug";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Card } from "@repo/design-system/components/ui/card";
import { PriorityIcon } from "@repo/design-system/components/ui/priority-icon";
import { StatusIcon } from "@repo/design-system/components/ui/status-icon";
import { useQueryClient } from "@tanstack/react-query";
import { BoxIcon, CheckSquareIcon } from "lucide-react";
import Link from "next/link";
import { useCallback, useMemo, useRef, useState } from "react";
import { AssigneeAvatar } from "@/components/assignee-avatar";
import { EmptyState } from "@/components/empty-state";
import {
  issueKeys,
  useIssues,
  useUpdateIssue,
} from "@/hooks/queries/use-issues";
import { ISSUE_STATUS_TO_ICON } from "@/lib/project-constants";
import type { MyTasksIssueFilters } from "../types";
import { buildIssueListParams, DISPLAY_GROUPS } from "../utils";

/** Map column (droppable) id to the status to set when an issue is dropped there */
const COLUMN_TO_STATUS: Record<string, IssueStatus> = {
  not_started: IssueStatus.NotStarted,
  in_progress: IssueStatus.InProgress,
  in_review: IssueStatus.InReview,
  completed: IssueStatus.Completed,
  obsolete: IssueStatus.Obsolete,
};

type MyTasksKanbanProps = {
  assigneeId: string | null;
  isUserLoading: boolean;
  issueFilters?: MyTasksIssueFilters;
};

export function MyTasksKanban({
  assigneeId,
  isUserLoading,
  issueFilters,
}: Readonly<MyTasksKanbanProps>) {
  const queryClient = useQueryClient();
  const listFilters = useMemo(
    () => buildIssueListParams(assigneeId, issueFilters),
    [assigneeId, issueFilters]
  );
  const { data: issues = [], isLoading } = useIssues(listFilters, {
    enabled: !!assigneeId && !isUserLoading,
  });
  const updateIssueMutation = useUpdateIssue();
  const lastDraggedIssueIdRef = useRef<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const map = new Map<string, IssueWithWorkstream[]>();
    for (const group of DISPLAY_GROUPS) {
      const items = issues.filter((i) => group.statuses.includes(i.status));
      map.set(group.key, items);
    }
    return map;
  }, [issues]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    lastDraggedIssueIdRef.current = String(event.active.id);
    setActiveId(String(event.active.id));
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      setTimeout(() => {
        lastDraggedIssueIdRef.current = null;
      }, 250);

      if (!over || active.id === over.id) {
        setActiveId(null);
        return;
      }
      const overId = String(over.id);
      let newStatus: IssueStatus | undefined = COLUMN_TO_STATUS[overId];
      if (!newStatus) {
        const targetIssue = issues.find((i) => i.id === overId);
        if (targetIssue) {
          newStatus = targetIssue.status;
        }
      }
      if (!newStatus) {
        setActiveId(null);
        return;
      }
      const issueId = String(active.id);
      const issue = issues.find((i) => i.id === issueId);
      if (!issue || issue.status === newStatus) {
        setActiveId(null);
        return;
      }
      queryClient.setQueryData(
        issueKeys.list(listFilters),
        (old: IssueWithWorkstream[] | undefined) => {
          if (!old) {
            return old;
          }
          return old.map((i) =>
            i.id === issueId ? { ...i, status: newStatus } : i
          );
        }
      );
      setActiveId(null);
      updateIssueMutation.mutate(
        { id: issueId, status: newStatus },
        {
          onError: () => {
            queryClient.invalidateQueries({ queryKey: issueKeys.lists() });
          },
        }
      );
    },
    [issues, listFilters, queryClient, updateIssueMutation]
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

  if (issues.length === 0) {
    return (
      <EmptyState
        description="Tasks assigned to you will appear here."
        icon={CheckSquareIcon}
        title="No assigned tasks"
      />
    );
  }

  const activeIssue = activeId ? issues.find((i) => i.id === activeId) : null;

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
              lastDraggedIssueIdRef={lastDraggedIssueIdRef}
            />
          );
        })}
      </div>
      <DragOverlay>
        {activeIssue ? <KanbanCardPreview issue={activeIssue} /> : null}
      </DragOverlay>
    </DndContext>
  );
}

type KanbanColumnProps = {
  groupKey: string;
  groupLabel: string;
  items: IssueWithWorkstream[];
  lastDraggedIssueIdRef: React.MutableRefObject<string | null>;
};

function KanbanColumn({
  groupKey,
  groupLabel,
  items,
  lastDraggedIssueIdRef,
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
        {items.map((issue) => (
          <MyTasksCard
            issue={issue}
            key={issue.id}
            lastDraggedIssueIdRef={lastDraggedIssueIdRef}
          />
        ))}
      </div>
    </div>
  );
}

/** Card content only - used in DragOverlay so the dragging item doesn't affect layout */
function KanbanCardPreview({
  issue,
}: Readonly<{ issue: IssueWithWorkstream }>) {
  const workstreamOrProject =
    issue.workstream?.title ?? issue.project?.name ?? null;

  return (
    <Card className="cursor-grabbing py-3 shadow-lg">
      <div className="px-3 py-1">
        <div className="flex min-w-0 items-start gap-2">
          <BoxIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-baseline gap-1.5">
              {isDisplayableSlug(issue.slug) && (
                <span className="shrink-0 font-mono text-muted-foreground text-xs">
                  {issue.slug}
                </span>
              )}
              <p className="min-w-0 truncate font-medium text-sm">
                {issue.title}
              </p>
            </div>
          </div>
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <div className="min-w-0 shrink-0">
            {workstreamOrProject ? (
              <Badge
                className="rounded-md border-border px-2 py-1 font-normal text-muted-foreground"
                variant="outline"
              >
                {workstreamOrProject}
              </Badge>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <div className="flex size-6 shrink-0 items-center justify-center">
              <PriorityIcon priority={issue.priority} size={14} />
            </div>
            <div className="flex size-6 shrink-0 items-center justify-center">
              <AssigneeAvatar
                assignee={issue.assignee}
                className="size-4 shrink-0"
              />
            </div>
            <div className="flex size-6 shrink-0 items-center justify-center">
              <StatusIcon
                size={16}
                status={ISSUE_STATUS_TO_ICON[issue.status]}
              />
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}

type MyTasksCardProps = {
  issue: IssueWithWorkstream;
  lastDraggedIssueIdRef: React.MutableRefObject<string | null>;
};

function MyTasksCard({
  issue,
  lastDraggedIssueIdRef,
}: Readonly<MyTasksCardProps>) {
  const workstreamOrProject =
    issue.workstream?.title ?? issue.project?.name ?? null;

  const { attributes, isDragging, listeners, setNodeRef, transform } =
    useDraggable({ id: issue.id });

  const style =
    !isDragging && transform
      ? { transform: CSS.Transform.toString(transform) }
      : undefined;

  const handleLinkClick = useCallback(
    (e: React.MouseEvent) => {
      if (lastDraggedIssueIdRef.current === issue.id) {
        e.preventDefault();
        lastDraggedIssueIdRef.current = null;
      }
    },
    [issue.id, lastDraggedIssueIdRef]
  );

  return (
    <div
      className={`touch-none ${isDragging ? "invisible cursor-grabbing" : "cursor-grab"}`}
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
    >
      <Link href={`/issues/${issue.slug}`} onClick={handleLinkClick}>
        <Card className="py-3 transition-colors hover:bg-accent/50">
          <div className="px-3 py-1">
            <div className="flex min-w-0 items-start gap-2">
              <BoxIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-baseline gap-1.5">
                  {isDisplayableSlug(issue.slug) && (
                    <span className="shrink-0 font-mono text-muted-foreground text-xs">
                      {issue.slug}
                    </span>
                  )}
                  <p className="min-w-0 truncate font-medium text-sm">
                    {issue.title}
                  </p>
                </div>
              </div>
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-2">
              <div className="min-w-0 shrink-0">
                {workstreamOrProject ? (
                  <Badge
                    className="rounded-md border-border px-2 py-1 font-normal text-muted-foreground"
                    variant="outline"
                  >
                    {workstreamOrProject}
                  </Badge>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <div className="flex size-6 shrink-0 items-center justify-center">
                  <PriorityIcon priority={issue.priority} size={14} />
                </div>
                <div className="flex size-6 shrink-0 items-center justify-center">
                  <AssigneeAvatar
                    assignee={issue.assignee}
                    className="size-4 shrink-0"
                    disableLink
                  />
                </div>
                <div className="flex size-6 shrink-0 items-center justify-center">
                  <StatusIcon
                    size={16}
                    status={ISSUE_STATUS_TO_ICON[issue.status]}
                  />
                </div>
              </div>
            </div>
          </div>
        </Card>
      </Link>
    </div>
  );
}
