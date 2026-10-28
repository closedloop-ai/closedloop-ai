/**
 * @file db-host-restart-budget.ts
 * @description ISS-8776 — the CEILING on the db-host restart ladder.
 *
 * `DbHostClient` re-forks the db-host child after an unexpected exit, and until
 * this module existed it did so FOREVER. FEA-3072 escalates the delay between
 * attempts (base 1 s, doubling, capped at 30 s) but escalation is not a bound:
 * a host that can never come back was retried for the life of the process, and
 * the spawn-failure retry re-armed without even registering a crash, so it
 * looped at whatever delay the last real crash had computed.
 *
 * The incident that named it: an unhandled `DbHostExitError` reached the global
 * handler, which calls `app.exit(1)`. `app.exit()` skips `before-quit`, so the
 * graceful shutdown that would have opened the intentional-teardown window
 * (`beginClosing()`) never ran. The supervisor therefore saw the teardown's own
 * child exit as UNEXPECTED and re-forked into a process that was already going
 * away — `db-host exited unexpectedly (code: 0)` immediately followed by
 * `db-host restart failed, retrying`, with nothing to stop it.
 *
 * ## Why a cap and not just a longer backoff
 *
 * The two answer different questions. Backoff answers "how hard am I hammering
 * a host that might recover"; the cap answers "how long do I keep asserting
 * that recovery is still coming". `DbHostExitError.restartScheduled` is the
 * field every consumer reads to decide whether to re-drive, so a ladder with no
 * terminal state makes that field permanently `true` — the client keeps
 * promising a replacement it will never successfully produce, and callers keep
 * re-driving against it. A ceiling is what turns that into an honest `false`.
 *
 * ## Sizing
 *
 * Eight attempts against the FEA-3072 ladder (1 s, 2 s, 4 s, 8 s, 16 s, then
 * the 30 s cap) spans roughly two minutes of real recovery effort — well past
 * any transient the supervisor exists to absorb (a bounce under memory
 * pressure, a zombie holder released by the reaper, an OS-level kill) and far
 * short of the indefinite churn above. It is deliberately NOT derived from the
 * backoff constants: a cap expressed as "however many attempts fit in N
 * seconds" changes silently whenever someone tunes the delay, which is exactly
 * the kind of coupling that makes a bound stop being a bound.
 */

import {
  type AgentMonitorRuntimeStatus,
  AgentMonitorRuntimeStatusKind,
} from "../../../shared/agent-monitor-status.js";
import { DbHostExitError } from "../../../shared/db-host-exit-error.js";
import { exponentialBackoffMs } from "../../../shared/exponential-backoff.js";

/**
 * Backoff before re-forking a crashed child, so a crash-on-start can't
 * tight-loop.
 */
export const RESTART_BACKOFF_MS = 1000;

/**
 * FEA-3072 — crash-storm guard. When the child crashes on a request the
 * renderer polls (dashboard get-insights), a fixed 1 s backoff re-forks into
 * the SAME slamming load and the process crashes again ~1×/s indefinitely.
 * Escalate the backoff with the number of crashes seen inside this rolling
 * window so a persistent crash degrades to widely-spaced retries (giving
 * backfill/sync room to drain between reads) instead of a hot loop.
 * Self-resets: once crashes age out of the window a lone crash restarts at the
 * base backoff again.
 */
export const CRASH_WINDOW_MS = 60_000;
const MAX_RESTART_BACKOFF_MS = 30_000;

/**
 * Record this crash into `recentCrashes`, prune the ones older than
 * {@link CRASH_WINDOW_MS}, and return the delay before the next attempt.
 *
 * MUTATES `recentCrashes` — it is the supervisor's own rolling window, passed
 * in rather than re-created, so the escalation survives across calls while the
 * arithmetic stays here with the ceiling it works alongside.
 *
 * ISS-5808: built on the SHARED ladder (`exponentialBackoffMs`), not a
 * hand-rolled `BASE * 2 ** n`. The sync-lane contract (`main/sync/AGENTS.md`,
 * invariant 5) requires every bounded retry path in the desktop to back off on
 * that one helper precisely so copies cannot drift. The helper is 1-indexed and
 * `recentCrashes.length` is the 1-indexed crash number, and its own exponent
 * clamp sits far above the point {@link MAX_RESTART_BACKOFF_MS} binds.
 */
export function registerCrashAndComputeBackoff(
  recentCrashes: number[],
  nowMs: number
): number {
  recentCrashes.push(nowMs);
  while (
    recentCrashes.length > 0 &&
    nowMs - recentCrashes[0] > CRASH_WINDOW_MS
  ) {
    recentCrashes.shift();
  }
  return exponentialBackoffMs(
    recentCrashes.length,
    RESTART_BACKOFF_MS,
    MAX_RESTART_BACKOFF_MS
  );
}

/**
 * The delay before restart attempt number `attempt`, on the same ladder.
 *
 * ISS-8776 — for the SPAWN-FAILURE retry, which never reaches
 * {@link registerCrashAndComputeBackoff} because no child exit was observed. It
 * had therefore been re-arming at whatever delay the last real crash computed:
 * a fixed-delay retry wearing a ladder's name. Keyed on the attempt count so
 * the crash-window ladder above — which answers a different question — is left
 * exactly as it is.
 */
export function restartAttemptBackoffMs(attempt: number): number {
  return exponentialBackoffMs(
    attempt,
    RESTART_BACKOFF_MS,
    MAX_RESTART_BACKOFF_MS
  );
}

/**
 * How many times the ladder may arm a restart before it gives up.
 *
 * Counted per HEALTHY-RUN, not per process: a spawn that produces a live child
 * resets the tally, so an app that bounces once an hour all day never
 * approaches the cap. Only a run of consecutive failures does.
 */
export const MAX_DB_HOST_RESTART_ATTEMPTS = 8;

/** {@link evaluateRestartBudget}'s answer. */
export type RestartBudgetVerdict = {
  /** Arm another attempt. False means the ladder is finished. */
  readonly arm: boolean;
  /** The attempt number this verdict authorizes, or the final tally when `arm` is false. */
  readonly attempt: number;
};

/**
 * May the ladder arm attempt number `attemptsSoFar + 1`?
 *
 * Pure and exported so the ceiling is executed against synthetic inputs rather
 * than inferred from the supervisor's timer bookkeeping — the same reason
 * `evaluateRenderProcessGone` is a free function beside `DesktopWindow`.
 *
 * A negative or non-finite tally cannot be produced by the caller's own counter
 * and is treated as exhausted rather than coerced: this is the last guard
 * between a broken counter and an infinite loop, so the failure it must not
 * have is the permissive one.
 */
export function evaluateRestartBudget(
  attemptsSoFar: number
): RestartBudgetVerdict {
  if (!Number.isFinite(attemptsSoFar) || attemptsSoFar < 0) {
    return { arm: false, attempt: MAX_DB_HOST_RESTART_ATTEMPTS };
  }
  if (attemptsSoFar >= MAX_DB_HOST_RESTART_ATTEMPTS) {
    return { arm: false, attempt: attemptsSoFar };
  }
  return { arm: true, attempt: attemptsSoFar + 1 };
}

/**
 * The log line for a ladder that has given up.
 *
 * Names the tally and the last exit code because those are what a triage read
 * needs, and states the terminal consequence explicitly — a "gave up" line that
 * does not say the store is now unavailable reads like one more retry notice.
 */
export function describeRestartExhausted(
  attempts: number,
  lastExitCode: number | null
): string {
  return `db-host restart ladder exhausted after ${attempts} attempt(s) (last exit code: ${lastExitCode ?? "null"}); the local store is unavailable for the rest of this session`;
}

/**
 * The user-facing terminal reason, routed through the runtime's existing
 * `onTerminalFailure` channel (an Agent Monitor notification plus the tray
 * state) — the same surface a boot-time DB refusal already uses.
 *
 * Deliberately free of codes, paths, and counts: it is displayed verbatim, and
 * the actionable half for a user is that reopening the app is what fixes it.
 */
export const DB_HOST_RESTART_EXHAUSTED_USER_REASON =
  "Closedloop's local database stopped responding and could not be restarted. Quit and reopen the app.";

/**
 * The renderer-facing runtime status once the ladder is finished (davetho,
 * #6432).
 *
 * `onTerminalFailure` above drives the notification and the tray; neither
 * touches `desktop:get-runtime-status`, which the renderer branches on. Without
 * this the status stays wherever the boot left it — `ready`, once the store had
 * once come up — so exhaustion AFTER a healthy boot leaves every runtime-status
 * consumer reading healthy while the local store is gone for the rest of the
 * session.
 *
 * `dbAhead` is false and must stay so: that flag drives the "update required —
 * your data is newer than this app" treatment and is honored ONLY for the
 * migration-refusal case. A restart-ladder exhaustion says nothing about
 * migrations, and claiming it would send the user to an update that cannot help.
 *
 * Declared beside {@link DB_HOST_RESTART_EXHAUSTED_USER_REASON} so the reason a
 * user is shown and the reason the renderer reads cannot drift apart.
 */
export const DB_HOST_RESTART_EXHAUSTED_RUNTIME_STATUS: AgentMonitorRuntimeStatus =
  {
    kind: AgentMonitorRuntimeStatusKind.Failed,
    dbAhead: false,
    reason: DB_HOST_RESTART_EXHAUSTED_USER_REASON,
  } as const;

/**
 * The rejection every db-host call gets once the ladder is finished.
 *
 * Deliberately does NOT reuse the `db-host exited (code: N)` wording: that
 * string means "the child went away", which callers pair with
 * `restartScheduled` to decide whether to wait. This one means "and nothing is
 * bringing it back", which is a different fact and reads as one.
 */
export function describeRestartExhaustedOp(op: string): string {
  return `db-host is unavailable after ${MAX_DB_HOST_RESTART_ATTEMPTS} failed restart attempts (op: ${op})`;
}

/**
 * The terminal rejection itself, beside the wording it carries. Reuses
 * {@link DbHostExitError} rather than adding a class: `restartScheduled: false`
 * already means "gone, and unrecoverable", and consumers already gate on it via
 * `isRecoverableDbHostExitError`.
 */
export function restartExhaustedError(
  lastExitCode: number | null,
  op: string
): DbHostExitError {
  return new DbHostExitError(
    lastExitCode,
    false,
    describeRestartExhaustedOp(op)
  );
}
