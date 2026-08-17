"use client";

import type { ScheduledTask } from "@repo/crewd/model";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@repo/design-system/components/ui/alert-dialog";
import { Button } from "@repo/design-system/components/ui/button";
import { Chip } from "@repo/design-system/components/ui/chip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import {
  GridEmptyValue,
  GridTable,
  type GridTableColumn,
  ROW_ACTIONS_COLUMN,
  ROW_ACTIONS_COLUMN_ID,
} from "@repo/design-system/components/ui/grid-table";
import { Switch } from "@repo/design-system/components/ui/switch";
import {
  HistoryIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlayIcon,
  Trash2Icon,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { formatRelativeTimeOrFallback } from "../../shared/lib/date-utils";
import {
  scheduleLabel,
  taskLastStatusChip,
  taskRouteBadge,
} from "../lib/scheduled-task-row";

/**
 * The Routines list (PRD-566 / FEA-4348; formerly "Scheduled Tasks", FEA-3852),
 * shared across surfaces through `@repo/app/routines`. One row per routine: name
 * (lead), a plain-English schedule, next run, last run, last-run status, a live
 * Enabled toggle, and a row overflow menu (Run now / Edit / History / Delete).
 * Minimal chrome, no dashboard. Every action is a callback the view wires to the
 * data source; Delete is confirmed through an AlertDialog so a single click can
 * never drop a routine. The row datum is still a crewd `ScheduledTask` (the
 * persisted model is preserved unchanged).
 */

const LEAD_WIDTH = "minmax(220px, 1fr)";

const COLUMN_SPECS: readonly (GridTableColumn & { width: string })[] = [
  { id: "schedule", label: "Schedule", width: "minmax(180px, 0.9fr)" },
  { id: "nextRun", label: "Next run", width: "130px" },
  { id: "lastRun", label: "Last run", width: "130px" },
  { id: "status", label: "Status", width: "130px" },
  { id: "enabled", label: "Enabled", width: "88px" },
  { ...ROW_ACTIONS_COLUMN, width: "56px" },
];

export type RoutinesTableProps = {
  tasks: ScheduledTask[];
  /** Open the run-history drawer for a task (the cascade trail lives there). */
  onOpenHistory: (task: ScheduledTask) => void;
  /** Open the edit modal for a task. */
  onEdit: (task: ScheduledTask) => void;
  /** Fire a task once, off-schedule. */
  onRunNow: (task: ScheduledTask) => void;
  /** Flip a task's enabled flag. */
  onToggle: (task: ScheduledTask, enabled: boolean) => void;
  /** Delete a task (confirmed by this component before it fires). */
  onDelete: (task: ScheduledTask) => void;
};

export function RoutinesTable({
  tasks,
  onOpenHistory,
  onEdit,
  onRunNow,
  onToggle,
  onDelete,
}: RoutinesTableProps) {
  const [pendingDelete, setPendingDelete] = useState<ScheduledTask | null>(
    null
  );

  const columns: GridTableColumn[] = COLUMN_SPECS.map(
    ({ width, ...column }) => column
  );
  const gridTemplateColumns = [
    LEAD_WIDTH,
    ...COLUMN_SPECS.map((spec) => spec.width),
  ].join(" ");

  return (
    <>
      <GridTable
        columns={columns}
        getRowId={(task) => task.id}
        gridTemplateColumns={gridTemplateColumns}
        items={tasks}
        leadingLabel="Routine"
        renderCell={(columnId, task) =>
          renderTaskCell(columnId, task, {
            onOpenHistory,
            onEdit,
            onRunNow,
            onToggle,
            onDelete: setPendingDelete,
          })
        }
        renderLead={(task) => renderTaskLead(task)}
      />
      <AlertDialog
        onOpenChange={(open) => {
          if (!open) {
            setPendingDelete(null);
          }
        }}
        open={pendingDelete !== null}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {pendingDelete?.name ?? "this routine"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This removes the routine and its run history. This cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingDelete) {
                  onDelete(pendingDelete);
                }
                setPendingDelete(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function renderTaskLead(task: ScheduledTask): ReactNode {
  const routeChip = taskRouteBadge(task);
  return (
    <span className="flex min-w-0 flex-col">
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate font-medium text-sm">{task.name}</span>
        {routeChip ? (
          <Chip className="shrink-0" variant={routeChip.variant}>
            {routeChip.label}
          </Chip>
        ) : null}
      </span>
      {task.crew ? (
        <span className="truncate text-muted-foreground text-xs">
          {task.crew}
        </span>
      ) : null}
    </span>
  );
}

type RowActions = {
  onOpenHistory: (task: ScheduledTask) => void;
  onEdit: (task: ScheduledTask) => void;
  onRunNow: (task: ScheduledTask) => void;
  onToggle: (task: ScheduledTask, enabled: boolean) => void;
  onDelete: (task: ScheduledTask) => void;
};

function renderTaskCell(
  columnId: string,
  task: ScheduledTask,
  actions: RowActions
): ReactNode {
  switch (columnId) {
    case "schedule":
      return (
        <span className="truncate text-sm" title={task.cron}>
          {scheduleLabel(task)}
        </span>
      );
    case "nextRun":
      return task.enabled && task.nextRunAt ? (
        <span className="text-muted-foreground text-xs">
          {formatRelativeTimeOrFallback(task.nextRunAt)}
        </span>
      ) : (
        <GridEmptyValue />
      );
    case "lastRun":
      return task.lastRunAt ? (
        <span className="text-muted-foreground text-xs">
          {formatRelativeTimeOrFallback(task.lastRunAt)}
        </span>
      ) : (
        <GridEmptyValue />
      );
    case "status": {
      const chip = taskLastStatusChip(task);
      return <Chip variant={chip.variant}>{chip.label}</Chip>;
    }
    case "enabled":
      return (
        <Switch
          aria-label={`${task.name} enabled`}
          checked={task.enabled}
          onCheckedChange={(checked) => actions.onToggle(task, checked)}
        />
      );
    case ROW_ACTIONS_COLUMN_ID:
      return <RowMenu actions={actions} task={task} />;
    default:
      return null;
  }
}

function RowMenu({
  task,
  actions,
}: {
  task: ScheduledTask;
  actions: RowActions;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={`${task.name} actions`}
          size="icon-sm"
          variant="ghost"
        >
          <MoreHorizontalIcon aria-hidden className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => actions.onRunNow(task)}>
          <PlayIcon aria-hidden />
          Run now
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => actions.onEdit(task)}>
          <PencilIcon aria-hidden />
          Edit
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => actions.onOpenHistory(task)}>
          <HistoryIcon aria-hidden />
          History
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => actions.onDelete(task)}
          variant="destructive"
        >
          <Trash2Icon aria-hidden />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
