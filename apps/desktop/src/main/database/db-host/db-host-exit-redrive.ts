/**
 * @file db-host-exit-redrive.ts
 * @description ISS-5808 — the ONE bounded re-drive every main-process db-host
 * consumer uses when the child process dies under it.
 *
 * #4708 (ISS-5715) fixed the supervisor: an unexpected exit no longer wedges
 * `DbHostClient`, and a replacement child is forked on the crash ladder. What it
 * did not fix — and what recurred ~10 hours later — is that recovering the HOST
 * is not recovering the WORK. `handleExit` rejects every in-flight op and says
 * so in its own comment ("every one of those calls was abandoned mid-flight and
 * is NOT replayed by this client"), so on 2026-08-10 a codex session backfill
 * abandoned at 5/6 source files, a transcript batch stranded, and the
 * DATA_REVISION rebuild died — all while a healthy replacement host came up
 * moments later with nothing to do.
 *
 * This helper is that missing half. It re-runs a unit of work when, and only
 * when, it failed with a {@link DbHostExitError} the supervisor is ALREADY
 * recovering from (`restartScheduled`). Everything else — a genuine query
 * failure, a shutdown, an unrecoverable exit with no replacement coming —
 * propagates untouched on the first attempt.
 *
 * ## Why there is no sleep here
 *
 * The re-drive does not need one, and adding one would be wrong. `invoke()`
 * awaits `DbHostClient.ready`, which `scheduleRestart()` leaves PENDING for the
 * whole crash-ladder backoff — so a re-driven op parks on the replacement child
 * by construction and resumes the instant it is ready. A second sleep here would
 * stack on top of the ladder's, and would be untestable without a clock. The
 * bound is therefore an ATTEMPT COUNT, which is what a test asserts (per the
 * repo's no-timing-assertions rule), and the pacing is the ladder's escalating
 * backoff (FEA-3072), which already reaches 30s under a crash storm.
 *
 * ## Why it is opt-in, not automatic in `DbHostClient.invoke`
 *
 * A blanket replay inside the client would re-post ops whose result was lost but
 * whose WRITE may already have committed in the child before it died. Most of
 * the desktop store is `ON CONFLICT` upserts, but not all of it is — `token_events`
 * is append-shaped and has no primary key — so an automatic replay would risk
 * double-counting on exactly the table where it is least visible. Callers opt in
 * at the granularity where idempotence is actually known: a whole import pass
 * (re-reads its sources through the catch-up cache), a whole rebuild (cursored on
 * the DATA_REVISION stamp), or a read.
 */
import {
  type DbHostExitError,
  findDbHostExitError,
} from "../../../shared/db-host-exit-error.js";

/**
 * Attempts allowed per unit of work, INCLUDING the first. Two re-drives is
 * enough to ride out a replacement child that itself dies on start (the
 * Ready-then-exit window ISS-5715 pinned) without turning a persistent crash
 * loop into an unbounded replay — the sync-lane contract's invariant 5 requires
 * every terminal path to stay reachable.
 */
export const DB_HOST_EXIT_MAX_ATTEMPTS = 3;

export type DbHostExitRedriveOptions = {
  /** Human label for the log line; the op/pass being re-driven. */
  readonly label: string;
  /** Main-process logger. */
  readonly log?: (message: string) => void;
  /** Override the attempt bound (tests). Clamped to at least 1. */
  readonly maxAttempts?: number;
};

/**
 * Run `work`, re-driving it while it fails with a RECOVERABLE db-host exit.
 *
 * Returns `work`'s value on the first attempt that succeeds. Rethrows the last
 * error when the attempt bound is exhausted, so an exhausted re-drive still
 * reports a failure — it must never resolve as if the work had completed.
 */
export async function redriveOnDbHostExit<T>(
  work: () => Promise<T>,
  options: DbHostExitRedriveOptions
): Promise<T> {
  const maxAttempts = Math.max(
    1,
    Math.floor(options.maxAttempts ?? DB_HOST_EXIT_MAX_ATTEMPTS)
  );
  let attempt = 1;
  // Not a `for` loop with a rethrow after it: the loop below always exits
  // through `return` or `throw`, so there is no unreachable tail to keep in
  // sync with the bound.
  for (;;) {
    try {
      return await work();
    } catch (error) {
      const exit = findDbHostExitError(error);
      if (exit?.restartScheduled !== true || attempt >= maxAttempts) {
        throw error;
      }
      attempt++;
      options.log?.(
        describeDbHostExitRedrive(options.label, exit, attempt, maxAttempts)
      );
    }
  }
}

/**
 * The re-drive log line, owned here so the several consumers cannot each invent
 * their own wording for the same event (the drift `collector-import-failure-log`
 * exists to prevent on the abandonment side).
 *
 * Names the attempt it is ABOUT to make and the bound, so a reader can tell a
 * ride-out from a loop without counting lines — and so a run that exhausts the
 * bound is legible as exhaustion rather than as silence.
 */
export function describeDbHostExitRedrive(
  label: string,
  error: DbHostExitError,
  attempt: number,
  maxAttempts: number
): string {
  return `${label}: db-host exited (code: ${error.exitCode ?? "null"}) mid-op; re-driving against the replacement host (attempt ${attempt}/${maxAttempts})`;
}
