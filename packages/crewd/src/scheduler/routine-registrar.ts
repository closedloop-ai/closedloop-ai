/**
 * RoutineRegistrar — the cloud-routine registration seam (FEA-3816 / PRD-553 M4).
 *
 * When a task's capability-broker route is flipped to `claude-routine`
 * (`TaskRoute.ClaudeRoutine` — a `NativeSchedule.CloudRoutine`), the daemon must
 * register it with the Claude cloud routine service instead of running it
 * locally through the cascade; when it flips back to `local-cascade`, the cloud
 * routine must be deregistered so the local daemon owns its timing again. This
 * port is that boundary.
 *
 * ── Why a port, not a concrete client ──────────────────────────────────────
 * There is no in-repo cloud-routine registration API yet — the ClosedLoop REST
 * client (`clients/closedloop.ts`) has no routine endpoint, and no `/schedule`
 * cloud-routine capability ships in this monorepo. So the crewd core owns only
 * the *seam*: an injectable interface the store calls at the flip. The desktop
 * host injects a concrete (currently no-op-logging) implementation; when the
 * cloud routine API lands, wiring it is a one-file change at the injection site,
 * not a change to the store or the daemon. Keeping this transport-neutral (model
 * types only, no `node:` imports) preserves the renderer-safe root barrel.
 *
 * The registrar is best-effort by contract: an implementation must resolve (not
 * reject) so a routine-service outage can never wedge a store mutation — the
 * persisted `route` is the source of truth for the operator's choice regardless
 * of whether the remote registration round-trips.
 */
import type { ScheduledTask } from "../model.js";

/** The outcome of a register/deregister attempt (best-effort; never throws). */
export type RoutineRegistrationResult = {
  /** True when the cloud routine service accepted the (de)registration. */
  ok: boolean;
  /**
   * The cloud routine id assigned on a successful `register`, so the task's
   * `meta` can link back to it. Null on deregister or on failure.
   */
  routineId: string | null;
  /** A human-readable note for diagnostics (e.g. why a stub did nothing). */
  note: string;
};

/**
 * The cloud-routine registration boundary. Both methods are best-effort: they
 * resolve with `ok:false` on failure rather than rejecting, so the store's flip
 * is never wedged by a routine-service problem.
 */
export type RoutineRegistrar = {
  /** Register a task as a Claude cloud routine (route → `claude-routine`). */
  register(task: ScheduledTask): Promise<RoutineRegistrationResult>;
  /** Deregister a task's cloud routine (route → `local-cascade`, or delete). */
  deregister(task: ScheduledTask): Promise<RoutineRegistrationResult>;
};

/**
 * A no-op stub registrar. It records the intent (via the optional `log` sink)
 * and reports `ok:false` with a clear "not wired" note — the honest state until
 * the cloud routine API exists. Injected by default so the flip path is
 * exercised end-to-end (the `route` still persists) without a real backend.
 */
export function createStubRoutineRegistrar(
  log: (message: string) => void = () => {
    /* no-op */
  }
): RoutineRegistrar {
  const notWired = (verb: string, task: ScheduledTask) => {
    log(
      `routine-registrar (stub): ${verb} '${task.name}' (${task.id}) — cloud routine API not wired; persisted route only`
    );
    return Promise.resolve<RoutineRegistrationResult>({
      ok: false,
      routineId: null,
      note: "cloud routine registration not wired (stub)",
    });
  };
  return {
    register: (task) => notWired("register", task),
    deregister: (task) => notWired("deregister", task),
  };
}

/**
 * The outcome of a native-scheduler register/deregister attempt (FEA-3958).
 * Best-effort by the same contract as {@link RoutineRegistrationResult}: an
 * implementation resolves (never rejects) so a scheduler-side problem can never
 * wedge a store mutation — the persisted `route` stays authoritative.
 *
 * A DISCRIMINATED union on `ok` so a *successful register* cannot type-check
 * without a non-empty `ownerId`: the store keys the daemon's local-run
 * suppression off that owner id, and an `ok:true` with no owner id would silently
 * confirm nothing and leave the task eligible in BOTH schedulers. The `owned`
 * success variant carries the id (register); the `settled` success variant is the
 * ownerless success a deregister returns; the `failed` variant carries the note.
 */
export type ScheduledTasksRegistrationResult =
  | {
      ok: true;
      /**
       * The native-owner id the scheduler assigned. For `claude-scheduled-tasks`
       * this is the id written into `~/.claude/scheduled_tasks.json`, so the
       * task's `meta` can link back to it and the daemon suppresses its local
       * run. Present on a successful `register`.
       */
      ownerId: string;
      note?: string;
    }
  | {
      /** A successful `deregister` (or any success with no owner to stamp). */
      ok: true;
      ownerId?: undefined;
      note?: string;
    }
  | {
      ok: false;
      /** A human-readable note for diagnostics (e.g. why a stub did nothing). */
      note: string;
    };

/**
 * The native local-scheduler registration boundary (FEA-3958) — the sibling of
 * {@link RoutineRegistrar} for the `claude-scheduled-tasks` route. When a task's
 * broker route is flipped to `claude-scheduled-tasks`, the desktop host injects a
 * concrete implementation (`ScheduledTasksWriter`) that materializes the task
 * into Claude Code's local `~/.claude/scheduled_tasks.json`; on the reverse flip
 * (or delete) it removes that entry so our daemon owns the timing again. Both
 * methods are best-effort: they resolve with `ok:false` on failure rather than
 * rejecting, so a filesystem problem never wedges the store's flip.
 */
export type ScheduledTasksRegistrar = {
  /** Materialize a task into the native scheduler (route → `claude-scheduled-tasks`). */
  register(task: ScheduledTask): Promise<ScheduledTasksRegistrationResult>;
  /** Remove a task from the native scheduler (route → local-cascade, or delete). */
  deregister(task: ScheduledTask): Promise<ScheduledTasksRegistrationResult>;
};
