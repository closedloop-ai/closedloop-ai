import {
  type RunRecord,
  type RunStatus,
  type ScheduledTask,
  TaskRoute,
} from "@repo/crewd/model";

/**
 * Presentational helpers for the shared Routines slice (PRD-566 / FEA-4348;
 * formerly "Scheduled Tasks", FEA-3852/3854).
 * The table renders the crewd `ScheduledTask` / the drawer renders its
 * `RunRecord` history verbatim — these map the domain `RunStatus` union onto
 * design-system Chip variants + display labels, keyed by an exhaustive `Record`
 * so a new crewd status fails typecheck here until it is given a treatment
 * (AGENTS.md exhaustiveness rule), and turn a 5-field cron into the plain-English
 * schedule the list row shows ("Every weekday at 9:00").
 */

/**
 * The design-system Chip variants this surface maps status onto. A literal union
 * (matching the house pattern in `resolution-badge.tsx`) so the slice does not
 * take a direct `class-variance-authority` dependency for a type.
 */
type ChipVariant =
  | "muted"
  | "info"
  | "success"
  | "destructive"
  | "warning"
  | "outline";

export type RunStatusChip = {
  label: string;
  variant: ChipVariant;
};

/**
 * Exhaustive `RunStatus` → Chip treatment. `Record<RunStatus, …>` makes an
 * unhandled crewd status a compile error rather than a silently unstyled chip.
 */
export const RUN_STATUS_CHIP: Record<RunStatus, RunStatusChip> = {
  pending: { label: "Pending", variant: "muted" },
  running: { label: "Running", variant: "info" },
  success: { label: "Success", variant: "success" },
  failed: { label: "Failed", variant: "destructive" },
  skipped: { label: "Skipped", variant: "muted" },
  timeout: { label: "Timed out", variant: "warning" },
  canceled: { label: "Canceled", variant: "muted" },
};

/** The Chip treatment for a task's last-run status, or a neutral "never run". */
export function taskLastStatusChip(task: ScheduledTask): RunStatusChip {
  return task.lastStatus
    ? RUN_STATUS_CHIP[task.lastStatus]
    : { label: "Never run", variant: "outline" };
}

/** The Chip treatment for one run in the history drawer. */
export function runStatusChip(run: RunRecord): RunStatusChip {
  return RUN_STATUS_CHIP[run.status];
}

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const MINUTE_STEP_PATTERN = /^\*\/(\d+)$/;
const SINGLE_WEEKDAY_PATTERN = /^[0-6]$/;
const DAY_OF_MONTH_PATTERN = /^\d{1,2}$/;
const WHITESPACE = /\s+/;

/** Format an `hour`/`minute` pair as a 24-hour clock time ("9:00", "14:30"). */
function clockLabel(hour: number, minute: number): string {
  return `${hour}:${minute.toString().padStart(2, "0")}`;
}

type CronFields = {
  minuteField: string;
  hourField: string;
  domField: string;
  dowField: string;
};

/** Sub-hourly schedules ("*​/15 * * * *", "0 * * * *"), or null if not one. */
function subHourlyLabel(fields: CronFields, suffix: string): string | null {
  const { minuteField, hourField, domField, dowField } = fields;
  if (!(hourField === "*" && domField === "*" && dowField === "*")) {
    return null;
  }
  if (minuteField === "*") {
    return `Every minute${suffix}`;
  }
  const stepMatch = minuteField.match(MINUTE_STEP_PATTERN);
  if (stepMatch) {
    return `Every ${stepMatch[1]} minutes${suffix}`;
  }
  const minute = Number(minuteField);
  if (Number.isInteger(minute)) {
    return `Every hour at :${minute.toString().padStart(2, "0")}${suffix}`;
  }
  return null;
}

/** Fixed-time daily/weekly/monthly schedules, or null if not one. */
function fixedTimeLabel(
  fields: CronFields,
  time: string,
  suffix: string
): string | null {
  const { domField, dowField } = fields;
  if (domField === "*" && dowField === "*") {
    return `Every day at ${time}${suffix}`;
  }
  if (domField === "*" && dowField === "1-5") {
    return `Every weekday at ${time}${suffix}`;
  }
  if (domField === "*" && SINGLE_WEEKDAY_PATTERN.test(dowField)) {
    return `Every ${WEEKDAY_NAMES[Number(dowField)]} at ${time}${suffix}`;
  }
  if (dowField === "*" && DAY_OF_MONTH_PATTERN.test(domField)) {
    return `Monthly on day ${domField} at ${time}${suffix}`;
  }
  return null;
}

/**
 * Turn a 5-field cron (`minute hour dom month dow`) into a plain-English
 * schedule for the list row. Covers the schedules the create/edit modal's
 * presets and common natural-language inputs produce — daily, weekdays, a single
 * weekday, weekly, hourly, and every-N-minutes — and falls back to the raw cron
 * for anything it does not recognize (never a lie, just less pretty). Pure and
 * renderer-safe: no cron-parser, only field-shape inspection. The optional IANA
 * timezone is appended when the task pins one (empty ⇒ host-local, unlabeled).
 */
export function humanizeCron(cron: string, timezone = ""): string {
  const fallback = timezone ? `${cron} (${timezone})` : cron;
  const suffix = timezone ? ` (${timezone})` : "";
  const parts = cron.trim().split(WHITESPACE);
  if (parts.length !== 5) {
    return fallback;
  }
  const [minuteField, hourField, domField, , dowField] = parts;
  const fields: CronFields = { minuteField, hourField, domField, dowField };

  const subHourly = subHourlyLabel(fields, suffix);
  if (subHourly) {
    return subHourly;
  }

  const minute = Number(minuteField);
  const hour = Number(hourField);
  if (!(Number.isInteger(minute) && Number.isInteger(hour))) {
    return fallback;
  }
  return fixedTimeLabel(fields, clockLabel(hour, minute), suffix) ?? fallback;
}

/**
 * A one-line human descriptor of a task's schedule for the list row: the
 * plain-English cron plus its IANA timezone when one is set.
 */
export function scheduleLabel(task: ScheduledTask): string {
  return humanizeCron(task.cron, task.timezone);
}

export type TaskRouteChip = {
  label: string;
  variant: ChipVariant;
};

/**
 * FEA-3816 (PRD-553 M4) / FEA-3958: exhaustive `TaskRoute` → Chip treatment for
 * the capability broker's per-task route badge. `Record<TaskRoute, …>` makes a
 * new crewd route a compile error here until it is given a badge (AGENTS.md
 * exhaustiveness rule). `local-cascade` is the neutral default (it renders no
 * badge in the list — see `taskRouteBadge`); `claude-routine` (a Claude cloud
 * routine) and `claude-scheduled-tasks` (Claude Code's local scheduler) are the
 * notable "handed to Claude" states, so each gets an info chip.
 */
export const TASK_ROUTE_CHIP: Record<TaskRoute, TaskRouteChip> = {
  [TaskRoute.LocalCascade]: { label: "Local cascade", variant: "muted" },
  [TaskRoute.ClaudeRoutine]: { label: "Claude routine", variant: "info" },
  [TaskRoute.ClaudeScheduledTasks]: {
    label: "Claude scheduled tasks",
    variant: "info",
  },
};

/**
 * The route badge to show on a task's list row, or null when the route is the
 * neutral `local-cascade` default (every task ran that way before M4, so it
 * needs no badge — only the notable "handed to Claude" route surfaces one).
 */
export function taskRouteBadge(task: ScheduledTask): TaskRouteChip | null {
  return task.route === TaskRoute.LocalCascade
    ? null
    : TASK_ROUTE_CHIP[task.route];
}
