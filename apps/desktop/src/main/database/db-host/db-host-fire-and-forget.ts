/**
 * @file db-host-fire-and-forget.ts
 * @description ISS-6164 — the ONE guard every fire-and-forget db-host write uses.
 *
 * `redriveOnDbHostExit` is the sibling of this helper and covers the work that
 * has somewhere to return to: a caller awaits it, so an exhausted re-drive can
 * report failure. This helper covers the other half — a best-effort write
 * launched with `void` from a callback that has no error path at all
 * (`onViolation`, a `child.on("close")` handler). Those had no `.catch`, so when
 * the db-host child died under them the rejection minted by `invoke()` reached
 * `handleUnhandledRejection`, which shows the crash dialog and calls
 * `exit(1)`.
 *
 * That is the escape ISS-6164 observed as
 * `[error-handler] unhandled rejection: db-host exited (code: 0)`, and it is the
 * most severe consequence of a db-host bounce: a supervisor that recovers the
 * host perfectly still loses the whole app, because an unrelated best-effort
 * telemetry write was in flight at the wrong moment.
 *
 * ## Why this swallows only the lifecycle window
 *
 * A db-host restart/shutdown is the one failure a `void` write genuinely has no
 * answer for: the row is gone, the supervisor is already re-forking, and there
 * is no caller to tell. Dropping it with a log is honest.
 *
 * Every OTHER rejection is rethrown, which re-raises it as an unhandled
 * rejection exactly as before this helper existed. A genuine SQL or logic
 * failure in one of these writes must stay as loud as it is today — this helper
 * narrows the crash to the case that warrants it, it does not add a blanket
 * catch that would hide real bugs behind a log line.
 */
import { findDbHostExitError } from "../../../shared/db-host-exit-error.js";
import { isDbHostShutdownError } from "../../../shared/db-host-shutdown-error.js";
import {
  extractDbHostErrorMessage,
  isTransientDbHostErrorMessage,
} from "../../../shared/transient-db-host-error.js";

export type DbHostFireAndForgetOptions = {
  /** Human label for the log line; the write that was dropped. */
  readonly label: string;
  /** Main-process logger. */
  readonly log?: (message: string) => void;
};

/**
 * Attach the db-host lifecycle guard to a best-effort write launched without a
 * caller.
 *
 * Returns `void` (not the promise) so a call site cannot accidentally start
 * awaiting a result this helper has already decided nobody is waiting for.
 */
export function dropOnDbHostLifecycleError(
  work: Promise<unknown>,
  options: DbHostFireAndForgetOptions
): void {
  work.catch((error: unknown) => {
    settleFireAndForgetDbHostError(error, options);
  });
}

/**
 * The decision itself, exported so a test can execute it against synthetic
 * inputs rather than assert that a predicate appears somewhere.
 *
 * Returns normally when the error is a db-host lifecycle event (the write is
 * dropped and logged); RETHROWS anything else so it keeps reaching
 * `handleUnhandledRejection` exactly as it did before ISS-6164.
 */
export function settleFireAndForgetDbHostError(
  error: unknown,
  options: DbHostFireAndForgetOptions
): void {
  // Deliberately NOT `isTransientDbHostError`: that predicate answers "should a
  // READ retry", so it is false for an exit with no replacement scheduled. That
  // is a different question. A `void` write has no caller either way — the row
  // is gone whether or not a replacement host is coming — and crashing the app
  // over the worse of the two cases is exactly the ISS-6164 defect.
  //
  // Membership is therefore the lifecycle CLASS, then the lifecycle MESSAGE:
  //  - `findDbHostExitError` — either typed exit shape (restart scheduled or not);
  //  - `isDbHostShutdownError` — the typed shutdown plus the two `invoke()`
  //    pre-flight rejections;
  //  - `isTransientDbHostErrorMessage` — the UNTYPED case. `handleExit`'s
  //    shutdown branch rejects with a bare `Error(...)` whenever the code is
  //    non-graceful (a signal-numbered crash such as the exit-code-5 RCA) while
  //    `closing` is set, so a host that crashes during teardown yields neither
  //    typed class. Without this arm that rejection is rethrown and takes the
  //    app down — the very failure this guard exists to stop.
  // All three are the canonical owners; none is re-implemented here.
  if (
    findDbHostExitError(error) !== null ||
    isDbHostShutdownError(error) ||
    isTransientDbHostErrorMessage(extractDbHostErrorMessage(error))
  ) {
    options.log?.(describeDroppedDbHostWrite(options.label, error));
    return;
  }
  throw error;
}

/**
 * The dropped-write log line, owned here so the several fire-and-forget call
 * sites cannot each invent their own wording for the same event — the drift
 * `describeDbHostExitRedrive` exists to prevent on the re-drive side.
 *
 * Names the write that was lost rather than only the error, so the log answers
 * "what did this bounce cost" instead of just "a bounce happened".
 */
export function describeDroppedDbHostWrite(
  label: string,
  error: unknown
): string {
  const reason = error instanceof Error ? error.message : String(error);
  return `${label}: dropped by a db-host lifecycle event (${reason}); this write is best-effort and is not replayed`;
}
