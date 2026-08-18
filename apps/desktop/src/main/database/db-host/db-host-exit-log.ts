/**
 * @file db-host-exit-log.ts
 * @description ISS-5715 — how an UNEXPECTED db-host exit is narrated.
 *
 * Extracted from `db-host-client.ts` for the same reason
 * `collector-import-failure-log.ts` was extracted from `collector-manager.ts`:
 * the decision is narrated by TWO sibling branches (crash-storm and ordinary),
 * and deriving each independently is precisely how they drifted. The storm
 * branch kept naming a backoff delay after the ordinary branch had been taught
 * that `scheduleRestart()` is a no-op while an earlier attempt is still in
 * flight — so during a crash storm, the case where a restart is MOST likely
 * already running, the log went on describing a timer that was never armed.
 *
 * Both strings now come from here, off one classification, so they cannot drift
 * apart again. Pure and dependency-free, so the wording is unit-testable
 * without constructing a client or forking a child.
 */

/**
 * What the log says when this exit armed no timer of its own because an earlier
 * restart attempt was still in flight. Shared by both branches.
 */
const RESTART_ALREADY_IN_FLIGHT = "a restart is already in flight";

/** Unexpected exits in the rolling window at which the storm wording kicks in. */
export const CRASH_STORM_THRESHOLD = 3;

/** The facts an unexpected-exit log line is derived from. */
export type UnexpectedDbHostExit = {
  /**
   * Electron's reported exit code, or null when it reported none. NOT a cause:
   * Electron reports `0` whenever the utility process's mojo pipe disconnects
   * before the platform termination status is available
   * (electron/electron#42283), so a crashed host and a cleanly stopped one are
   * indistinguishable from this value alone.
   */
  code: number | null;
  /** Unexpected exits inside the rolling crash window, including this one. */
  crashesInWindow: number;
  /** Delay the crash ladder computed for the next attempt. */
  backoffMs: number;
  /** Length of the rolling crash window, in ms — used only for the wording. */
  crashWindowMs: number;
  /**
   * True when an earlier restart attempt was still in flight, so this exit
   * armed no timer and recovery rides on that attempt's own continuation.
   * When true, NEITHER branch may name a delay.
   */
  restartAlreadyInFlight: boolean;
};

/** True when this exit count has reached the crash-storm wording threshold. */
export function isDbHostCrashStorm(crashesInWindow: number): boolean {
  return crashesInWindow >= CRASH_STORM_THRESHOLD;
}

/**
 * The single log line for an unexpected db-host exit.
 *
 * The recovery clause is the load-bearing part: it states what will ACTUALLY
 * happen, never a scheduled delay that no timer is holding.
 */
export function describeUnexpectedDbHostExit(
  exit: UnexpectedDbHostExit
): string {
  const codeText = exit.code ?? "null";
  const scheduled = isDbHostCrashStorm(exit.crashesInWindow)
    ? `backing off ${exit.backoffMs}ms before restart`
    : `restarting in ${exit.backoffMs}ms`;
  const recovery = exit.restartAlreadyInFlight
    ? RESTART_ALREADY_IN_FLIGHT
    : scheduled;
  if (isDbHostCrashStorm(exit.crashesInWindow)) {
    return `db-host crash storm: ${exit.crashesInWindow} crashes in ${
      exit.crashWindowMs / 1000
    }s (code: ${codeText}); ${recovery}`;
  }
  return `db-host exited unexpectedly (code: ${codeText}); ${recovery}`;
}
