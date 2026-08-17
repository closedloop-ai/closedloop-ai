/**
 * Shared, serializable data model for the crew scheduler.
 *
 * This is the architectural keystone: the SAME Zod-validated shapes are the
 * durable on-disk store, the CLI's data, and — later — exactly what a Claude
 * Desktop-style scheduled-tasks UI in symphony-alpha renders (task list,
 * next-run / last-run, enable toggle, run-now, run history). Keep it
 * transport-neutral (no Node/fs types leak in here) so the app can import it
 * verbatim.
 *
 * The task shape is a superset of Claude Code's `.claude/scheduled_tasks.json`
 * entries (`id`, `cron`, `prompt`, `recurring`, `durable`) so our store stays
 * compatible with — and brokerable to — a live claude session.
 */
import { z } from "zod";

/** The harnesses the cascade can drive. "Switzerland": order is data, not code. */
export const HarnessName = {
  Claude: "claude",
  Codex: "codex",
  Opencode: "opencode",
} as const;
export type HarnessName = (typeof HarnessName)[keyof typeof HarnessName];
export const harnessNameSchema = z.enum(["claude", "codex", "opencode"]);

/**
 * One ordered step in a cascade: a harness plus an OPTIONAL model to drive it
 * with. `model: undefined` means "use this harness's default model" (see
 * `DEFAULT_MODEL`). This is the (harness, model) primitive the model-cascade UI
 * needs (FEA-3855 / PRD-552/553).
 *
 * On the wire we stay backward compatible with the harness-only cascade: a bare
 * harness-name string (the historical shape) parses to `{ harness, model:
 * undefined }`, and the `"harness:model"` shorthand parses to a step with that
 * model. This schema is the single normalization seam — both the persisted
 * `harnessCascade` field and `runCascade` (via its `normalizeCascade` helper)
 * route caller-supplied entries through it.
 */
export const cascadeStepSchema = z.preprocess(
  (value) => {
    if (typeof value !== "string") {
      return value;
    }
    // Accept a bare harness name ("codex") or the "harness:model" shorthand
    // ("codex:o3"). Split only on the first colon so a model id may contain
    // colons; an empty model half collapses to undefined (⇒ default model).
    const idx = value.indexOf(":");
    if (idx === -1) {
      return { harness: value };
    }
    const harness = value.slice(0, idx);
    const model = value.slice(idx + 1).trim();
    return model.length > 0 ? { harness, model } : { harness };
  },
  z.object({
    harness: harnessNameSchema,
    /** Model to drive this harness with; omitted ⇒ the harness's default model. */
    model: z.string().min(1).optional(),
  })
);
export type CascadeStep = z.infer<typeof cascadeStepSchema>;

/**
 * The model each harness drives with when a cascade step leaves `model` unset —
 * i.e. the meaning of a bare harness name in a cascade. Pure data (no `node:`
 * imports) so it stays renderer-safe and is the single source of truth shared
 * by the concrete drivers and the model-enumeration capability. Best-effort:
 * these track each CLI's own default and are safe to override per step.
 */
export const DEFAULT_MODEL: Record<HarnessName, string> = {
  [HarnessName.Claude]: "sonnet",
  [HarnessName.Codex]: "gpt-5-codex",
  [HarnessName.Opencode]: "anthropic/claude-sonnet-4-5",
};

/**
 * Best-effort static enumeration of models each harness can drive, for a future
 * UI picker (FEA-3855). Order is display order; the first entry is the default.
 * This is advisory — a harness may accept models not listed here — so callers
 * must treat it as a starting point, not an allow-list.
 */
export const AVAILABLE_MODELS: Record<HarnessName, readonly string[]> = {
  [HarnessName.Claude]: ["sonnet", "opus", "haiku"],
  [HarnessName.Codex]: ["gpt-5-codex", "gpt-5", "o3", "o4-mini"],
  [HarnessName.Opencode]: [
    "anthropic/claude-sonnet-4-5",
    "anthropic/claude-opus-4-1",
    "openai/gpt-5-codex",
  ],
};

/** The model a cascade step resolves to: its own model, or the harness default. */
export function resolveModel(step: CascadeStep): string {
  return step.model ?? DEFAULT_MODEL[step.harness];
}

/**
 * Cap a normalized cascade to ONE step per harness, keeping the FIRST occurrence
 * of each harness (and dropping any later duplicate, whatever model it carried).
 *
 * A cascade is "try each engine in order"; a second step for a harness already
 * in the list is dead — the first step for that harness always wins/short-circuits
 * before the run reaches the duplicate. The on-demand picker enforces this at the
 * UI (`buildRows`/`toggleHarness` keep one row per harness), but a PERSISTED config
 * (a hand-edited store row, a version-skewed writer, an imported cascade) can still
 * carry duplicates. This is the single reusable seam that normalizes those out at
 * the persisted boundary; it operates on already-`cascadeStepSchema`-normalized
 * steps and preserves order.
 */
export function dedupeCascade(cascade: readonly CascadeStep[]): CascadeStep[] {
  const seen = new Set<HarnessName>();
  const deduped: CascadeStep[] = [];
  for (const step of cascade) {
    if (seen.has(step.harness)) {
      continue;
    }
    seen.add(step.harness);
    deduped.push(step);
  }
  return deduped;
}

/**
 * The scope preset an on-demand audit run reviews (FEA-3850 M4). The canonical
 * wire enum lives here in the transport-neutral model so the desktop contract,
 * the audit pass, and the renderer picker all import ONE definition instead of
 * redeclaring the literals. `docs` narrows to documentation surfaces,
 * `changed-since-main` diffs vs. the merge-base with the repo's main branch, and
 * `whole-repo` reviews everything (the M1 default).
 */
export const AuditScope = {
  Docs: "docs",
  ChangedSinceMain: "changed-since-main",
  WholeRepo: "whole-repo",
} as const;
export type AuditScope = (typeof AuditScope)[keyof typeof AuditScope];
export const auditScopeSchema = z.enum([
  "docs",
  "changed-since-main",
  "whole-repo",
]);

/**
 * Where a harness can natively hold a schedule, if anywhere.
 *
 * `None` is not a placeholder — it is the DELIBERATE, permanent capability for
 * codex and opencode (FEA-4070). openai/codex ships no local scheduler daemon:
 * the CLI is `codex exec` (a one-shot), and its only scheduling surface is the
 * app-server *protocol* schemas that relay CLOUD scheduled-task data
 * (`/api/codex/tasks`, `/wham/tasks`) — there is nothing local to register a
 * schedule into and nothing local to run one. So codex's built-in capability is
 * `None`, and the capability-DERIVED default route for a codex task is the
 * daemon (`TaskRoute.LocalCascade`) by design; an operator who wants codex on a
 * schedule uses the crewd daemon, OS launchd/cron → `codex exec`, or the cloud
 * app-server (out of crewd scope). Codex remains a valid cascade EXECUTION
 * harness (crewd runs jobs THROUGH `codex exec`); this only rules it out as a
 * native SCHEDULING target.
 *
 * This is a statement about the built-in capability and the route it derives,
 * not an absolute routing veto: an explicit operator `--route
 * claude-scheduled-tasks` on a codex-primary task, or an injected registry that
 * declares codex native-capable, is still honored — those paths deliberately
 * override the default (see `cli.test.ts` / `broker.test.ts`). What is pinned
 * here is codex's DEFAULT capability. The `defaultTaskRoute` exhaustiveness
 * `never`-guard (see `broker.ts`) fails typecheck if a codex-native schedule
 * kind is ever reintroduced to this enum.
 */
export const NativeSchedule = {
  ClaudeScheduledTasks: "claude-scheduled-tasks",
  CloudRoutine: "cloud-routine",
  None: "none",
} as const;
export type NativeSchedule =
  (typeof NativeSchedule)[keyof typeof NativeSchedule];

/**
 * The capability broker's per-task route (FEA-3816 / PRD-553 M4). Where a task
 * runs when it fires:
 *   - `local-cascade` — our own daemon owns the timing and runs the job through
 *     the crewd `(harness, model)` cascade on this machine (the default, and how
 *     every task ran before M4).
 *   - `claude-routine` — the task is handed to a Claude cloud routine
 *     (`NativeSchedule.CloudRoutine`); the daemon does not run it locally.
 *
 * This is the persisted broker choice the editor surfaces and the list badges,
 * distinct from the pure `ScheduleRoute` the broker *derives* from a task's
 * harness capabilities: `route` is the operator's explicit intent, stored on the
 * task, while `decideRoute` is the capability-aware routing computed from it.
 *
 * `claude-scheduled-tasks` (FEA-3958) is a NATIVE route: the task's timing is
 * handed to Claude Code's local `~/.claude/scheduled_tasks.json`, materialized by
 * the desktop/CLI `ScheduledTasksRegistrar`, rather than run by our daemon.
 * FEA-4048 made it the capability-aware DEFAULT for a Claude-primary task (see
 * `defaultTaskRoute` in `broker.ts`): a task whose primary harness can natively
 * schedule routes here by default, with `local-cascade` (the daemon) as the
 * fallback for codex/opencode or an explicit opt-out. The schema `default` is
 * still `local-cascade` so a store written by an older desktop build (no `route`
 * column) parses to the daemon route, never a throw — the native default is
 * applied at task-CREATION time by the broker, not by the schema.
 */
export const TaskRoute = {
  LocalCascade: "local-cascade",
  ClaudeRoutine: "claude-routine",
  ClaudeScheduledTasks: "claude-scheduled-tasks",
} as const;
export type TaskRoute = (typeof TaskRoute)[keyof typeof TaskRoute];
export const taskRouteSchema = z.enum([
  "local-cascade",
  "claude-routine",
  "claude-scheduled-tasks",
]);

/** The routes THIS build understands (SSOT for skew-safe hydration). */
const KNOWN_TASK_ROUTES: ReadonlySet<string> = new Set(
  Object.values(TaskRoute)
);

/**
 * Normalize a persisted route value to a route THIS build understands, mapping
 * an unknown literal — a row written by a NEWER build carrying a future route,
 * or a hand-edited junk value — back to `local-cascade` (the daemon route, and
 * the pre-broker default). Version-skew safety: an older build degrades a task
 * it cannot route to running LOCALLY, never crashing on hydration. A missing
 * route is left `undefined` so the schema `default` fills it. This is the SSOT
 * the crewd JSON store and the desktop sqlite mirror both hydrate through.
 */
export function normalizeTaskRoute(route: unknown): TaskRoute | undefined {
  if (route === undefined || route === null) {
    return;
  }
  return typeof route === "string" && KNOWN_TASK_ROUTES.has(route)
    ? (route as TaskRoute)
    : TaskRoute.LocalCascade;
}

/**
 * The `route` field as HYDRATED from persisted stores: unknown literals are
 * normalized to `local-cascade` (see {@link normalizeTaskRoute}) instead of
 * throwing the whole store as corrupt, and a missing value defaults to the
 * daemon route. Distinct from the bare {@link taskRouteSchema} (a strict enum)
 * used where an unknown value SHOULD be rejected (e.g. an explicit CLI `--route`).
 */
export const taskRouteHydrationSchema = z.preprocess(
  normalizeTaskRoute,
  taskRouteSchema.default("local-cascade")
);

/**
 * The task routes whose timing is owned by a harness's OWN native scheduler
 * (Claude Code's local `scheduled_tasks.json` or a Claude cloud routine) rather
 * than by our daemon's cascade. When a task carries one of these routes AND the
 * owning registrar has confirmed it (stamping an owner id under
 * {@link NATIVE_OWNER_META_KEY} or {@link CLOUD_ROUTINE_ID_META_KEY}), the local
 * daemon must not also run it. `local-cascade` is deliberately absent — it is the
 * daemon route.
 */
const NATIVE_TASK_ROUTES: ReadonlySet<TaskRoute> = new Set([
  TaskRoute.ClaudeRoutine,
  TaskRoute.ClaudeScheduledTasks,
]);

/** Which orchestration a task drives. `custom` runs a bare prompt via the cascade. */
export const PassKind = {
  Review: "review",
  Apply: "apply",
  Barry: "barry",
  Sentinel: "sentinel",
  Custom: "custom",
} as const;
export type PassKind = (typeof PassKind)[keyof typeof PassKind];
export const passKindSchema = z.enum([
  "review",
  "apply",
  "barry",
  "sentinel",
  "custom",
]);

/** Outcome of a single scheduled run (the Desktop-UX status surface). */
export const RunStatus = {
  Pending: "pending",
  Running: "running",
  Success: "success",
  Failed: "failed",
  Skipped: "skipped",
  Timeout: "timeout",
  Canceled: "canceled",
} as const;
export type RunStatus = (typeof RunStatus)[keyof typeof RunStatus];
export const runStatusSchema = z.enum([
  "pending",
  "running",
  "success",
  "failed",
  "skipped",
  "timeout",
  "canceled",
]);

/** ISO-8601 timestamp string. */
const iso = z.string().datetime({ offset: true });

/**
 * A scheduled task. Superset of a Claude Code scheduled_tasks.json entry.
 */
export const scheduledTaskSchema = z.object({
  // ── Claude-Code-compatible core ──
  id: z.string().min(1),
  /** 5-field cron in `timezone` (default local). */
  cron: z.string().min(1),
  /** Claude-compat free-text; for crew passes this is a human descriptor. */
  prompt: z.string().default(""),
  recurring: z.boolean().default(true),
  durable: z.boolean().default(true),

  // ── crew / Desktop-UX fields ──
  /** Display name shown in the task list, e.g. "cutter-carl" or "apply sweep". */
  name: z.string().min(1),
  /** Owning crew subdir, e.g. "mikeangstadt". */
  crew: z.string().default(""),
  kind: passKindSchema.default("custom"),
  /**
   * The capability broker's per-task route (FEA-3816 / PRD-553 M4): run locally
   * through the crewd cascade, or hand the task to a Claude scheduler. Hydrated
   * through {@link taskRouteHydrationSchema}, so a MISSING route (a store written
   * by an older build with no `route` column) defaults to `local-cascade` AND an
   * UNKNOWN literal (a store written by a NEWER build carrying a future route, or
   * a hand-edited junk value) normalizes to `local-cascade` rather than throwing
   * the whole store as corrupt — version-skew safe in both directions.
   */
  route: taskRouteHydrationSchema,
  /** For review passes, the character/pass id (e.g. "cutter-carl"). */
  pass: z.string().optional(),
  /**
   * Per-task cascade order; falls back to the global default when empty. Each
   * entry is a `(harness, model?)` step. Backward compatible: legacy stores
   * that persisted bare harness-name strings (or the `"harness:model"`
   * shorthand) still parse — `cascadeStepSchema` normalizes them to steps, and
   * a step with no `model` runs on the harness's default model.
   */
  harnessCascade: z.array(cascadeStepSchema).default([]),
  /** IANA tz for cron evaluation; empty = host local time. */
  timezone: z.string().default(""),
  /** UI enable toggle. Disabled tasks never fire. */
  enabled: z.boolean().default(true),
  /** Run once on next tick if a scheduled fire was missed (laptop asleep). */
  catchUp: z.boolean().default(true),

  // ── bookkeeping (maintained by the scheduler) ──
  createdAt: iso,
  updatedAt: iso,
  /** Next computed fire time (ISO); advisory, recomputed each tick. */
  nextRunAt: iso.nullable().default(null),
  /** Last time this task actually fired (ISO). */
  lastRunAt: iso.nullable().default(null),
  /** id of the most recent RunRecord, for the UI to link to. */
  lastRunId: z.string().nullable().default(null),
  lastStatus: runStatusSchema.nullable().default(null),
  /**
   * ISS-4814 — the durable FIRE CURSOR for a one-time (`recurring: false`) task:
   * the ISO instant at which its single fire was STARTED, stamped atomically with
   * the launch record by `StorePort.startRun` (never on completion). A stamped
   * cursor means "this task's one fire is spent", so a daemon that crashed
   * mid-run and restarted still refuses to launch it at a later matching slot —
   * `lastRunAt` alone only suppresses the CURRENT slot. Mirrors Claude Code's own
   * `scheduled_tasks.json`, which advances its recurrence cursor on the FIRE, not
   * on success.
   *
   * Deliberately DISTINCT from `enabled`, which stays a pure operator pause: a
   * crash-recovered daemon must be able to tell "already fired once" from
   * "operator-paused". Null (the default, and what an older build's row without
   * the column hydrates to) means NOT YET FIRED — version-skew safe in both
   * directions. Only ever stamped for a one-time task; a recurring task tracks its
   * cadence through `lastRunAt` and leaves this null. A task edited from one-time
   * to recurring keeps any stamped cursor, which is inert while `recurring` is
   * true.
   */
  firedAt: iso.nullable().default(null),

  /** Open extension bag; never load-bearing for scheduling. */
  meta: z.record(z.string(), z.unknown()).default({}),
});
export type ScheduledTask = z.infer<typeof scheduledTaskSchema>;

/** One attempt at one harness within a cascade run (shows the fallback path). */
export const cascadeAttemptSchema = z.object({
  harness: harnessNameSchema,
  /**
   * The model this attempt actually drove the harness with (the step's model,
   * or the harness's default when the step left it unset). Nullable for
   * backward compatibility with run history persisted before FEA-3855, and for
   * `skipped` attempts where no model was resolved.
   */
  model: z.string().nullable().default(null),
  outcome: z.enum(["success", "failed", "timeout", "skipped"]),
  startedAt: iso,
  durationMs: z.number().int().nonnegative(),
  exitCode: z.number().int().nullable().default(null),
  note: z.string().default(""),
});
export type CascadeAttempt = z.infer<typeof cascadeAttemptSchema>;

/** A completed (or in-flight) run of a task — the history the UI lists. */
export const runRecordSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  taskName: z.string().default(""),
  status: runStatusSchema,
  startedAt: iso,
  finishedAt: iso.nullable().default(null),
  /** Which harness ultimately produced the result (last successful attempt). */
  harnessUsed: harnessNameSchema.nullable().default(null),
  /** Every harness tried, in order — the visible cascade trail. */
  attempts: z.array(cascadeAttemptSchema).default([]),
  /** One-line human summary for the UI row. */
  summary: z.string().default(""),
  logPath: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
});
export type RunRecord = z.infer<typeof runRecordSchema>;

/** The durable store file. Tasks + a bounded ring of recent runs. */
export const storeFileSchema = z.object({
  version: z.literal(1),
  tasks: z.array(scheduledTaskSchema).default([]),
  /** Most-recent-first; capped by the store (see MAX_RUN_HISTORY). */
  runs: z.array(runRecordSchema).default([]),
});
export type StoreFile = z.infer<typeof storeFileSchema>;

export const emptyStore = (): StoreFile => ({
  version: 1,
  tasks: [],
  runs: [],
});

/**
 * The `meta` key under which a task records CONFIRMED cloud-routine ownership
 * (FEA-3912 / FEA-3816). It is set to the cloud routine id ONLY after a
 * `RoutineRegistrar.register` round-trip returned `ok:true` — i.e. the Claude
 * cloud routine service actually accepted ownership of this task's timing. It is
 * absent (or cleared) whenever ownership is not confirmed: a `claude-routine`
 * route whose registration failed or is unwired (the stub registrar reports
 * `ok:false`), or a task flipped back to `local-cascade`.
 *
 * WHY this exists separately from `route`: `route` is the operator's *intent*
 * (persisted the instant they flip the toggle, regardless of whether the remote
 * registration round-trips). The local daemon must NOT suppress a task's local
 * run on intent alone — with the cloud API unwired, that would leave an opt-in
 * task running NOWHERE (no local run, no cloud routine). The daemon suppresses
 * local execution only on CONFIRMED ownership, which this marker records.
 */
export const CLOUD_ROUTINE_ID_META_KEY = "cloudRoutineId" as const;

/**
 * The route-agnostic `meta` key under which a task records CONFIRMED ownership by
 * a NATIVE scheduler (FEA-3958). It is the generalization of
 * {@link CLOUD_ROUTINE_ID_META_KEY}: set to the owner id returned by a native
 * registrar (a `ScheduledTasksRegistrar` for `claude-scheduled-tasks`) ONLY after
 * its `register` round-trip returned `ok:true` — i.e. the native scheduler
 * actually took ownership of this task's timing. Absent (or cleared) whenever
 * ownership is not confirmed: a native route whose registration failed/is
 * unwired, or a task flipped back to `local-cascade`. Same intent-vs-confirmation
 * split as the cloud key: `route` is the operator's intent, this marker is the
 * confirmation the daemon suppresses local runs on.
 */
export const NATIVE_OWNER_META_KEY = "nativeOwnerId" as const;

/** Whether `route` hands a task's timing to a harness's own native scheduler. */
export function isNativeRoute(route: TaskRoute): boolean {
  return NATIVE_TASK_ROUTES.has(route);
}

/**
 * The `meta` owner-id key that confirms ownership for a given native route. Each
 * native route stamps its OWN marker — `claude-scheduled-tasks` writes
 * {@link NATIVE_OWNER_META_KEY}, `claude-routine` writes
 * {@link CLOUD_ROUTINE_ID_META_KEY} — so a stale marker left by a route flip
 * (e.g. a `nativeOwnerId` lingering after a flip to `claude-routine` whose async
 * cleanup did not land) cannot be misread as confirmation for the OTHER route.
 * `local-cascade` has no native owner. Returns `undefined` for any non-native
 * route.
 */
function nativeOwnerKeyForRoute(route: TaskRoute): string | undefined {
  if (route === TaskRoute.ClaudeScheduledTasks) {
    return NATIVE_OWNER_META_KEY;
  }
  if (route === TaskRoute.ClaudeRoutine) {
    return CLOUD_ROUTINE_ID_META_KEY;
  }
  return;
}

/**
 * True when a task's local execution is owned by a CONFIRMED native scheduler:
 * its broker route is a native route (see {@link isNativeRoute}) AND the owning
 * registrar confirmed ownership by stamping a non-empty owner id under THAT
 * route's own marker ({@link NATIVE_OWNER_META_KEY} for `claude-scheduled-tasks`,
 * {@link CLOUD_ROUTINE_ID_META_KEY} for `claude-routine`). Route-matched so a
 * stale marker for the other native route (left behind by a not-yet-reconciled
 * route flip) is never misread as confirmation. The daemon's local-run
 * suppression keys off THIS predicate, not the raw `route`, so an unconfirmed
 * opt-in (failed/unwired registration) still runs locally instead of vanishing.
 */
export function hasConfirmedNativeOwner(task: ScheduledTask): boolean {
  const key = nativeOwnerKeyForRoute(task.route);
  if (key === undefined) {
    return false;
  }
  const ownerId = task.meta[key];
  return typeof ownerId === "string" && ownerId.length > 0;
}

/**
 * True when a task's local execution is owned by a CONFIRMED Claude cloud
 * routine: its broker route is `claude-routine` AND the registrar confirmed
 * ownership (stamping the routine id under {@link CLOUD_ROUTINE_ID_META_KEY}).
 * The daemon's local-run suppression keys off THIS predicate, not the raw
 * `route`, so an unconfirmed opt-in (failed/unwired registration) still runs
 * locally instead of vanishing.
 *
 * Retained (FEA-3958) as the cloud-specific facade over the generalized
 * {@link hasConfirmedNativeOwner}; the cloud confirmation stamps only
 * {@link CLOUD_ROUTINE_ID_META_KEY}, so this narrows the generalized predicate
 * back to the `claude-routine` route to keep pre-existing callers unchanged.
 */
export function hasConfirmedCloudRoutine(task: ScheduledTask): boolean {
  return (
    task.route === TaskRoute.ClaudeRoutine && hasConfirmedNativeOwner(task)
  );
}

/**
 * ISS-4814 — true when a one-time task's single fire is SPENT: `recurring` is
 * false AND the durable {@link ScheduledTask.firedAt} cursor is stamped. This is
 * the fire-once authority the daemon gates every launch on (scheduled and
 * manual), and because the cursor is written when the run STARTS, it survives a
 * crash or kill between the launch and the run's terminal bookkeeping.
 *
 * Reads NOTHING from `enabled` on purpose — that flag stays the operator pause,
 * so a restarted daemon can distinguish "already fired once" from
 * "operator-paused". A recurring task is never spent.
 */
export function hasSpentOneTimeFire(task: ScheduledTask): boolean {
  return !(task.recurring || isFireCursorAbsent(task.firedAt));
}

/**
 * ISS-4814 — true when starting a run for `task` must stamp the durable fire
 * cursor: a one-time task that has not fired yet. The `StorePort.startRun`
 * implementations call this against the CURRENT persisted row and fold the stamp
 * into the same write as the launch record, so there is no read-modify-write
 * window a crash can land in. Re-stamping is suppressed (first fire wins) and a
 * recurring task is never stamped.
 */
export function shouldStampFireCursor(task: ScheduledTask): boolean {
  return !task.recurring && isFireCursorAbsent(task.firedAt);
}

/**
 * ISS-4814 — true when a task carries NO fire cursor, i.e. its one-time fire has
 * not been spent. Both `null` and a MISSING key mean absent, and the distinction
 * matters at a version-skew boundary: `ScheduledTask` types `firedAt` as
 * `string | null` because {@link scheduledTaskSchema} defaults it, but a
 * `StorePort` adapter built against the pre-ISS-4814 contract hands the daemon
 * raw task objects that never went through that schema and simply omit the key.
 * Comparing against `null` alone would read those `undefined`s as "cursor
 * present" and mark every legacy one-time task permanently spent, while the
 * inverse check would refuse to ever stamp one. Hence one helper, used by BOTH
 * {@link hasSpentOneTimeFire} and {@link shouldStampFireCursor}, so the two
 * boundaries can never drift apart. The parameter widens to `undefined` on
 * purpose — the type does not constrain what an out-of-repo adapter actually
 * passes at runtime.
 */
function isFireCursorAbsent(
  firedAt: ScheduledTask["firedAt"] | undefined
): boolean {
  return firedAt === null || firedAt === undefined;
}
