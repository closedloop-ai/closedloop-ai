"use client";

import type { RunRecord, ScheduledTask } from "@repo/crewd/model";
import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { CalendarClockIcon, PlusIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { RoutinesTable } from "./routines-table";
import { ScheduledTaskEditorDialog } from "./scheduled-task-editor-dialog";
import type {
  ScheduledTaskSaveInput,
  SchedulePreviewRequest,
  SchedulePreviewResult,
} from "./scheduled-task-editor-types";
import { ScheduledTaskRunsDrawer } from "./scheduled-task-runs-drawer";

/**
 * The Routines screen (PRD-566 / FEA-4348; formerly "Scheduled Tasks",
 * FEA-3852/3853/3854), shared across surfaces via `@repo/app/routines`.
 * Surface-agnostic: the caller injects a {@link RoutinesDataSource} (the desktop
 * wires it to `window.desktopApi.scheduledTasks.*`, whose IPC channel strings are
 * preserved as the version-skew-safe wire contract), so this slice carries no
 * IPC/Electron dependency and mounts identically under any host.
 *
 * One list, one modal, one history view — no dashboards. The view owns its own
 * load/empty state and re-fetches when the data source signals a change
 * (`onChanged`, driven by scheduler ticks and its own writes), so it stays live
 * behind the `routines` flag without polling. Writes (create / edit / delete /
 * toggle / run-now) route through the data source; a failure surfaces through the
 * host's global mutation handler rather than being swallowed. The underlying
 * datum is still a crewd `ScheduledTask` — the persisted/wire model is preserved
 * unchanged; only the user-facing feature is renamed to Routines.
 */

export type RoutinesDataSource = {
  /** Current task list (empty when the daemon is off / store unavailable). */
  list: () => Promise<ScheduledTask[]>;
  /** Recent run history, scoped to one task for the run-history drawer. */
  runs: (request?: { taskId?: string; limit?: number }) => Promise<RunRecord[]>;
  /** Create a task from the modal's validated save payload. */
  create: (payload: ScheduledTaskSaveInput) => Promise<ScheduledTask>;
  /** Update a task in place (by id) from the modal's validated save payload. */
  update: (payload: ScheduledTaskSaveInput) => Promise<ScheduledTask>;
  /** Delete a task by id (its runs cascade). */
  delete: (id: string) => Promise<boolean>;
  /** Flip a task's `enabled` flag (the list-row toggle). */
  toggle: (id: string, enabled: boolean) => Promise<ScheduledTask | null>;
  /** Fire one task once, off-schedule ("Run now"). */
  runNow: (id: string) => Promise<boolean>;
  /** Validate a cron and preview its next fire times (the create/edit modal). */
  previewSchedule: (
    request: SchedulePreviewRequest
  ) => Promise<SchedulePreviewResult>;
  /** Subscribe to change pushes; returns an unsubscribe fn. */
  onChanged: (callback: () => void) => () => void;
};

export function RoutinesView({
  dataSource,
}: {
  dataSource: RoutinesDataSource;
}) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [historyTask, setHistoryTask] = useState<ScheduledTask | null>(null);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<ScheduledTask | null>(null);

  const refreshTasks = useCallback(async () => {
    const next = await dataSource.list();
    setTasks(next);
    setLoaded(true);
  }, [dataSource]);

  // Initial load + live refresh: re-fetch tasks whenever the scheduler signals a
  // change. The onChanged subscription is torn down on unmount.
  useEffect(() => {
    let active = true;
    refreshTasks().catch(() => {
      if (active) {
        setLoaded(true);
      }
    });
    const unsubscribe = dataSource.onChanged(() => {
      refreshTasks().catch(() => undefined);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [dataSource, refreshTasks]);

  // While the drawer is open, keep its runs in sync with change pushes for the
  // task it is showing.
  useEffect(() => {
    if (!(drawerOpen && historyTask)) {
      return;
    }
    let active = true;
    const loadRuns = () => {
      dataSource
        .runs({ taskId: historyTask.id })
        .then((next) => {
          if (active) {
            setRuns(next);
          }
        })
        .catch(() => undefined);
    };
    loadRuns();
    const unsubscribe = dataSource.onChanged(loadRuns);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [dataSource, drawerOpen, historyTask]);

  const openHistory = useCallback((task: ScheduledTask) => {
    setHistoryTask(task);
    setRuns([]);
    setDrawerOpen(true);
  }, []);

  const openCreate = useCallback(() => {
    setEditingTask(null);
    setEditorOpen(true);
  }, []);

  const openEdit = useCallback((task: ScheduledTask) => {
    setEditingTask(task);
    setEditorOpen(true);
  }, []);

  const editorDialog = (
    <ScheduledTaskEditorDialog
      dataSource={dataSource}
      onOpenChange={setEditorOpen}
      open={editorOpen}
      task={editingTask}
    />
  );

  if (loaded && tasks.length === 0) {
    return (
      <>
        <EmptyState
          action={
            <Button className="gap-1.5" onClick={openCreate}>
              <PlusIcon aria-hidden className="size-4" />
              New routine
            </Button>
          }
          description="Routines you create will appear here with their next run, last run, and status."
          icon={CalendarClockIcon}
          title="No routines"
        />
        {editorDialog}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-end">
        <Button className="gap-1.5" onClick={openCreate}>
          <PlusIcon aria-hidden className="size-4" />
          New routine
        </Button>
      </div>
      <RoutinesTable
        onDelete={(task) => dataSource.delete(task.id)}
        onEdit={openEdit}
        onOpenHistory={openHistory}
        onRunNow={(task) => dataSource.runNow(task.id)}
        onToggle={(task, enabled) => dataSource.toggle(task.id, enabled)}
        tasks={tasks}
      />
      <ScheduledTaskRunsDrawer
        onOpenChange={setDrawerOpen}
        open={drawerOpen}
        runs={runs}
        task={historyTask}
      />
      {editorDialog}
    </div>
  );
}
