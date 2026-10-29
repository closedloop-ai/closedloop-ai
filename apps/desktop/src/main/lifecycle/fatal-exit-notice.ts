/**
 * @file fatal-exit-notice.ts
 * @description ISS-8776 — the signal that says "this process is going away NOW,
 * on the fatal path".
 *
 * The graceful quit announces itself: `runDesktopApplicationShutdown` opens the
 * db-host intentional-teardown window (`beginClosing()`) as the first thing it
 * does, precisely so a child `exit` from that point on is not relabeled
 * "exited unexpectedly" and does not trigger a mid-shutdown restart (ISS-4713).
 *
 * The FATAL path announces nothing. `handleUncaughtException` /
 * `handleUnhandledRejection` call `app.exit(1)`, which — as `startup.ts` says
 * in as many words — skips `before-quit`, so none of that shutdown ordering
 * runs. Every supervisor in the process therefore watches its child die during
 * an app teardown it was never told about, and reacts as if it were a crash.
 *
 * That is the second half of the observed incident. A `DbHostExitError` reached
 * the global handler; `app.exit(1)` then killed the db-host utilityProcess,
 * which reported exit code 0; and because `closing` had never been set, the
 * supervisor classified that as `db-host exited unexpectedly (code: 0)` and
 * re-forked into a process that was already on its way out —
 * `db-host restart failed, retrying` in the same millisecond, repeatedly.
 *
 * ## Why a registry and not a constructor argument
 *
 * The ordering forbids injection. `startup.ts` installs the process error
 * handlers BEFORE it constructs `DesktopApplication`, and the db-host client is
 * created later still — lazily, when the Agent Dashboard runtime first boots.
 * So the consumer does not exist when the producer is wired, and threading a
 * mutable accessor down through `DesktopApplication` would grow `app.ts`, which
 * is already over the file-size ceiling and shrink-only.
 *
 * Registration therefore lives WITH the thing being torn down: the db-host
 * lifecycle registers its own hook when it forks a child and releases it when
 * it closes, so there is no window in which a hook outlives its subject.
 *
 * ## What a hook may do
 *
 * Only synchronous, cheap, idempotent work — the process is mid-crash and every
 * millisecond spent here delays the crash dialog and the telemetry flush.
 * `DbHostClient.beginClosing()` is exactly that shape by design. A hook that
 * throws is swallowed rather than allowed to displace the crash the handler was
 * already reporting.
 */

/**
 * Registered fatal-exit hooks. A `Set`, so a double registration is a no-op and
 * a released hook is genuinely gone rather than left as a hole in an array.
 */
const fatalExitHooks = new Set<() => void>();

/**
 * Register `hook` to run when the process is about to exit on the fatal path.
 *
 * Returns the release function. Callers that have their own graceful teardown
 * MUST release there, so a hook cannot fire against an already-closed subject.
 */
export function onFatalExit(hook: () => void): () => void {
  fatalExitHooks.add(hook);
  return () => {
    fatalExitHooks.delete(hook);
  };
}

/**
 * Run every registered hook. Never throws.
 *
 * Iterates a COPY: a hook that releases itself (or another) while running would
 * otherwise mutate the set mid-iteration.
 */
export function notifyFatalExit(): void {
  for (const hook of [...fatalExitHooks]) {
    try {
      hook();
    } catch {
      // A teardown hook must never displace the crash already being reported,
      // and there is no logger contract here that is safe to depend on this
      // late. The failure the process is exiting for is the one that matters.
    }
  }
}
