/**
 * Observability seam for the one thing `withDb.tx` silently drops.
 *
 * `withDb.tx` JOINS an ambient transaction when one is already in scope, so its
 * `maxWait`/`timeout` belong to whoever opened that transaction and cannot be
 * honored — unlike `isolationLevel`, which fails closed (ISS-4669). Discarding
 * them is CORRECT in production: the outer transaction's budget governs, and
 * refusing would break every legitimate nesting.
 *
 * It is not correct in a test. A suite wrapped in `autoRollbackTransaction`
 * makes every nested `withDb.tx` join one outer `BEGIN … ROLLBACK`, so a
 * service that deliberately opens one short transaction per chunk runs as one
 * giant transaction and the suite cannot fail if those boundaries are removed —
 * the single property they exist for (ISS-11104, found on PR #7716 / ISS-7797).
 *
 * This module is how that collapse becomes visible instead of silent: nothing
 * observes by default (production pays one undefined check), and the test
 * harness installs an observer so the blindness is an error rather than a green
 * run. It is deliberately NOT a log — the production path has nothing to report.
 *
 * WHAT IT CANNOT SEE. The report fires only where the ambient join had a
 * DECLARED BUDGET to discard. A bare `withDb.tx(fn)` joins exactly as silently
 * and reports nothing, so a per-batch boundary opened with no `maxWait`/
 * `timeout` — `purgePhantomSessionsBatch`, either loop in
 * `agent-sessions/retention-service.ts`, the per-loop reaper in
 * `loops/service.ts` — still collapses unseen under an ambient wrapper. That is
 * the bound of this seam, not an oversight: firing on every ambient join would
 * make most of the integration tier a violation at once, which is a cutover for
 * its own change rather than a condition this module can widen quietly.
 */

export type AmbientTransactionOptionsDiscard = {
  /** The options the ambient-join path could not honor. */
  readonly discarded: { readonly maxWait?: number; readonly timeout?: number };
  /** Capture site of the nested `withDb.tx` call, for naming it to a human. */
  readonly stack: string | undefined;
};

type Observer = (discard: AmbientTransactionOptionsDiscard) => void;

const observers = new Set<Observer>();

/**
 * Register an observer for `withDb.tx` calls whose `maxWait`/`timeout` the
 * ambient-join path discarded. Returns the un-register function; callers MUST
 * call it (a `finally`), or the observer outlives the case that installed it.
 *
 * NOT async-context scoped. Every registered observer sees every discard in the
 * process, so two `autoRollbackTransaction` calls in flight at once — a
 * `describe.concurrent`/`it.concurrent` suite, or a `Promise.all` over two of
 * them — would cross-report. Nothing in `apps/api` does that today and Vitest's
 * default per-file isolation keeps this Set from spanning files; a suite that
 * wants concurrency needs this keyed by `AsyncLocalStorage` first.
 *
 * Test-harness seam. Nothing in production registers one.
 */
export function observeAmbientTransactionOptionDiscards(
  observer: Observer
): () => void {
  observers.add(observer);
  return () => {
    observers.delete(observer);
  };
}

/** True when at least one observer is listening — the production fast path. */
export function hasAmbientTransactionOptionObserver(): boolean {
  return observers.size > 0;
}

/**
 * Report one discard to every registered observer.
 *
 * An observer that throws is SWALLOWED, deliberately: this runs on the
 * ambient-join path immediately before `fn(tx)`, so a propagating diagnostic
 * would stop the transactional body under test from running at all — a
 * reporting side channel turning into a behaviour change, which is the one thing
 * this seam must never do.
 */
export function reportAmbientTransactionOptionDiscard(
  discard: AmbientTransactionOptionsDiscard
): void {
  for (const observer of observers) {
    try {
      observer(discard);
    } catch {
      // See above: a broken observer must not break the caller it observes.
    }
  }
}
