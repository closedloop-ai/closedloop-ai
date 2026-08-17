/**
 * @file scheduled-task-rows.ts
 * @description The persisted `scheduled_tasks` / `scheduled_task_runs` row
 * shapes and the pure mappers between them and the crewd `ScheduledTask` /
 * `RunRecord` records.
 *
 * Separate from `sqlite-task-store.ts` because this is pure, side-effect-free
 * translation with no dependency on the store's in-memory mirror, write-behind
 * chain, or registrar reconciliation.
 */

import {
  normalizeTaskRoute,
  type RunRecord,
  runRecordSchema,
  type ScheduledTask,
  scheduledTaskSchema,
  TaskRoute,
} from "@repo/crewd";

/** The persisted `scheduled_tasks` row shape (JSON columns are strings). */
export type ScheduledTaskRow = {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  durable: boolean;
  crew: string;
  kind: string;
  route: string;
  pass: string | null;
  harnessCascade: string;
  timezone: string;
  enabled: boolean;
  catchUp: boolean;
  meta: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunId: string | null;
  lastStatus: string | null;
  /** ISS-4814: durable one-time fire cursor; null ⇒ not yet fired. */
  firedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** The persisted `scheduled_task_runs` row shape. */
export type ScheduledTaskRunRow = {
  id: string;
  taskId: string;
  taskName: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  harnessUsed: string | null;
  attempts: string;
  summary: string;
  logPath: string | null;
  error: string | null;
};

export function taskToRow(task: ScheduledTask): ScheduledTaskRow {
  return {
    id: task.id,
    name: task.name,
    cron: task.cron,
    prompt: task.prompt,
    recurring: task.recurring,
    durable: task.durable,
    crew: task.crew,
    kind: task.kind,
    route: task.route,
    pass: task.pass ?? null,
    harnessCascade: JSON.stringify(task.harnessCascade),
    timezone: task.timezone,
    enabled: task.enabled,
    catchUp: task.catchUp,
    meta: JSON.stringify(task.meta),
    nextRunAt: task.nextRunAt,
    lastRunAt: task.lastRunAt,
    lastRunId: task.lastRunId,
    lastStatus: task.lastStatus,
    firedAt: task.firedAt,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

export function runToRow(run: RunRecord): ScheduledTaskRunRow {
  return {
    id: run.id,
    taskId: run.taskId,
    taskName: run.taskName,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    harnessUsed: run.harnessUsed,
    attempts: JSON.stringify(run.attempts),
    summary: run.summary,
    logPath: run.logPath,
    error: run.error,
  };
}

function safeJsonArray(raw: string): unknown[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * FEA-3958 skew safety: normalize a persisted route string to a route THIS build
 * knows. A row written by a NEWER desktop build carrying a future route (or a
 * hand-edited junk value) would otherwise be trusted verbatim into `rowToTask`.
 * Mapping an unknown route back to `local-cascade` (the daemon route, and the
 * pre-broker default) degrades gracefully: an older build runs such a task
 * locally instead of crashing on it. Delegates to the crewd SSOT
 * ({@link normalizeTaskRoute}) so the known-route set never drifts between the
 * desktop sqlite mirror and the crewd JSON store; the `row.route` column is
 * non-null, so the `undefined` (absent) branch cannot occur here.
 */
function normalizeRoute(route: string): TaskRoute {
  return normalizeTaskRoute(route) ?? TaskRoute.LocalCascade;
}

export function rowToTask(row: ScheduledTaskRow): ScheduledTask {
  // Re-validate through the crewd schema so a mirror written by an older desktop
  // build (or a hand-edited row) is normalized to the current model, never
  // trusted verbatim.
  return scheduledTaskSchema.parse({
    id: row.id,
    name: row.name,
    cron: row.cron,
    prompt: row.prompt,
    recurring: row.recurring,
    durable: row.durable,
    crew: row.crew,
    kind: row.kind,
    route: normalizeRoute(row.route),
    pass: row.pass ?? undefined,
    harnessCascade: safeJsonArray(row.harnessCascade),
    timezone: row.timezone,
    enabled: row.enabled,
    catchUp: row.catchUp,
    meta: safeJsonObject(row.meta),
    nextRunAt: row.nextRunAt,
    lastRunAt: row.lastRunAt,
    lastRunId: row.lastRunId,
    lastStatus: row.lastStatus,
    // ISS-4814: a row written before the `fired_at` column existed reads
    // `undefined` here (and null once migrated); both hydrate through the crewd
    // schema's `.nullable().default(null)` to "not yet fired".
    firedAt: row.firedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export function rowToRun(row: ScheduledTaskRunRow): RunRecord {
  return runRecordSchema.parse({
    id: row.id,
    taskId: row.taskId,
    taskName: row.taskName,
    status: row.status,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    harnessUsed: row.harnessUsed,
    attempts: safeJsonArray(row.attempts),
    summary: row.summary,
    logPath: row.logPath,
    error: row.error,
  });
}
