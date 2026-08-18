/**
 * @file db-host-exit-error.ts
 * @description ISS-5808 — the classifier for "the db-host child died under an
 * op that was already in flight", i.e. the FAULT half of a db-host exit.
 *
 * Its sibling `db-host-shutdown-error.ts` classifies the benign half (an exit
 * inside the intentional-teardown window) and says, in as many words, why it
 * deliberately has no arm for this case:
 *
 * > Safe to match on message alone because `invoke()` mints these two strings
 * > in exactly one place each … That is NOT true of `db-host exited (code: N)`,
 * > which `handleExit` produces on BOTH the shutdown and the crash branch with
 * > an identical string … The typed error is the only sound signal for that
 * > case.
 *
 * This module is that typed error. Before it, `handleExit` fanned a plain
 * `Error("db-host exited (code: 0)")` to every pending op, so no consumer could
 * tell "the host died and a replacement is already coming" from "this query is
 * broken". Two consequences observed live on 2026-08-10 (ISS-5808):
 *
 *  - `getSharedBranchesPageData` laundered it into a bare
 *    `LOCAL_BRANCHES_SOURCE_TRANSIENT`, so the same root cause presented as two
 *    unrelated errors depending on which IPC handler you read, and the db-host
 *    never appeared at all on the Branches side.
 *  - Read handlers that could simply have waited for the replacement child
 *    instead surfaced a hard failure, three times in the same millisecond.
 *
 * `message` is UNCHANGED (`db-host exited (code: N)`) on purpose: an installed
 * build, a serialized child error, and every existing test still see the string
 * they always saw. Only the CLASS is new — same compatibility shape ISS-5262
 * used for `DbHostShutdownError`.
 *
 * Lives in `src/shared/` for the same reason its sibling does: it is pure (zero
 * imports), and boot-graph modules must be able to import it without dragging
 * the db-host runtime under `src/main/database/` onto the eager boot path
 * (`boot-no-design-system-runtime`, `scripts/dependency-cruiser.config.cjs`).
 */

/**
 * A db-host op abandoned because the child process exited under it, OUTSIDE the
 * intentional-teardown window — a fault, not a shutdown.
 *
 * `restartScheduled` records whether the supervisor armed a replacement fork for
 * this exit. It is the only sound basis for calling the failure retryable: a
 * "transient" label asserted while nothing is bringing the host back is a lie
 * about state, which is precisely what `LOCAL_BRANCHES_SOURCE_TRANSIENT` was
 * doing. Consumers must read this field rather than assume recovery.
 *
 * Sets `name` so a log line, a crash report, or `String(error)` identifies it as
 * more than a bare `Error` — NOT as a classification channel. Classification is
 * by class alone; see {@link findDbHostExitError} for why this error, unlike
 * `DbHostShutdownError`, needs no name-based fallback.
 */
export class DbHostExitError extends Error {
  readonly exitCode: number | null;
  readonly restartScheduled: boolean;

  constructor(
    exitCode: number | null,
    restartScheduled: boolean,
    message: string
  ) {
    super(message);
    this.name = "DbHostExitError";
    this.exitCode = exitCode;
    this.restartScheduled = restartScheduled;
  }
}

/**
 * How many `cause` links {@link findDbHostExitError} will follow.
 *
 * Bounded because `cause` is caller-supplied and can be cyclic; three levels
 * covers every wrap in this repo (a source boundary sanitizing a db-host
 * rejection, at most re-wrapped once by an outer read) with room to spare.
 */
const MAX_CAUSE_DEPTH = 3;

/**
 * The {@link DbHostExitError} at or beneath `error`, or `null`.
 *
 * Follows `cause` because the desktop's read boundaries deliberately SANITIZE a
 * db-host failure before it can cross IPC — `rethrowAsBranchSourceError` throws a
 * bare `Error(LOCAL_BRANCHES_SOURCE_TRANSIENT)` so no local message reaches the
 * renderer. Before ISS-5808 that boundary dropped the original entirely, which is
 * why one root cause presented as two unrelated errors; it now passes the
 * original as `cause`, and this walk is what makes that link mean something to a
 * classifier instead of being decoration.
 *
 * Matches on the CLASS only. Two things it deliberately does not do:
 *
 *  - it does not sniff the `db-host exited (code: N)` message, because
 *    `handleExit` mints that identical string on the shutdown branch too, so a
 *    message match would re-classify a benign teardown as a fault;
 *  - it does not carry a `name`-based fallback for a prototype dropped across
 *    the utilityProcess boundary, the way `isDbHostShutdownError` does. That
 *    fallback exists there because the CHILD serializes a shutdown error;
 *    nothing ever serializes this one. It is minted in exactly one place
 *    (`DbHostClient.handleExit`, main-side), never posted to the child, and
 *    `rebuildError` — the only thing that reconstructs an error coming back
 *    from the child — mints a plain `Error` or a `DesktopMigrationError` and
 *    can never produce this name. A rebuild branch here would be untestable
 *    dead code, so it is deliberately absent; add it together with the
 *    serialization path that needs it, not before.
 *
 * There is deliberately no bare `isDbHostExitError` predicate beside
 * {@link isRecoverableDbHostExitError}. Nothing in the repo asks "is this an
 * exit?" without also needing to know whether a replacement host is coming — a
 * caller that acted on the bare answer would be re-driving against a corpse —
 * and an exported helper no caller reaches is dead code by the same rule as the
 * rebuild branch above. Add it with the consumer that needs it.
 */
export function findDbHostExitError(error: unknown): DbHostExitError | null {
  let current: unknown = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth++) {
    if (current instanceof DbHostExitError) {
      return current;
    }
    if (!(current instanceof Error)) {
      return null;
    }
    current = current.cause;
  }
  return null;
}

/**
 * True when `error` is a db-host exit that the supervisor is ALREADY recovering
 * from — the one case where re-driving the op is expected to succeed.
 *
 * An exit with no restart scheduled (the ladder cannot re-fork, or the app is
 * shutting down) reads as `false`, so a caller's re-drive terminates instead of
 * spinning against a host nobody is bringing back.
 */
export function isRecoverableDbHostExitError(error: unknown): boolean {
  return findDbHostExitError(error)?.restartScheduled === true;
}
