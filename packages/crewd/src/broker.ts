/**
 * Capability-aware scheduling broker.
 *
 * Per job we decide WHERE the schedule lives: prefer a harness's bare-metal
 * scheduler when it exists (Claude Code's scheduled_tasks / cloud routines),
 * otherwise our own daemon owns the timing and runs the job through the cascade.
 * Codex and opencode have no native scheduler, so they are always daemon-driven.
 * This is the "broker to Claude's scheduled tasks, do something else for
 * codex/opencode" split.
 *
 * FEA-4048 flipped the DEFAULT: a task whose primary harness has a real native
 * scheduler (`nativeSchedule !== None`) now routes NATIVE by default, with the
 * daemon cascade as the FALLBACK — not the other way around. This is what lets
 * the night crew (cl-produce / cl-ci-babysit / apply-nightly-reviews) be fired
 * by the harness's own scheduler "w/o our cron being required" once Slice A's
 * writer (`@repo/crewd` `ScheduledTasksRegistrar` → `~/.claude/scheduled_tasks.json`)
 * is wired. An operator can force the daemon anyway with `policy.forceDaemon`.
 *
 * SAFETY: this is only the DERIVED route (an intent). Executable suppression of
 * the local run keys off a task's persisted `TaskRoute` AND a CONFIRMED native
 * owner (`hasConfirmedNativeOwner`), not this decision — so an unconfirmed native
 * default (registration failed / unwired) still runs locally, never nowhere. The
 * daemon route stays the backup that never double-fires a confirmed-native slot.
 */

import { nativeScheduleOf } from "./harness/capabilities.js";
import type { HarnessRegistry } from "./harness/index.js";
import {
  type CascadeStep,
  type HarnessName,
  NativeSchedule,
  type ScheduledTask,
  TaskRoute,
} from "./model.js";

export const ScheduleRoute = {
  /** Our daemon holds the schedule and runs the cascade. */
  DaemonCascade: "daemon-cascade",
  /** Register with Claude Code's native scheduled_tasks / routine. */
  ClaudeNative: "claude-native",
} as const;
export type ScheduleRoute = (typeof ScheduleRoute)[keyof typeof ScheduleRoute];

export type BrokerPolicy = {
  /**
   * Force the daemon-cascade route even when the primary harness could schedule
   * natively (FEA-4048 opt-out). Native is the default; set this to keep a task
   * daemon-owned regardless of its harness's native capability.
   */
  forceDaemon?: boolean;
  registry?: HarnessRegistry;
};

export type RouteDecision = {
  route: ScheduleRoute;
  /**
   * The concrete native capability the head harness reported (or
   * `NativeSchedule.None` for a daemon-owned decision). Carried so the
   * persisted-route mapping ({@link defaultTaskRoute}) can distinguish Claude
   * Code's LOCAL `scheduled_tasks.json` capability from a cloud routine instead
   * of collapsing every native kind onto one route — a `CloudRoutine` capability
   * must never be sent to the local scheduled-tasks writer.
   */
  nativeSchedule: NativeSchedule;
  reason: string;
};

/**
 * The minimal task shape the broker routes on: only the cascade head matters, so
 * both {@link decideRoute} and {@link defaultTaskRoute} accept this narrow view.
 * This lets a caller derive a route BEFORE a full task exists (e.g. the CLI `add`
 * path, which knows only the cascade) without an `as ScheduledTask` cast.
 */
export type RoutableTask = Pick<ScheduledTask, "harnessCascade">;

/** First harness in a task's cascade (or the global default order's head). */
export function primaryHarness(
  task: RoutableTask,
  fallback: readonly CascadeStep[]
): HarnessName | undefined {
  return (task.harnessCascade[0] ?? fallback[0])?.harness;
}

export function decideRoute(
  task: RoutableTask,
  defaultCascade: readonly CascadeStep[],
  policy: BrokerPolicy = {}
): RouteDecision {
  if (policy.forceDaemon) {
    return {
      route: ScheduleRoute.DaemonCascade,
      nativeSchedule: NativeSchedule.None,
      reason: "policy: forceDaemon — daemon owns the schedule",
    };
  }
  const head = primaryHarness(task, defaultCascade);
  // Prefer an injected registry's live capabilities when provided; otherwise
  // read the pure capability map (no concrete drivers ⇒ no `node:` imports, so
  // the broker — and the root barrel that re-exports it — stays renderer-safe).
  const cap = head
    ? (policy.registry?.[head]?.capabilities.nativeSchedule ??
      nativeScheduleOf(head))
    : NativeSchedule.None;
  // FEA-4048: native-by-default. A primary harness that can natively schedule
  // owns the timing; the daemon cascade is the fallback for harnesses that
  // cannot (codex/opencode → `None`) or when the cascade has no head at all.
  if (cap !== NativeSchedule.None) {
    return {
      route: ScheduleRoute.ClaudeNative,
      nativeSchedule: cap,
      reason: `${head} supports ${cap} (native by default)`,
    };
  }
  return {
    route: ScheduleRoute.DaemonCascade,
    nativeSchedule: NativeSchedule.None,
    reason: head
      ? `${head} has no native scheduler`
      : "no primary harness — daemon owns the schedule",
  };
}

/**
 * The persisted {@link TaskRoute} a task should DEFAULT to, derived from the
 * broker's capability-aware {@link decideRoute} (FEA-4048). Maps the CONCRETE
 * {@link NativeSchedule} the decision carries — NOT the collapsed
 * {@link ScheduleRoute} — onto the operator-facing route the store persists, so a
 * cloud capability is never mis-sent to the LOCAL scheduled-tasks writer:
 *   - `ClaudeScheduledTasks` (Claude Code's LOCAL scheduler) ⇒
 *     `TaskRoute.ClaudeScheduledTasks` — the local scheduler owns the timing,
 *     materialized by the desktop/CLI `ScheduledTasksRegistrar`.
 *   - `CloudRoutine` ⇒ `TaskRoute.LocalCascade` — the cloud routine path is
 *     OPT-IN only (FEA-4048 defaults native-LOCAL, never native-cloud), so a
 *     cloud-capable primary harness stays daemon-owned unless an operator/UI
 *     explicitly chooses `claude-routine`. This is what keeps a cloud capability
 *     out of the local `scheduled_tasks.json` writer.
 *   - `None` (codex/opencode, `forceDaemon`, no head) ⇒ `TaskRoute.LocalCascade`.
 *
 * This is the seam the CLI `add` path applies when a caller did NOT explicitly
 * pass `--route`, so a Claude-primary night-crew task lands on the native route
 * by default (FEA-4048) while an explicit `--route` still wins. The Desktop
 * editor does NOT yet apply this default — it initializes a new task to
 * `local-cascade` and only exposes the daemon / cloud-routine choice — so a task
 * created from that surface stays daemon-owned; wiring the capability-aware
 * default into the editor (which first needs a `claude-scheduled-tasks` option
 * in the picker) is a follow-up. SAFETY unchanged: this only sets the persisted
 * INTENT — the daemon still runs the task locally until a native owner is
 * confirmed.
 */
export function defaultTaskRoute(
  task: RoutableTask,
  defaultCascade: readonly CascadeStep[],
  policy: BrokerPolicy = {}
): TaskRoute {
  const { nativeSchedule } = decideRoute(task, defaultCascade, policy);
  switch (nativeSchedule) {
    case NativeSchedule.ClaudeScheduledTasks:
      return TaskRoute.ClaudeScheduledTasks;
    // Cloud is OPT-IN only — never auto-derived — so fall back to the daemon.
    case NativeSchedule.CloudRoutine:
      return TaskRoute.LocalCascade;
    case NativeSchedule.None:
      return TaskRoute.LocalCascade;
    default: {
      // Exhaustiveness: a new NativeSchedule kind must be mapped here explicitly
      // (fails typecheck until it is), so a future capability can never silently
      // fall through to the wrong persisted route.
      const _exhaustive: never = nativeSchedule;
      return _exhaustive;
    }
  }
}
