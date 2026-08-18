/**
 * @file db-host-shutdown-error.ts
 * @description ISS-5262 — the single classifier for "this db-host failure is
 * an intentional shutdown, not a fault".
 *
 * ISS-4713 taught `DbHostClient` to stop RELABELING an exit during the
 * intentional-teardown window ("exited unexpectedly") and to stop restarting
 * mid-shutdown, and ISS-4903 added a bounded lane quiesce upstream of the
 * db-host close. Neither touched the other half of `handleExit`: it still fans
 * a plain `Error("db-host exited (code: 0)")` out to EVERY pending op. Their
 * consumers cannot tell that error apart from a real failure, so a graceful
 * `code: 0` exit produced `sync failed:`, `collector claude import failed:`,
 * `ipc perf session_count query failed:` and a burst of Electron
 * `Error occurred in handler for 'desktop:shared-agent-sessions:usage'`
 * rejections — all AFTER `shutdown sequence end: clean` had been logged. The
 * log claimed a state that was not true.
 *
 * This module is the seam that lets each consumer answer "was this just
 * shutdown?" without re-deriving the answer from a string it copy-pasted.
 *
 * Why an ERROR and not a resolved value at the client: an op that never ran
 * must not report success. Resolving `undefined` into `clearOutboxOnAck` would
 * mark acked outbox rows cleared when the DELETE never reached SQLite — the
 * exact durable-data corruption `failed to clear N acked outbox row(s)` warns
 * about. So the client still REJECTS; it just rejects with a classifiable
 * error, and the outermost boundary (the ipcMain handler) is the only layer
 * allowed to turn that into a resolution.
 *
 * Why it lives in `src/shared/` and not next to `db-host-client.ts`: the boot
 * path reaches it. `app.ts → desktop-sync-lane-composition.ts →
 * agent-session-sync-service.ts → agent-session-sync-tick-failure-log.ts` needs
 * the predicate, and `boot-no-design-system-runtime`
 * (`scripts/dependency-cruiser.config.cjs`) forbids a boot entry from
 * statically reaching ANY module under `src/main/database/` — the agent
 * dashboard runtime is lazy-loaded via dynamic `import()` and must not be
 * dragged onto the eager boot path. This module is pure: zero imports, only a
 * const object, an error class, and two predicates, so it is the lightweight
 * half that boot-sensitive consumers can import without pulling in the db-host
 * runtime. Its main↔preload twin `db-host-shutdown-contract.ts` and the
 * renderer's `transient-db-host-error.ts` sit here for the same reason.
 */

/**
 * Why a pending db-host op was abandoned. Wire-visible only through the error
 * message, so treat these as internal labels, not a contract.
 */
export const DbHostShutdownReason = {
  /** The child exited gracefully while the intentional-teardown window was open. */
  Exited: "exited",
  /** `close()` had already completed; the client refuses new work. */
  Closed: "closed",
  /** `beginClosing()`/`close()` ran while this op was queued on `ready`. */
  Closing: "closing",
} as const;
export type DbHostShutdownReason =
  (typeof DbHostShutdownReason)[keyof typeof DbHostShutdownReason];

/**
 * A db-host op that could not run because the app is shutting down — never
 * because anything failed.
 *
 * Carries `name` explicitly so the classification survives the one place a
 * prototype is lost: an error serialized across the utilityProcess boundary
 * (`serializeDbHostError`) arrives main-side as a plain object and is rebuilt
 * by `rebuildError`, which restores `name` but not the class.
 */
export class DbHostShutdownError extends Error {
  readonly reason: DbHostShutdownReason;

  constructor(reason: DbHostShutdownReason, message: string) {
    super(message);
    this.name = "DbHostShutdownError";
    this.reason = reason;
  }
}

/**
 * Is `code` a graceful db-host exit?
 *
 * `0` is the child's own clean exit. `null` is "no code reported" — the shape
 * an OS-signalled teardown (`child.kill()` during `close()`) surfaces — which
 * the ISS-5262 cross-repo note says to map to the benign path rather than to an
 * error, since an unknown exit during an intentional shutdown is not evidence
 * of a fault.
 *
 * Every other value stays non-graceful ON PURPOSE. Per the exit-code-5 RCA in
 * `db-host-client.ts`, a native crash reports the SIGNAL NUMBER as its exit code
 * (SIGTRAP→5, SIGABRT→6, SIGSEGV→11), so widening this to "anything during
 * shutdown" would silence a real crash that happened to land during quit — the
 * failure mode this classifier must not create while fixing the other one.
 */
export function isGracefulDbHostExitCode(code: number | null): boolean {
  return code === 0 || code === null;
}

/**
 * The `invoke()` pre-flight rejections for a closed / closing client.
 *
 * Safe to match on message alone because `invoke()` mints these two strings in
 * exactly one place each, and only when the client is already closed/closing —
 * the message IS the state. That is NOT true of `db-host exited (code: N)`,
 * which `handleExit` produces on BOTH the shutdown and the crash branch with an
 * identical string; matching it here would re-classify an unexpected `code: 0`
 * exit as benign while the client was simultaneously logging
 * `exited unexpectedly` and re-forking. The typed error is the only sound
 * signal for that case, so there is deliberately no exited-message arm.
 */
const DB_HOST_CLOSED_MESSAGE = /^db-host is clos(?:ed|ing) \(op: /;

/**
 * True when `error` means "the app is shutting down", so the caller may skip or
 * downgrade its failure handling instead of reporting a fault.
 *
 * Recognizes the typed error (by instance, and by `name` for the one boundary
 * that drops the prototype — an error serialized out of the db-host child and
 * rebuilt by `rebuildError`, which restores `name` but not the class), plus the
 * two unambiguous `invoke()` message shapes above.
 *
 * Anything unrecognized degrades to "not a shutdown" — i.e. it is still
 * reported. This predicate can only ever quieten a case it positively
 * recognized, never a case it merely failed to understand.
 */
export function isDbHostShutdownError(error: unknown): boolean {
  if (error instanceof DbHostShutdownError) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.name === "DbHostShutdownError" ||
    DB_HOST_CLOSED_MESSAGE.test(error.message)
  );
}

/**
 * What a lane says instead of an error message when it abandoned work because
 * the app is shutting down.
 *
 * Lives here rather than at the call site because it is narrated more than once
 * per abandonment — the collector lane logs it AND hands it to the ingest
 * tracker's `session backfill [<harness>] abandoned at N/M source file(s):
 * <reason>` line. Passing the raw error to the second one put
 * `db-host exited (code: 0)` straight back into the log after
 * `shutdown sequence end: clean`, which is the contradiction this whole module
 * exists to remove.
 */
export const DB_HOST_SHUTDOWN_ABANDON_REASON =
  "db-host shutting down; resumes on next launch";
