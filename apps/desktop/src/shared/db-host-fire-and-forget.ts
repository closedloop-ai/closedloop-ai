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
 * ISS-6337 adds the second such case: the store is OUT OF SPACE. It is the same
 * answer for the same reason — nobody is waiting, and no caller could make the
 * write succeed while the disk is full — and it is what stops a full disk from
 * ending the app once per best-effort write. The condition is not swallowed:
 * the db-host write boundary tallies it onto the monitored
 * `Observability.storeIntegrityResult` event (`../storage-exhaustion.ts`).
 *
 * Every OTHER rejection is rethrown, which re-raises it as an unhandled
 * rejection exactly as before this helper existed. A genuine SQL or logic
 * failure in one of these writes must stay as loud as it is today — this helper
 * narrows the crash to the cases that warrant it, it does not add a blanket
 * catch that would hide real bugs behind a log line.
 */
import { findDbHostExitError } from "./db-host-exit-error.js";
import { isDbHostShutdownError } from "./db-host-shutdown-error.js";
import { isDbStoreOpDeadlineError } from "./db-store-op-deadline-error.js";
import {
  describeStorageExhaustedWrite,
  storageReasonOf,
} from "./storage-exhaustion.js";
import {
  extractDbHostErrorMessage,
  isTransientDbHostErrorMessage,
} from "./transient-db-host-error.js";

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
  //  - `isDbStoreOpDeadlineError` — ISS-8773's NEW case. A store op that blew
  //    its deadline used to kill the host, so it arrived here as one of the
  //    three lifecycle shapes above; failing only the offending op means it now
  //    arrives as its own class, which this guard would otherwise rethrow into
  //    `handleUnhandledRejection` — the ISS-6164 crash, re-armed. A write with
  //    no caller cannot use the retry affordance that error offers anyone else.
  if (
    findDbHostExitError(error) !== null ||
    isDbHostShutdownError(error) ||
    isDbStoreOpDeadlineError(error) ||
    isTransientDbHostErrorMessage(extractDbHostErrorMessage(error))
  ) {
    options.log?.(describeDroppedDbHostWrite(options.label, error));
    return;
  }
  // ISS-6337 — the store is OUT OF SPACE. Same shape of answer as the lifecycle
  // window above, for the same reason: this write has no caller, and on a full
  // disk it cannot be made to succeed by anyone. Rethrowing reaches
  // `handleUnhandledRejection`, which shows the crash dialog and calls `exit(1)`
  // — so before this arm, a full disk did not degrade the app, it ENDED it, once
  // per best-effort write, which is the crash loop ISS-6337 names.
  //
  // This narrows the crash, it does not hide the failure: the write boundary in
  // the db host has already tallied this exact rejection for the monitored
  // `Observability.storeIntegrityResult` event, and every AWAITED write still
  // rejects to its own caller untouched. Only the no-caller case is dropped.
  const storageReason = storageReasonOf(error);
  if (storageReason !== null) {
    options.log?.(describeStorageExhaustedWrite(options.label, storageReason));
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
