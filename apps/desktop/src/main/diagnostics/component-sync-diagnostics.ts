/**
 * @file component-sync-diagnostics.ts
 * @description Small shared diagnostics helpers for the desktop→cloud
 * component-inventory sync lane. Both the HTTP client
 * ({@link file://./desktop-components-client.ts}) and the sync service
 * ({@link file://./agent-session-sync-service.ts}) instrument their otherwise
 * silent skip/failure branches, and both need the exact same two primitives:
 *
 *   1. `errorMessage(error)` — collapse an `unknown` catch binding to a string.
 *   2. `createTransitionLogger(tag)` — a "log only when the outcome changes"
 *      logger so a stuck failure names itself exactly once (no per-tick spam)
 *      and a later recovery logs a single line.
 *
 * Extracted here so the two lanes stay behaviourally identical (they log the
 * same way) instead of maintaining two verbatim copies of the transition logic.
 */
import { gatewayLog } from "../logging/gateway-logger.js";

/** Collapse an `unknown` catch binding to a human-readable message. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type TransitionLogger = {
  /**
   * Log `message` at `level` under the logger's tag, but only when `outcome`
   * differs from the last recorded outcome. Records `outcome` as the new state.
   * A repeated `outcome` is a no-op (no per-tick spam); a changed `outcome`
   * (including recovery) logs exactly one line.
   */
  note(level: "info" | "warn", outcome: string, message: string): void;
  /**
   * Record `outcome` as the current state WITHOUT logging. Use to mark a
   * success sentinel (e.g. `"ok"`) so the next skip re-logs, or to prime the
   * initial outcome. Idempotent for an already-current outcome.
   */
  set(outcome: string): void;
};

/**
 * Build a transition-based logger bound to `tag`. `format`, when provided,
 * wraps each message before it reaches the log (e.g. to add a lane prefix) so
 * both call sites can share the transition logic while keeping their own
 * message shape.
 */
export function createTransitionLogger(
  tag: string,
  format: (message: string) => string = (message) => message
): TransitionLogger {
  let lastOutcome: string | null = null;
  return {
    note(level, outcome, message) {
      if (outcome === lastOutcome) {
        return;
      }
      lastOutcome = outcome;
      gatewayLog[level](tag, format(message));
    },
    set(outcome) {
      lastOutcome = outcome;
    },
  };
}
