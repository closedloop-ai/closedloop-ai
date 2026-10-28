import { AsyncLocalStorage } from "node:async_hooks";
import { DesktopReadCancelledError } from "../../../shared/read-cancellation-contract.js";

/**
 * @file store-read-cancellation.ts
 * @description ISS-9802 — the STORE THREAD's half of the cancellation token:
 * the only side that can actually stop the work.
 *
 * The op body runs here, and its `yieldDbHostLoop()` checkpoints are the one
 * place it hands the loop back. Binding the token to the op through an
 * `AsyncLocalStorage` scope means the checkpoint can ask "was I cancelled?"
 * without the token being threaded through `aggregateAnalytics` and every other
 * read's signature — the same reasoning as `db-host-call-priority.ts` one hop up.
 *
 * ## ONE token can name SEVERAL in-flight ops
 *
 * A token belongs to one renderer READ, not to one `Execute`, and those are not
 * the same thing: `getSharedAgentSessionsPageData` fans a single read out into
 * `Promise.allSettled([getSharedAgentSessions, getSharedAgentSessionUsage])`,
 * and each of those is its own db-host invoke and its own `Execute` over here.
 * Keying a token to a single state would let the second registration REPLACE the
 * first, so a cancel would stop the last op to start and leave its sibling
 * running the full scan — while the data source advertises that it cancels. That
 * is the same overclaim this ticket exists to correct, so the registry holds a
 * SET of states per token and cancels every one of them.
 *
 * ## The registry cannot grow
 *
 * Both maps below are keyed on a token that arrived from outside the process,
 * which is the shape AGENTS.md requires a bound for.
 *
 * - {@link activeReads} is bounded STRUCTURALLY: a state is created only by an
 *   `Execute` that is about to run and removed when that execute settles, so the
 *   map holds exactly the in-flight cancellable ops.
 * - {@link preCancelledTokens} is bounded by a HARD CAP with FIFO eviction, and
 *   it has to be: it holds tokens that named nothing, which is precisely the
 *   input an unbounded caller controls.
 */

type ReadCancellationState = { cancelled: boolean };

const readCancellationScope = new AsyncLocalStorage<ReadCancellationState>();
const activeReads = new Map<string, Set<ReadCancellationState>>();

/**
 * Tokens cancelled BEFORE any op registered under them.
 *
 * The race is the common case, not an exotic one: TanStack Query aborts on
 * unmount, and an unmount lands routinely while the read is still crossing
 * renderer → main → db-host child → store thread. Without this, that abort is
 * dropped and the scan runs in full — the exact waste the token exists to stop,
 * on the path most likely to produce it.
 *
 * A token is NOT removed when it is consumed, because one token can admit
 * several ops (see the header); it ages out by eviction instead.
 */
const preCancelledTokens = new Set<string>();
const PRE_CANCELLED_TOKEN_LIMIT = 64;

/**
 * Run one store op under `token` so {@link throwIfStoreReadCancelled} can see it.
 *
 * An absent token runs `run` with NO scope entered, which is what makes every
 * op that predates this — every write, every backfill, every read from a peer
 * that does not send a token — uncancellable exactly as it is today.
 */
export function runStoreReadUnderCancellation<T>(
  token: string | undefined,
  run: () => Promise<T>
): Promise<T> {
  if (token === undefined) {
    return run();
  }
  // Honour a cancel that arrived while this op was still in transit, so the
  // abort is not silently lost between the renderer and this thread.
  const state: ReadCancellationState = {
    cancelled: preCancelledTokens.has(token),
  };
  const states = activeReads.get(token) ?? new Set<ReadCancellationState>();
  states.add(state);
  activeReads.set(token, states);
  return readCancellationScope.run(state, run).finally(() => {
    states.delete(state);
    // Drop the key only when its LAST op has settled, so a sibling still running
    // under the same token stays cancellable.
    if (states.size === 0) {
      activeReads.delete(token);
    }
  });
}

/**
 * Run `fn` with NO cancellation scope, whatever the caller was running under.
 *
 * This exists for the write queue, and it is a correctness requirement rather
 * than tidiness. `AsyncLocalStorage` follows the await chain, and the queue
 * starts the next task from inside the PREVIOUS task's settle continuation — so
 * a cancellable read that enqueues a write seeds its own cancellation scope into
 * whatever the queue dispatches next. Left alone, cancelling that read would
 * throw out of an unrelated caller's write at its next checkpoint and LOSE it.
 * Cancellation may abandon a read; it must never abandon a write.
 */
export function runOutsideStoreReadCancellation<T>(
  fn: () => Promise<T>
): Promise<T> {
  return readCancellationScope.exit(fn);
}

/**
 * Mark every in-flight read carrying `token` cancelled.
 *
 * Returns whether it reached one. A token naming nothing is REMEMBERED rather
 * than dropped, because the op it names may still be in transit; that memory is
 * the one thing here an outside caller could grow, so it is hard-capped.
 */
export function markStoreReadCancelled(token: string): boolean {
  // Remembered UNCONDITIONALLY, not only when the token named nothing. One
  // token names one renderer READ, and that read's ops need not all have
  // started: `pageData` fans up to four `aggregateUsage` invokes through a lane
  // that admits two at a time, so an abort landing while the first pair runs
  // marks only those. Recording the verdict here is what makes the siblings
  // still queued behind a lane permit register as already-cancelled instead of
  // starting fresh and executing in full — which is the same overclaim (the
  // source says it cancels; the work runs) this ticket exists to correct.
  rememberPreCancelledToken(token);
  const states = activeReads.get(token);
  if (!states || states.size === 0) {
    return false;
  }
  for (const state of states) {
    state.cancelled = true;
  }
  return true;
}

/** True when the enclosing store op has been cancelled. */
export function isStoreReadCancelled(): boolean {
  return readCancellationScope.getStore()?.cancelled === true;
}

/**
 * Abandon the enclosing store op if it was cancelled.
 *
 * Called at statement boundaries, including `yieldDbHostLoop` and synchronous
 * snapshot checks, never in the middle of a libSQL call.
 */
export function throwIfStoreReadCancelled(): void {
  if (isStoreReadCancelled()) {
    throw new DesktopReadCancelledError();
  }
}

/** @internal Number of registered in-flight cancellable ops; tests only. */
export function activeStoreReadCount(): number {
  let total = 0;
  for (const states of activeReads.values()) {
    total += states.size;
  }
  return total;
}

/** @internal Size of the bounded pre-cancelled ring; tests only. */
export function preCancelledTokenCount(): number {
  return preCancelledTokens.size;
}

/**
 * Record a token whose op has not arrived yet, evicting the oldest past the cap.
 *
 * A `Set` iterates in insertion order, so its first entry IS the oldest — which
 * makes the eviction FIFO without a second structure to keep in step.
 */
function rememberPreCancelledToken(token: string): void {
  if (preCancelledTokens.has(token)) {
    return;
  }
  preCancelledTokens.add(token);
  if (preCancelledTokens.size <= PRE_CANCELLED_TOKEN_LIMIT) {
    return;
  }
  const oldest = preCancelledTokens.values().next();
  if (!oldest.done) {
    preCancelledTokens.delete(oldest.value);
  }
}
