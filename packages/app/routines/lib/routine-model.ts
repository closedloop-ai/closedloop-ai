/**
 * The cross-provider `Routine` domain model (FEA-4349 / PRD-566).
 *
 * A Routine is a scheduled agent run — a superset of the two references it
 * unifies: Claude Code's local scheduled tasks and Codex's cloud scheduled
 * tasks. Provider-conditional fields (permission mode, worktree, connectors,
 * auto-fix, reasoning effort, folder-vs-project context) are gated by
 * `providerCapabilities` in `./routine-provider`, not by ad-hoc provider-id
 * checks. Faithful to the frozen prototype at
 * `apps/prototypes/app/p/routines/mock.ts`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * crewd `ScheduledTask` → `Routine` superset mapping (FEA-4358 wires this;
 * this change only DOCUMENTS the relationship — it does not implement any
 * conversion).
 *
 * The crewd scheduler (`packages/crewd/src/model.ts`, `scheduledTaskSchema`)
 * is the existing durable model for locally-scheduled crew passes. `Routine`
 * is a strict SUPERSET of it: every scheduled task maps onto a Routine, but
 * Routine adds the Codex/cloud dimensions and the richer UI config surface.
 * Reconcile, do not fork — when FEA-4358 wires the two, a `ScheduledTask`
 * becomes a `Routine`, never a parallel model.
 *
 *   ScheduledTask field            → Routine field
 *   ───────────────────────────────  ──────────────────────────────────────
 *   id                             → id
 *   name                           → name
 *   prompt                         → instructions (Claude-compat free text)
 *   cron                           → cron (canonical 5-field expression — the
 *                                     SSOT for timing; scheduleKind +
 *                                     scheduleDetail are DERIVED display only)
 *   timezone                       → timezone (IANA zone — preserved verbatim so
 *                                     fire time + DST behavior survive round-trip)
 *   enabled                        → status (enabled ⇒ Active, else Paused;
 *                                     Draft has no ScheduledTask equivalent)
 *   harnessCascade                 → harnessCascade (the FULL ordered fallback
 *                                     sequence, preserved losslessly; provider +
 *                                     modelId are the DERIVED primary-step view of
 *                                     harnessCascade[0]. opencode is a valid cascade
 *                                     EXECUTION harness even though it has no
 *                                     Routine PROVIDER surface yet)
 *   harnessCascade[0].harness      → provider (primary-step derived view)
 *   harnessCascade[0].model        → modelId (primary-step derived view)
 *   route (local-cascade / claude- → runsOn (LocalCascade ⇒ Local; a cloud
 *     routine / claude-scheduled…)   routine ⇒ Cloud)
 *   crew                           → owner (crew subdir ↔ owning operator)
 *   nextRunAt                      → nextRun (Routine carries a display string;
 *     lastRunAt                      ScheduledTask carries ISO — FEA-4358 owns
 *     lastRunId                      the format bridge)
 *                                   → lastRun / lastRunSessionId
 *   lastStatus / RunRecord[]       → (run history; modeled elsewhere)
 *   meta (open bag)                → (Routine promotes several ex-`meta`
 *                                     concerns to first-class fields below)
 *
 *   Routine-only (no ScheduledTask counterpart — the superset delta):
 *     description, origin, hostMachine, connectorIds, autoFixPullRequests,
 *     permissionMode, reasoningEffort, worktree, folderOrRepo, project,
 *     runsIn, notifyMode, invokedComponents, sessionIds.
 *
 *   Codex-side reference: Routine also subsumes Codex's cloud Scheduled Tasks
 *   (project + runsIn + reasoningEffort) which crewd's ScheduledTask never
 *   modeled — this is the other half of the superset.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * NOTE — const-object enums, never TS `enum` or arrays; new declarations at
 * the bottom of the file.
 */

import { AgentComponentInvocationKind } from "@repo/api/src/types/agent-component-invocation";
import type {
  NotifyMode,
  PermissionMode,
  ReasoningEffort,
  RoutineProvider,
  RunsIn,
} from "./routine-provider";

/**
 * One ordered step in a routine's harness cascade — the (harness, model)
 * primitive that carries the full fallback sequence a crewd `ScheduledTask`
 * persists in its `harnessCascade` (`packages/crewd/src/model.ts`,
 * `CascadeStep`). A Routine preserves EVERY step so a primary-provider failure
 * still cascades to the configured fallbacks; `provider`/`modelId` below are
 * only the derived view of `harnessCascade[0]`.
 *
 * `harness` is a bare string, not `RoutineProvider`: the cascade can drive
 * execution harnesses (e.g. `opencode`) that have no Routine PROVIDER config
 * surface yet. Unknown/new harnesses must round-trip verbatim rather than being
 * dropped — the provider-config surface is gated by `providerCapabilities`, but
 * the execution cascade is not a closed set.
 */
export type RoutineCascadeStep = {
  harness: string;
  /** Model to drive this step's harness with; null ⇒ the harness default. */
  modelId: string | null;
};

export const ScheduleKind = {
  Manual: "manual",
  Hourly: "hourly",
  Daily: "daily",
  Weekdays: "weekdays",
  Weekly: "weekly",
  Custom: "custom",
} as const;
export type ScheduleKind = (typeof ScheduleKind)[keyof typeof ScheduleKind];

export const scheduleLabel: Record<ScheduleKind, string> = {
  [ScheduleKind.Manual]: "Manual",
  [ScheduleKind.Hourly]: "Hourly",
  [ScheduleKind.Daily]: "Daily",
  [ScheduleKind.Weekdays]: "Weekdays",
  [ScheduleKind.Weekly]: "Weekly",
  [ScheduleKind.Custom]: "Custom",
};

export const RoutineStatus = {
  Active: "active",
  Paused: "paused",
  Draft: "draft",
} as const;
export type RoutineStatus = (typeof RoutineStatus)[keyof typeof RoutineStatus];

export const routineStatusLabel: Record<RoutineStatus, string> = {
  [RoutineStatus.Active]: "Active",
  [RoutineStatus.Paused]: "Paused",
  [RoutineStatus.Draft]: "Draft",
};

/**
 * A routine is either built by hand in this UI, or discovered: found already
 * configured on a teammate's dev machine and reported up centrally so the whole
 * team can see it exists. (The sync/report-up mechanism itself is out of scope
 * here — only its effect on the model is captured.)
 */
export const RoutineOrigin = {
  Created: "created",
  Discovered: "discovered",
} as const;
export type RoutineOrigin = (typeof RoutineOrigin)[keyof typeof RoutineOrigin];

/** Where a routine executes: on the operator's machine, or in the cloud. */
export const RunsOn = {
  Local: "local",
  Cloud: "cloud",
} as const;
export type RunsOn = (typeof RunsOn)[keyof typeof RunsOn];

/**
 * The kind of component a routine run invoked (for run-trace drill-down).
 *
 * This is an INTENTIONAL SUBSET of the canonical `AgentComponentInvocationKind`
 * (`@repo/api`), not a parallel re-declaration: the Routine "last run"
 * drill-down only surfaces the three user-authored component kinds. The other
 * four canonical kinds (`tool`, `mcp`, `orchestration`, `hook`) are runtime
 * plumbing the routine summary deliberately omits. Because `ComponentKind` is
 * derived from the canonical const, a real invocation row must be run through
 * `narrowInvokedComponentKind` to project onto this subset — the four omitted
 * kinds map to `null` and are dropped, rather than being silently cast.
 */
export const routineComponentKinds = [
  AgentComponentInvocationKind.Subagent,
  AgentComponentInvocationKind.Command,
  AgentComponentInvocationKind.Skill,
] as const;
export type ComponentKind = (typeof routineComponentKinds)[number];

/**
 * The subset members re-exported under the local `ComponentKind` name so
 * consumers (and tests) keep a stable const reference. Values are the canonical
 * `AgentComponentInvocationKind` members — never re-typed string literals.
 */
export const ComponentKind = {
  Subagent: AgentComponentInvocationKind.Subagent,
  Command: AgentComponentInvocationKind.Command,
  Skill: AgentComponentInvocationKind.Skill,
} as const satisfies Record<string, ComponentKind>;

/** One component (subagent / command / skill) a routine's last run invoked. */
export type InvokedComponent = {
  id: string;
  name: string;
  kind: ComponentKind;
  /** False when the component is not yet in the committed agents catalog. */
  cataloged: boolean;
};

/**
 * The cross-provider Routine. Provider-conditional fields (`folderOrRepo` vs
 * `project`/`runsIn`, `connectorIds`, `autoFixPullRequests`, `permissionMode`,
 * `reasoningEffort`, `worktree`) are meaningful only when the routine's
 * provider supports them per `providerCapabilities`; they are nullable / empty
 * where the provider hides the corresponding surface.
 */
export type Routine = {
  id: string;
  name: string;
  description: string;
  owner: string;
  /**
   * The primary step's harness, as a Routine provider — the derived view of
   * `harnessCascade[0]`. The lossless fallback sequence lives in
   * `harnessCascade`; this is the convenience accessor the config surface reads.
   */
  provider: RoutineProvider;
  /** The primary step's model — the derived view of `harnessCascade[0].modelId`. */
  modelId: string;
  /**
   * The FULL ordered harness cascade (primary + every fallback), preserved
   * losslessly from a crewd `ScheduledTask` so a primary-provider failure still
   * cascades as configured. `provider`/`modelId` above are `[0]`'s derived view.
   */
  harnessCascade: readonly RoutineCascadeStep[];
  runsOn: RunsOn;
  instructions: string;
  /** "folder" providers (Claude): a local path or repo string. */
  folderOrRepo: string | null;
  /** "project" providers (Codex): a named workspace. */
  project: string | null;
  /** "project" providers (Codex): new vs existing chat continuity. */
  runsIn: RunsIn | null;
  /**
   * The canonical 5-field cron expression — the SSOT for when this routine
   * fires, preserved verbatim from a crewd `ScheduledTask.cron`. `scheduleKind`
   * and `scheduleDetail` are DERIVED display of this value; null only for
   * routines with no recurring schedule (e.g. Manual/run-on-demand).
   */
  cron: string | null;
  /**
   * The IANA timezone the `cron` is evaluated in (e.g. `America/Chicago`),
   * preserved verbatim so fire time and DST behavior survive a round-trip
   * instead of falling back to the host zone. Null ⇒ evaluate in the host zone.
   */
  timezone: string | null;
  /** Derived display of `cron`: the closest preset kind, or Custom for an arbitrary expression. */
  scheduleKind: ScheduleKind;
  /** Derived human-readable schedule prose (rendered by the templates); not a source of truth. */
  scheduleDetail: string;
  notifyMode: NotifyMode;
  status: RoutineStatus;
  origin: RoutineOrigin;
  /** Set for discovered routines: the machine they were found configured on. */
  hostMachine: string | null;
  connectorIds: readonly string[];
  autoFixPullRequests: boolean;
  /**
   * Claude routines only: the permission mode DOMAIN value (the Claude Code SDK
   * wire token, e.g. `acceptEdits`), typed from `PermissionMode` so a display
   * label can never be persisted here. Null where the provider has no permission
   * concept (Codex) or the routine inherits the settings default.
   */
  permissionMode: PermissionMode | null;
  /**
   * Codex routines only: the reasoning-effort DOMAIN value forwarded to
   * `model_reasoning_effort`, typed from `ReasoningEffort` so a display label
   * ("Extra High") can never be persisted here. Null where the provider has no
   * reasoning-effort concept (Claude).
   */
  reasoningEffort: ReasoningEffort | null;
  worktree: boolean;
  lastRun: string | null;
  lastRunSessionId: string | null;
  nextRun: string | null;
  /** What the last run invoked — empty for routines that don't model this. */
  invokedComponents: readonly InvokedComponent[];
  sessionIds: readonly string[];
};

/**
 * A starter template for the empty-state gallery — a preconfigured routine
 * shape a user can adopt as a starting point.
 */
export type RoutineTemplate = {
  id: string;
  label: string;
  description: string;
  scheduleDetail: string;
  provider: RoutineProvider;
};

/**
 * Projects a canonical `AgentComponentInvocationKind` from a real invocation row
 * onto the Routine drill-down subset (`ComponentKind`). Returns the narrowed
 * value for the three surfaced kinds, or `null` for the four the routine summary
 * omits (`tool`, `mcp`, `orchestration`, `hook`) so callers explicitly drop them
 * instead of casting an out-of-subset kind into `InvokedComponent`.
 */
export function narrowInvokedComponentKind(
  kind: AgentComponentInvocationKind
): ComponentKind | null {
  return (
    routineComponentKinds as readonly AgentComponentInvocationKind[]
  ).includes(kind)
    ? (kind as ComponentKind)
    : null;
}
