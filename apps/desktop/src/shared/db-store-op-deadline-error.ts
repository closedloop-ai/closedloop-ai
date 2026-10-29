/**
 * @file db-store-op-deadline-error.ts
 * @description ISS-8773 — the store did not answer ONE op in time, and the
 * store itself is still up.
 *
 * Before this ticket there was no such condition to name: a missed store-op
 * deadline called `die()`, so every consumer saw a db-host LIFECYCLE failure
 * (`db-host exited` / a typed `DbHostExitError`) and the classifiers in
 * `transient-db-host-error.ts` and `db-host-exit-error.ts` covered the whole
 * space between them. Failing only the offending op opens a third case, and a
 * case no classifier recognizes is not neutral — `db-host-fire-and-forget.ts`
 * RETHROWS anything it cannot place, which reaches `handleUnhandledRejection`
 * and ends the app. That is the ISS-6164 crash, so this error ships with the
 * predicate that places it rather than leaving callers to string-match.
 *
 * It deliberately carries NO `DB_HOST_EXITED_SIGNATURE`: nothing exited, so
 * classifying it transient would park the Branches/Sessions boundaries in a
 * quiet "reconnecting" state waiting for a re-fork that is never coming. An
 * AWAITED caller gets a real failure with a real retry affordance; only the
 * no-caller fire-and-forget path drops it.
 *
 * Lives in `src/shared/` for the same reason its two siblings do: it is pure
 * (zero imports), and `db-host-fire-and-forget.ts` must be able to import it
 * without dragging the db-host runtime under `src/main/database/` onto the
 * eager boot path (`boot-no-design-system-runtime`,
 * `scripts/dependency-cruiser.config.cjs`).
 */

/**
 * The store did not answer this op inside its budget. Every other in-flight op
 * is untouched and the store thread is still running.
 *
 * "Did not answer" is NOT "did not happen", and the message says so, because a
 * synchronous libSQL call cannot be cancelled: the store is still inside it and
 * will still commit whatever it was doing. A caller may retry only an operation
 * that is safe to apply twice. That caveat is not new — a `die()` on a write
 * that had already committed left the same ambiguity — but failing the op alone
 * widens the window, so the wording carries it to every consumer instead of
 * leaving it to be inferred.
 *
 * `elapsedMs` is measured from the POST, not from the budget the op was last
 * armed against — an op posted behind a heavy one is re-armed when that op
 * settles, so the two differ and only the former describes what was waited.
 *
 * `name` is set explicitly because `serializeDbHostError` flattens the class on
 * the way out of the db-host child and `rebuildError` restores only the name.
 */
export class DbStoreOpDeadlineError extends Error {
  readonly op: string;
  readonly deadlineMs: number;
  readonly elapsedMs: number;

  constructor(op: string, deadlineMs: number, elapsedMs: number) {
    super(
      `store op "${op}" did not answer within its ${deadlineMs}ms deadline (${elapsedMs}ms since it was posted); it may still be running and may still apply`
    );
    this.name = "DbStoreOpDeadlineError";
    this.op = op;
    this.deadlineMs = deadlineMs;
    this.elapsedMs = elapsedMs;
  }
}

/**
 * True when `error` is a store-op deadline failure.
 *
 * Matches by instance AND by `name`, because the error crosses the
 * utilityProcess boundary: `serializeDbHostError` reduces it to a plain object
 * and `rebuildError` mints a bare `Error` carrying the name only. That is the
 * same reason `isDbHostShutdownError` keeps a name arm and
 * `findDbHostExitError` deliberately does not — this one IS serialized, so it
 * needs the fallback.
 */
export function isDbStoreOpDeadlineError(error: unknown): boolean {
  if (error instanceof DbStoreOpDeadlineError) {
    return true;
  }
  return error instanceof Error && error.name === "DbStoreOpDeadlineError";
}
