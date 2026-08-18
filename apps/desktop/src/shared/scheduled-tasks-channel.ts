/**
 * @file scheduled-tasks-channel.ts
 * @description FEA-3852/3853/3854 (PRD-553) — shared IPC contract for the
 * Scheduled Tasks surface. Imported by the main handlers (in the design-system
 * runtime), the preload bridge (`preload-common.ts`), and the renderer
 * `DesktopApi` contract so all three agree on one shape.
 *
 * The payloads are the crewd (`@repo/crewd`) `ScheduledTask` / `RunRecord`
 * shapes verbatim — aliased (not re-declared) so the desktop surface and the
 * scheduler core cannot drift (AGENTS.md: one canonical type). Both are
 * transport-neutral Zod-inferred plain objects, so they cross the db-host
 * method proxy and the renderer IPC boundary structured-clone-safe.
 *
 * The read channels (`list`, `runs`) plus a `changed` push (FEA-3852/3854) let
 * the renderer re-read after a scheduler tick without polling. The write
 * channels (`create`, `update`, `delete`, `toggle`, `runNow`) plus
 * `previewSchedule` (FEA-3853) close the loop: every write is validated at the
 * boundary with the crewd Zod schema, runs through the trusted-sender-gated
 * handler, and mutates the SQLite-mirrored store, which then pushes `changed`.
 */

import {
  cascadeStepSchema,
  passKindSchema,
  type RunRecord,
  type ScheduledTask,
  taskRouteSchema,
} from "@repo/crewd/model";
import { z } from "zod";

export const ScheduledTasksIpcChannel = {
  /** Read the current task list (the SQLite-mirrored in-memory store). */
  List: "desktop:scheduled-tasks:list",
  /** Read recent run history, optionally scoped to one task. */
  Runs: "desktop:scheduled-tasks:runs",
  /** Create a new task from a validated save payload. */
  Create: "desktop:scheduled-tasks:create",
  /** Update an existing task in place (by id) from a validated save payload. */
  Update: "desktop:scheduled-tasks:update",
  /** Delete a task by id (its runs cascade). */
  Delete: "desktop:scheduled-tasks:delete",
  /** Flip a task's `enabled` flag by id. */
  Toggle: "desktop:scheduled-tasks:toggle",
  /** Fire a task once immediately, off-schedule. */
  RunNow: "desktop:scheduled-tasks:run-now",
  /** Validate a cron and preview its next N fire times (create/edit modal). */
  PreviewSchedule: "desktop:scheduled-tasks:preview-schedule",
} as const;
export type ScheduledTasksIpcChannel =
  (typeof ScheduledTasksIpcChannel)[keyof typeof ScheduledTasksIpcChannel];

export const SCHEDULED_TASKS_IPC_CHANNEL_LIST = [
  ScheduledTasksIpcChannel.List,
  ScheduledTasksIpcChannel.Runs,
  ScheduledTasksIpcChannel.Create,
  ScheduledTasksIpcChannel.Update,
  ScheduledTasksIpcChannel.Delete,
  ScheduledTasksIpcChannel.Toggle,
  ScheduledTasksIpcChannel.RunNow,
  ScheduledTasksIpcChannel.PreviewSchedule,
] as const;

/**
 * Main → renderer push channel: emitted after a scheduler tick (or start/stop
 * or any write) so a mounted Scheduled Tasks view re-reads `list` + `runs`
 * without polling. Payload-free — the renderer refetches through the read
 * channels.
 */
export const SCHEDULED_TASKS_CHANGED_CHANNEL =
  "desktop:scheduled-tasks:changed" as const;

/** Request shape for the `runs` channel. Both fields optional. */
export type ScheduledTaskRunsRequest = {
  /** Scope to one task's runs; omit for all recent runs across tasks. */
  taskId?: string;
  /** Cap the number of rows returned (the store's own default applies when omitted). */
  limit?: number;
};

/** The `list` channel response — the canonical crewd task shape, verbatim. */
export type ScheduledTaskListItem = ScheduledTask;

/** The `runs` channel response element — the canonical crewd run shape, verbatim. */
export type ScheduledTaskRunItem = RunRecord;

/**
 * The create/edit modal's save payload. A trimmed, UI-facing subset of the
 * crewd `ScheduledTask`: the store fills every other field (bookkeeping,
 * defaults). Validated at the IPC boundary with this schema — a renderer that
 * sends a malformed cascade step, an empty name, or an unknown pass kind is
 * rejected before touching the store, not silently coerced. `id` present ⇒
 * update in place; absent ⇒ create. The cascade reuses `cascadeStepSchema`
 * verbatim so the `(harness, model)` steps stay the single normalization seam
 * (FEA-3855).
 */
export const scheduledTaskSaveSchema = z.object({
  /** Present on edit, absent on create. */
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  cron: z.string().min(1),
  /** Custom prompt (for a `custom` pass) or the human descriptor for a pass. */
  prompt: z.string().default(""),
  kind: passKindSchema.default("custom"),
  /** For a review pass, the character/pass id. */
  pass: z.string().optional(),
  /** Ordered, reorderable `(harness, model)` cascade; empty ⇒ global default. */
  harnessCascade: z.array(cascadeStepSchema).default([]),
  /**
   * FEA-3816 (PRD-553 M4): the capability broker's per-task route — run locally
   * through the crewd cascade (`local-cascade`, the default) or hand the task to
   * a Claude cloud routine (`claude-routine`). Defaults to `local-cascade` so an
   * older renderer that never sends the field keeps the pre-M4 local behavior.
   * The store fires the routine-registrar seam on a flip; the persisted route is
   * authoritative regardless of the remote round-trip.
   */
  route: taskRouteSchema.default("local-cascade"),
  /** IANA tz for cron evaluation; empty ⇒ host-local. */
  timezone: z.string().default(""),
  enabled: z.boolean().default(true),
});
export type ScheduledTaskSaveInput = z.infer<typeof scheduledTaskSaveSchema>;

/** Request for `previewSchedule`: a cron to validate, plus an optional tz. */
export const schedulePreviewRequestSchema = z.object({
  cron: z.string(),
  timezone: z.string().default(""),
  /** How many upcoming fire times to return (clamped 1..10; default 3). */
  count: z.number().int().optional(),
});
/**
 * The caller-facing request type is the schema INPUT (timezone/count optional —
 * the schema fills the defaults), so a renderer may send just `{ cron }`. The
 * handler parses to the output shape before use.
 */
export type SchedulePreviewRequest = z.input<
  typeof schedulePreviewRequestSchema
>;

/**
 * `previewSchedule` response: whether the cron parsed, an error message when
 * not, and the next `count` fire times as ISO strings (empty when invalid).
 * Read-only preview — no task is created.
 */
export type SchedulePreviewResult = {
  valid: boolean;
  error: string | null;
  /** Next fire times (ISO-8601), most-imminent-first. Empty when invalid. */
  nextRuns: string[];
};

/**
 * Normalize the untrusted `runs` IPC arg (a renderer-supplied value) to the
 * shared request shape. `taskId` must be a non-empty string to scope; `limit`
 * must be a positive integer to cap (otherwise the store's own default applies).
 * Anything malformed degrades to an unscoped, default-limited read — never a
 * throw. Lives with the contract (not the main handler) so both the boundary
 * sanitizer and its test import one canonical implementation.
 */
export function coerceScheduledTaskRunsRequest(
  value: unknown
): ScheduledTaskRunsRequest {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const record = value as { taskId?: unknown; limit?: unknown };
  const taskId =
    typeof record.taskId === "string" && record.taskId.length > 0
      ? record.taskId
      : undefined;
  const limit =
    typeof record.limit === "number" &&
    Number.isInteger(record.limit) &&
    record.limit > 0
      ? record.limit
      : undefined;
  return { taskId, limit };
}

/**
 * Coerce an untrusted renderer-supplied id arg (for `delete`/`toggle`/`runNow`)
 * to a non-empty string, or null when malformed. The handler rejects a null id
 * rather than acting on `undefined`.
 */
export function coerceScheduledTaskId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
