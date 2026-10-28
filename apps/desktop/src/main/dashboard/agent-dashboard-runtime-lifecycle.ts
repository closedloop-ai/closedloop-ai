/**
 * @file agent-dashboard-runtime-lifecycle.ts
 * @description ISS-6713: the start/stop/beginClosing/close state machine of the
 * Agent Dashboard design-system runtime, lifted out of
 * `agent-dashboard-design-system-runtime.ts` so a test can execute it.
 *
 * Creating that runtime forks the db host and reaches into Electron, so no suite
 * can import it — every one of its lifecycle guards was unreachable from a test,
 * and they are the load-bearing part:
 *
 *  - `closed` is what stops a background task, a scheduler start, or a collector
 *    restart that resolves AFTER the app has torn the runtime down;
 *  - the identity of the current start promise is what stops a SUPERSEDED start
 *    continuation from starting the collectors under a runtime that has since
 *    been stopped (`stop()` nulls the slot, so the in-flight continuation must
 *    recognise itself as stale) — a plain "am I closed?" check cannot see that;
 *  - `close()` runs the bounded db-host drain, and it must run it exactly once.
 *
 * Semantics are unchanged by the extraction. `beginClosing()` still only opens
 * the db-host intentional-shutdown window (ISS-4713) and deliberately does NOT
 * touch this module's own state: the runtime never gated anything on "has
 * beginClosing arrived?", and `DbHostClient.close()` sets that window itself as
 * the backstop for a caller that never sent one.
 */

/**
 * The shutdown half of `AgentDashboardDbHostLifecycle`, narrowed to what this
 * state machine drives — so a test can substitute a recorder instead of forking
 * a real db host.
 */
export type AgentDashboardRuntimeDbHostShutdown = {
  beginClosing: () => void;
  close: () => Promise<void>;
};

export type AgentDashboardRuntimeLifecycle = {
  isClosed: () => boolean;
  /**
   * Is `candidate` still the start attempt the runtime is running on? False
   * once the runtime closed, and false for a start a later `stop()` discarded.
   */
  isCurrentStart: (candidate: Promise<void>) => boolean;
  /**
   * The current start attempt, installing one from `begin` when none is in
   * flight. After `close()` there is nothing to start, so `begin` is never
   * invoked — no listener may be bound behind a completed teardown.
   */
  ensureStarted: (begin: () => Promise<void>) => Promise<void>;
  /**
   * Open a stop: discards the current start attempt so its continuation goes
   * stale. False when the runtime is already closed and the caller must no-op.
   */
  beginStop: () => boolean;
  /** ISS-4713 — open the db-host intentional-shutdown window. Idempotent. */
  beginClosing: () => void;
  /**
   * Run `teardown` and then the bounded db-host drain, once. A second call
   * (or one racing the first) runs neither again. A rejecting `teardown` still
   * gets the drain, and its rejection then propagates — as an `AggregateError`
   * over both when the drain rejected too, so neither cause is lost.
   */
  close: (teardown: () => Promise<void>) => Promise<void>;
};

export function createAgentDashboardRuntimeLifecycle(
  dbHost: AgentDashboardRuntimeDbHostShutdown
): AgentDashboardRuntimeLifecycle {
  let closed = false;
  let startPromise: Promise<void> | null = null;

  return {
    isClosed: () => closed,
    isCurrentStart: (candidate: Promise<void>) =>
      !closed && startPromise === candidate,
    ensureStarted: (begin: () => Promise<void>) => {
      if (closed) {
        return Promise.resolve();
      }
      if (!startPromise) {
        startPromise = begin();
      }
      return startPromise;
    },
    beginStop: () => {
      if (closed) {
        return false;
      }
      startPromise = null;
      return true;
    },
    beginClosing: () => {
      dbHost.beginClosing();
    },
    close: async (teardown: () => Promise<void>) => {
      if (closed) {
        return;
      }
      // Set SYNCHRONOUSLY, before the first await below can yield: the teardown
      // is what stops the collectors and the timers, and every one of them
      // re-checks `isClosed()` on its own continuation.
      closed = true;
      // Belt-and-braces, carried over verbatim from the runtime's own close():
      // `closed` already short-circuits BOTH readers of this slot, so nulling it
      // changes no answer. It is a second contract only in `beginStop()`, which
      // leaves the runtime open.
      startPromise = null;
      // ISS-7009: the drain runs even when a teardown step rejected. `closed`
      // is set above and is never unset, so a drain skipped here is PERMANENT —
      // every later close() no-ops and the db-host child outlives the app with
      // nothing left to reap it.
      let teardownError: unknown;
      let teardownFailed = false;
      try {
        await teardown();
      } catch (error) {
        teardownFailed = true;
        teardownError = error;
      }
      try {
        await dbHost.close();
      } catch (drainError) {
        // Both halves failed. A bare `finally` around the drain would have let
        // this error REPLACE the teardown's, and the teardown is the likelier
        // root cause — shutdown reports one message
        // (`Observability.desktopShutdownFailed`), so that message has to carry
        // both rather than silently pick the second one.
        if (teardownFailed) {
          throw new AggregateError(
            [teardownError, drainError],
            `runtime teardown failed (${String(teardownError)}) and the db-host drain then failed (${String(drainError)})`
          );
        }
        throw drainError;
      }
      if (teardownFailed) {
        throw teardownError;
      }
    },
  };
}
