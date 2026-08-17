import { z } from "zod";

/**
 * Shared Routine + RoutineRun contract types (FEA-4365 / PRD-566).
 *
 * The cloud/web-side persistence contract for scheduled Routines and their run
 * history — the org/team-scoped source of truth the Web surface reads and that
 * desktop-origin routines sync up to. These shapes are a SUPERSET mapping of the
 * desktop crewd `ScheduledTask`/`RunRecord` model (packages/crewd/src/model.ts)
 * and are faithful to the frozen Routines prototype
 * (apps/prototypes/app/p/routines/mock.ts).
 *
 * The enums below are const objects (per repo convention — `packages/api` must
 * NOT import `@repo/database`) whose VALUES exactly match the Prisma enum member
 * names in `packages/database/prisma/schema.prisma` (`RoutineProvider`,
 * `RoutineStatus`, …). They are one synchronized layer with the schema: when a
 * value is added here it must be added to the Prisma enum (and vice versa); the
 * service maps these strings straight onto the Prisma enum columns.
 *
 * SEAM: sibling FEA-4349 owns the `@repo/app/routines` domain model. Its const
 * objects use lowercase prototype values (e.g. `"claude"`); these use the
 * UPPERCASE Prisma member names (e.g. `"CLAUDE"`) because they are the DB
 * contract. Keep the two value sets in 1:1 correspondence when FEA-4349 lands.
 */

// Harness/provider that drives a routine. Superset of the prototype's
// RoutineProvider (claude/codex); `OPENCODE` reconciles with crewd's HarnessName.
export const RoutineProvider = {
  Claude: "CLAUDE",
  Codex: "CODEX",
  Opencode: "OPENCODE",
} as const;
export type RoutineProvider =
  (typeof RoutineProvider)[keyof typeof RoutineProvider];

// Where a routine executes when it fires. Mirrors the prototype's RunsOn.
export const RoutineRunsOn = {
  Local: "LOCAL",
  Cloud: "CLOUD",
} as const;
export type RoutineRunsOn = (typeof RoutineRunsOn)[keyof typeof RoutineRunsOn];

// How a routine came to exist. Mirrors the prototype's RoutineOrigin.
export const RoutineOrigin = {
  Created: "CREATED",
  Discovered: "DISCOVERED",
} as const;
export type RoutineOrigin = (typeof RoutineOrigin)[keyof typeof RoutineOrigin];

// Lifecycle status of a routine. Mirrors the prototype's RoutineStatus.
export const RoutineStatus = {
  Active: "ACTIVE",
  Paused: "PAUSED",
  Draft: "DRAFT",
} as const;
export type RoutineStatus = (typeof RoutineStatus)[keyof typeof RoutineStatus];

// Kind of recurrence the schedule expresses. Mirrors the prototype's
// ScheduleKind; `scheduleDetail`/`cron` carry the concrete timing.
export const RoutineScheduleKind = {
  Manual: "MANUAL",
  Hourly: "HOURLY",
  Daily: "DAILY",
  Weekdays: "WEEKDAYS",
  Weekly: "WEEKLY",
  Custom: "CUSTOM",
} as const;
export type RoutineScheduleKind =
  (typeof RoutineScheduleKind)[keyof typeof RoutineScheduleKind];

// When to notify on a run. Mirrors the prototype's NotifyMode.
export const RoutineNotifyMode = {
  AllRuns: "ALL_RUNS",
  FailedRunsOnly: "FAILED_RUNS_ONLY",
} as const;
export type RoutineNotifyMode =
  (typeof RoutineNotifyMode)[keyof typeof RoutineNotifyMode];

// Codex-only "Runs in" choice. Mirrors the prototype's RunsIn; null otherwise.
export const RoutineRunsIn = {
  NewChat: "NEW_CHAT",
  ExistingChat: "EXISTING_CHAT",
} as const;
export type RoutineRunsIn = (typeof RoutineRunsIn)[keyof typeof RoutineRunsIn];

// Outcome of a single routine run. Superset reconciling with crewd's RunStatus.
export const RoutineRunStatus = {
  Pending: "PENDING",
  Running: "RUNNING",
  Success: "SUCCESS",
  Failed: "FAILED",
  Skipped: "SKIPPED",
  Timeout: "TIMEOUT",
  Canceled: "CANCELED",
} as const;
export type RoutineRunStatus =
  (typeof RoutineRunStatus)[keyof typeof RoutineRunStatus];

// The kind of component a run invoked. Mirrors the prototype's ComponentKind.
export const RoutineComponentKind = {
  Subagent: "SUBAGENT",
  Command: "COMMAND",
  Skill: "SKILL",
} as const;
export type RoutineComponentKind =
  (typeof RoutineComponentKind)[keyof typeof RoutineComponentKind];

// Zod enums derived from the const objects so validators and the enums cannot
// drift. Values are the Prisma enum member names, so validated values feed the
// Prisma enum columns directly.
export const routineProviderSchema = z.enum(
  Object.values(RoutineProvider) as [RoutineProvider, ...RoutineProvider[]]
);
export const routineRunsOnSchema = z.enum(
  Object.values(RoutineRunsOn) as [RoutineRunsOn, ...RoutineRunsOn[]]
);
export const routineOriginSchema = z.enum(
  Object.values(RoutineOrigin) as [RoutineOrigin, ...RoutineOrigin[]]
);
export const routineStatusSchema = z.enum(
  Object.values(RoutineStatus) as [RoutineStatus, ...RoutineStatus[]]
);
export const routineScheduleKindSchema = z.enum(
  Object.values(RoutineScheduleKind) as [
    RoutineScheduleKind,
    ...RoutineScheduleKind[],
  ]
);
export const routineNotifyModeSchema = z.enum(
  Object.values(RoutineNotifyMode) as [
    RoutineNotifyMode,
    ...RoutineNotifyMode[],
  ]
);
export const routineRunsInSchema = z.enum(
  Object.values(RoutineRunsIn) as [RoutineRunsIn, ...RoutineRunsIn[]]
);
export const routineRunStatusSchema = z.enum(
  Object.values(RoutineRunStatus) as [RoutineRunStatus, ...RoutineRunStatus[]]
);
export const routineComponentKindSchema = z.enum(
  Object.values(RoutineComponentKind) as [
    RoutineComponentKind,
    ...RoutineComponentKind[],
  ]
);

// ── Payload bounds (FEA-4365) ─────────────────────────────────────────────
// A run payload is otherwise unbounded: the ROUTINE_RUN_HISTORY_CAP limits the
// row COUNT, not the bytes per row, so without these a single client could fill
// every retained run with megabyte summaries/errors/session-id lists and then
// list them all back. Bound every free-text field and every collection here at
// the contract so the cloud store can't be used as unbounded storage; a route
// enforcing an aggregate request budget composes on top of these per-field caps.
export const ROUTINE_SHORT_TEXT_MAX = 500;
export const ROUTINE_LONG_TEXT_MAX = 20_000;
/** Max ids in a run's `sessionIds` / a routine's `connectorIds`. */
export const ROUTINE_ID_LIST_MAX = 100;
/** Max components in a run's `invokedComponents` trail. */
export const ROUTINE_COMPONENT_LIST_MAX = 500;
/** Max harness attempts in a run's cascade trail. */
export const ROUTINE_ATTEMPT_LIST_MAX = 50;

/**
 * One component a routine run invoked — mirrors the prototype's
 * `InvokedComponent`. Persisted as a JSON array on `RoutineRun`. String fields
 * are bounded so a component trail can't smuggle in unbounded text.
 */
export const invokedComponentSchema = z.object({
  id: z.string().max(ROUTINE_SHORT_TEXT_MAX),
  name: z.string().max(ROUTINE_SHORT_TEXT_MAX),
  kind: routineComponentKindSchema,
  /** False for a component not yet in the committed agents catalog. */
  cataloged: z.boolean().default(true),
});
export type InvokedComponent = z.infer<typeof invokedComponentSchema>;

/**
 * One harness attempt in a run's cascade/fallback trail — mirrors crewd's
 * `CascadeAttempt`. Persisted as a JSON array on `RoutineRun.attempts`, bounded.
 */
export const routineRunAttemptSchema = z.object({
  provider: routineProviderSchema,
  modelId: z.string().max(ROUTINE_SHORT_TEXT_MAX).nullish(),
  status: routineRunStatusSchema,
  error: z.string().max(ROUTINE_LONG_TEXT_MAX).nullish(),
});
export type RoutineRunAttempt = z.infer<typeof routineRunAttemptSchema>;

/**
 * One step in a routine's cascade order — a bounded mirror of crewd's
 * `CascadeStep` (a `(harness, model?)` pair). Persisted as a JSON array on
 * `Routine.harnessCascade`; empty falls back to the global default cascade.
 */
export const cascadeStepInputSchema = z.object({
  provider: routineProviderSchema,
  modelId: z.string().max(ROUTINE_SHORT_TEXT_MAX).nullish(),
});
export type CascadeStepInput = z.infer<typeof cascadeStepInputSchema>;

/**
 * Create-routine input. Provider-conditional fields are optional and default to
 * the safe empty/null value when the provider can't emit them (Codex has no
 * permission mode/worktree; Claude has no reasoning effort/runsIn/project),
 * mirroring the prototype's `providerCapabilities` gating.
 */
export const createRoutineInputSchema = z.object({
  /**
   * Desktop-source identity (crewd `ScheduledTask.id`, an arbitrary string, NOT
   * a UUID) when this create is a sync-up of a desktop-origin routine. Absent
   * for a UI-CREATED routine. Bounded free-text; the org-scoped upsert keys on
   * this so re-syncing the same task is idempotent per org.
   */
  sourceId: z.string().max(ROUTINE_SHORT_TEXT_MAX).nullish(),
  teamId: z.string().uuid().nullish(),
  name: z.string().min(1).max(ROUTINE_SHORT_TEXT_MAX),
  description: z.string().max(ROUTINE_LONG_TEXT_MAX).default(""),
  instructions: z.string().max(ROUTINE_LONG_TEXT_MAX).default(""),
  ownerId: z.string().uuid().nullish(),
  ownerName: z.string().max(ROUTINE_SHORT_TEXT_MAX).nullish(),
  provider: routineProviderSchema,
  modelId: z.string().min(1).max(ROUTINE_SHORT_TEXT_MAX),
  runsOn: routineRunsOnSchema.default(RoutineRunsOn.Local),
  origin: routineOriginSchema.default(RoutineOrigin.Created),
  status: routineStatusSchema.default(RoutineStatus.Draft),
  scheduleKind: routineScheduleKindSchema.default(RoutineScheduleKind.Manual),
  scheduleDetail: z.string().max(ROUTINE_SHORT_TEXT_MAX).default(""),
  cron: z.string().max(ROUTINE_SHORT_TEXT_MAX).nullish(),
  timezone: z.string().max(ROUTINE_SHORT_TEXT_MAX).default(""),
  enabled: z.boolean().default(true),
  notifyMode: routineNotifyModeSchema.default(RoutineNotifyMode.AllRuns),
  folderOrRepo: z.string().max(ROUTINE_SHORT_TEXT_MAX).nullish(),
  project: z.string().max(ROUTINE_SHORT_TEXT_MAX).nullish(),
  runsIn: routineRunsInSchema.nullish(),
  hostMachine: z.string().max(ROUTINE_SHORT_TEXT_MAX).nullish(),
  connectorIds: z
    .array(z.string().max(ROUTINE_SHORT_TEXT_MAX))
    .max(ROUTINE_ID_LIST_MAX)
    .default([]),
  autoFixPullRequests: z.boolean().default(false),
  permissionMode: z.string().max(ROUTINE_SHORT_TEXT_MAX).nullish(),
  reasoningEffort: z.string().max(ROUTINE_SHORT_TEXT_MAX).nullish(),
  worktree: z.boolean().default(false),
  // ── Lossless crewd ScheduledTask carry-through (superset) ──
  route: z.string().max(ROUTINE_SHORT_TEXT_MAX).nullish(),
  harnessCascade: z
    .array(cascadeStepInputSchema)
    .max(ROUTINE_ATTEMPT_LIST_MAX)
    .default([]),
  catchUp: z.boolean().default(true),
  recurring: z.boolean().default(true),
  durable: z.boolean().default(true),
  passKind: z.string().max(ROUTINE_SHORT_TEXT_MAX).nullish(),
  pass: z.string().max(ROUTINE_SHORT_TEXT_MAX).nullish(),
  crew: z.string().max(ROUTINE_SHORT_TEXT_MAX).default(""),
  meta: z.record(z.string(), z.unknown()).default({}),
});
export type CreateRoutineInput = z.infer<typeof createRoutineInputSchema>;

/**
 * Update-routine input. Every field optional; org/team scope and identity are
 * supplied out-of-band by the caller, never in the body.
 *
 * NOT `createRoutineInputSchema.partial()`: `.partial()` only makes keys
 * optional, it does NOT strip the inner `.default()`s — so an omitted field
 * would still parse to its create default and, fed to a PATCH/upsert update,
 * would OVERWRITE the stored value with a default (thread 10). Instead every
 * field is unwrapped to `.optional()` with no default, so an omitted key stays
 * `undefined` and the service leaves that column untouched. `sourceId` is
 * intentionally omitted — the desktop-source identity is a create/upsert key,
 * never patched.
 */
export const updateRoutineInputSchema = z.object({
  teamId: z.string().uuid().nullish(),
  name: z.string().min(1).max(ROUTINE_SHORT_TEXT_MAX).optional(),
  description: z.string().max(ROUTINE_LONG_TEXT_MAX).optional(),
  instructions: z.string().max(ROUTINE_LONG_TEXT_MAX).optional(),
  ownerId: z.string().uuid().nullish(),
  ownerName: z.string().max(ROUTINE_SHORT_TEXT_MAX).nullish(),
  provider: routineProviderSchema.optional(),
  modelId: z.string().min(1).max(ROUTINE_SHORT_TEXT_MAX).optional(),
  runsOn: routineRunsOnSchema.optional(),
  origin: routineOriginSchema.optional(),
  status: routineStatusSchema.optional(),
  scheduleKind: routineScheduleKindSchema.optional(),
  scheduleDetail: z.string().max(ROUTINE_SHORT_TEXT_MAX).optional(),
  cron: z.string().max(ROUTINE_SHORT_TEXT_MAX).nullish(),
  timezone: z.string().max(ROUTINE_SHORT_TEXT_MAX).optional(),
  enabled: z.boolean().optional(),
  notifyMode: routineNotifyModeSchema.optional(),
  folderOrRepo: z.string().max(ROUTINE_SHORT_TEXT_MAX).nullish(),
  project: z.string().max(ROUTINE_SHORT_TEXT_MAX).nullish(),
  runsIn: routineRunsInSchema.nullish(),
  hostMachine: z.string().max(ROUTINE_SHORT_TEXT_MAX).nullish(),
  connectorIds: z
    .array(z.string().max(ROUTINE_SHORT_TEXT_MAX))
    .max(ROUTINE_ID_LIST_MAX)
    .optional(),
  autoFixPullRequests: z.boolean().optional(),
  permissionMode: z.string().max(ROUTINE_SHORT_TEXT_MAX).nullish(),
  reasoningEffort: z.string().max(ROUTINE_SHORT_TEXT_MAX).nullish(),
  worktree: z.boolean().optional(),
  route: z.string().max(ROUTINE_SHORT_TEXT_MAX).nullish(),
  harnessCascade: z
    .array(cascadeStepInputSchema)
    .max(ROUTINE_ATTEMPT_LIST_MAX)
    .optional(),
  catchUp: z.boolean().optional(),
  recurring: z.boolean().optional(),
  durable: z.boolean().optional(),
  passKind: z.string().max(ROUTINE_SHORT_TEXT_MAX).nullish(),
  pass: z.string().max(ROUTINE_SHORT_TEXT_MAX).nullish(),
  crew: z.string().max(ROUTINE_SHORT_TEXT_MAX).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateRoutineInput = z.infer<typeof updateRoutineInputSchema>;

/**
 * Record-run input — the persistence shape for one routine run, mapping 1:1 to
 * the crewd `RunRecord`. `startedAt`/`finishedAt` are ISO strings on the wire.
 * Every free-text field and collection is bounded (see the payload-bounds block
 * above) so a run row can't be used as unbounded storage. `sourceRunId` carries
 * the crewd `RunRecord.id` so re-delivering the same run is idempotent per org
 * (org-scoped upsert) and a RUNNING row can transition to its terminal state
 * rather than inserting a duplicate.
 */
export const recordRoutineRunInputSchema = z.object({
  sourceRunId: z.string().max(ROUTINE_SHORT_TEXT_MAX).nullish(),
  taskName: z.string().max(ROUTINE_SHORT_TEXT_MAX).nullish(),
  status: routineRunStatusSchema.default(RoutineRunStatus.Pending),
  startedAt: z.string().datetime({ offset: true }).optional(),
  finishedAt: z.string().datetime({ offset: true }).nullish(),
  provider: routineProviderSchema.nullish(),
  modelId: z.string().max(ROUTINE_SHORT_TEXT_MAX).nullish(),
  summary: z.string().max(ROUTINE_LONG_TEXT_MAX).default(""),
  error: z.string().max(ROUTINE_LONG_TEXT_MAX).nullish(),
  logPath: z.string().max(ROUTINE_SHORT_TEXT_MAX).nullish(),
  sessionId: z.string().max(ROUTINE_SHORT_TEXT_MAX).nullish(),
  sessionIds: z
    .array(z.string().max(ROUTINE_SHORT_TEXT_MAX))
    .max(ROUTINE_ID_LIST_MAX)
    .default([]),
  invokedComponents: z
    .array(invokedComponentSchema)
    .max(ROUTINE_COMPONENT_LIST_MAX)
    .default([]),
  attempts: z
    .array(routineRunAttemptSchema)
    .max(ROUTINE_ATTEMPT_LIST_MAX)
    .default([]),
});
export type RecordRoutineRunInput = z.infer<typeof recordRoutineRunInputSchema>;

/** Max run-history rows retained per routine (bounded; older rows swept). */
export const ROUTINE_RUN_HISTORY_CAP = 100;
