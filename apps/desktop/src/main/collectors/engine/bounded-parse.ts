import type { Harness, NormalizedSession } from "../types.js";

/**
 * ISS-4444: default per-source wall-clock bound for the historical parse await.
 *
 * The boot-import loop `await`s `parseSource(source)` once per transcript. The
 * ISS-4410 fix bounded the *write* (`importSession`); this is the sibling bound
 * for the *parse*. Two real failure modes never THROW, so the loop's existing
 * try/catch dead-letter `continue` never fires and the whole 1545-source import
 * wedges at `1/1545`:
 *
 * 1. A catastrophic-regex-backtrack / CPU-spin inside a parser on a pathological
 *    transcript — the parse promise never settles, and the parser pegs a CPU
 *    core indefinitely.
 * 2. (The import-write hang — bounded separately by ISS-4410.)
 *
 * A `setTimeout` alone cannot preempt a synchronous CPU-spin in the SAME isolate.
 * In production `parseSource` runs in the Electron utility-process worker turn
 * (`historicalParseRunner`), which is separately abandonable and killable — so the
 * manager can move on even while the worker turn is still spinning, and (via the
 * optional `onTimeout` abort hook) signal the worker to kill that turn so the pegged
 * core is reclaimed. When the runner is absent (tests, golden mode) the parse runs
 * in-process and this bound cannot preempt a synchronous spin; it still lets the
 * loop advance once the turn yields (the residual is documented on the manager).
 *
 * Generous enough that a legitimately large single-transcript parse completes well
 * within it. Tests pin it small; `null` disables the bound (restores the prior
 * unbounded await). 90 seconds — comfortably under the 5-minute utility-process
 * worker timeout so the manager gives up (and abandons/aborts the turn) before the
 * worker's own kill fires.
 */
export const HISTORICAL_PARSE_TIMEOUT_MS = 90_000;

/**
 * ISS-4572 (wongk / T9 review): the multiple of the dispatch bound used as the
 * default ENQUEUE-SCOPED ABSOLUTE CEILING backstop (see {@link parseSourceBounded}).
 * The dispatch-scoped clock is primary and only arms when the invoker fires
 * `onDispatch`; the ceiling arms at ENQUEUE and guarantees the bound resolves even
 * if a (present or future) runner accepts `onDispatch` but never calls it — which
 * would otherwise leave the deadline unarmed and the boot import waiting forever.
 * The factor is generous: the five harness loops share one serialized dispatch
 * tail, so a legitimately-queued source can wait several dispatch windows behind
 * in-flight parses before its own dispatch; the ceiling must never fire for that
 * honest queue wait, only for a never-dispatched (broken-signal) parse. 6× the
 * dispatch bound (~9 min at the 90s default) sits comfortably above any real
 * five-loop queue wait while still bounding a genuinely unarmed deadline.
 */
export const HISTORICAL_PARSE_ENQUEUE_CEILING_FACTOR = 6;

/**
 * ISS-4444: the outcome of a bounded parse. `timedOut` distinguishes the wedge
 * this bound guards against (dead-letter + continue + count a quarantine attempt)
 * from the two other outcomes the caller already handles: a normal resolve
 * (`sessions`) and a genuine throw (a partially-written mid-turn file — normal —
 * which the caller's existing catch continues past WITHOUT counting a quarantine
 * attempt, since a throw is not a wedge).
 */
export type BoundedParseOutcome =
  | { timedOut: false; sessions: NormalizedSession[] }
  | { timedOut: true };

/**
 * ISS-4444: the parse invoker handed to {@link parseSourceBounded}. It runs the
 * actual parse and, in production, drives it through the utility-process runner's
 * serialized dispatch tail. It is handed an `onDispatch` callback it MUST invoke
 * exactly once, at the moment the parse is actually DISPATCHED to the worker (past
 * the shared dispatch-tail wait) — or, for an in-process parse, at the moment it
 * begins. That signal is what {@link parseSourceBounded} uses to start the
 * deadline clock (ISS-4572).
 */
export type BoundedParseInvoker = (
  source: string,
  onDispatch: () => void
) => Promise<NormalizedSession[]>;

/**
 * ISS-4444 / ISS-4572: run one historical `parseSource` under a wall-clock bound.
 * Only the TIMEOUT is treated specially: if the parse does not settle within
 * `timeoutMs` OF ITS DISPATCH, this resolves to `{ timedOut: true }` so the caller
 * dead-letters the source and advances the loop instead of the whole boot import
 * wedging on a poison transcript. The optional `onTimeout` hook lets the caller
 * abort/kill the still-running worker turn (reclaiming the pegged CPU core); it is
 * best-effort and never blocks the resolve.
 *
 * ISS-4572 — the PRIMARY deadline is DISPATCH-scoped, not enqueue-scoped. The five
 * harness boot-import loops fan out concurrently and share the utility-process
 * runner's serialized `dispatchTail`, so a queued source can sit behind an
 * in-flight (even poison) parse before its request is posted to the worker.
 * Starting the ~90s clock at ENQUEUE would charge that queue wait to this source's
 * own bound and let it record a SPURIOUS quarantine attempt for a transcript that
 * never actually got its full parse window. The clock therefore arms only when the
 * `invoker` fires its `onDispatch` callback — the moment the request is genuinely
 * dispatched to the worker (or, in-process, when the parse begins). A source
 * waiting in the queue has NO precise deadline running.
 *
 * ISS-4572 (wongk / T9 review) — but `onDispatch` is OPTIONAL on the runner
 * interface (it also serves the unbounded data-revision-rebuild caller), so a
 * present-or-future bounded runner that accepts `onDispatch` and never calls it
 * would leave the precise deadline unarmed and this bound waiting forever. To close
 * that, an ENQUEUE-SCOPED ABSOLUTE CEILING is armed immediately (at enqueue), set
 * generously above any honest five-loop queue wait
 * ({@link HISTORICAL_PARSE_ENQUEUE_CEILING_FACTOR}× the dispatch bound by default).
 * It is a pure backstop: when `onDispatch` fires normally, the ceiling is CLEARED
 * and the precise dispatch clock takes over, so a legitimately-queued source is
 * never charged its queue wait; only a never-dispatched (broken-signal) parse ever
 * trips the ceiling. Pass `enqueueCeilingMs = null` to disable it (tests that pin
 * the dispatch behavior in isolation).
 *
 * A late resolve/reject that arrives after the bound is harmless — the timer is
 * cleared on settle and the late result is ignored via `settled`. The underlying
 * parse promise is intentionally left to settle on its own (or is abandoned when
 * the worker turn is killed); this only stops it from BLOCKING the sweep.
 *
 * A GENUINE throw/rejection is propagated unchanged (mirroring
 * `importSessionBounded`): a partially-written mid-turn transcript is a normal
 * parse error the caller's existing try/catch already handles, and it must NOT be
 * conflated with the timeout wedge. Both a synchronous throw and an async rejection
 * route through the same cleanup so a sync throw cannot leave the timer running to
 * later resolve a bogus timeout.
 */
export function parseSourceBounded(
  invoker: BoundedParseInvoker,
  log: (message: string) => void,
  harness: Harness,
  source: string,
  timeoutMs: number,
  onTimeout?: () => void,
  // ISS-4572 (wongk / T9): the enqueue-scoped absolute ceiling backstop. Defaults
  // to a generous multiple of the dispatch bound; pass `null` to disable it.
  enqueueCeilingMs: number | null = timeoutMs *
    HISTORICAL_PARSE_ENQUEUE_CEILING_FACTOR
): Promise<BoundedParseOutcome> {
  return new Promise<BoundedParseOutcome>((resolve, reject) => {
    let settled = false;
    // The precise DISPATCH-scoped deadline (armed by onDispatch).
    let timer: NodeJS.Timeout | null = null;
    // The ENQUEUE-scoped absolute ceiling backstop (armed immediately).
    let ceilingTimer: NodeJS.Timeout | null = null;
    const clearTimer = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const clearCeiling = (): void => {
      if (ceilingTimer !== null) {
        clearTimeout(ceilingTimer);
        ceilingTimer = null;
      }
    };
    const clearAllTimers = (): void => {
      clearTimer();
      clearCeiling();
    };
    // Shared timeout resolution for both the dispatch clock and the enqueue
    // ceiling: dead-letter this pass and best-effort abort the worker turn.
    const resolveTimedOut = (reason: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearAllTimers();
      log(
        `historical parse for ${harness} source ${source} exceeded ${reason} and was dead-lettered this pass; the source is left unmarked to retry on the next launch`
      );
      // Best-effort: abort/kill the still-running worker turn so a CPU-spin does
      // not keep pegging a core after the manager has moved on. Never let a
      // throwing abort hook fail the resolve.
      try {
        onTimeout?.();
      } catch {
        /* best-effort abort — the timeout outcome still resolves */
      }
      resolve({ timedOut: true });
    };
    // ISS-4572: arm the PRECISE deadline only when the parse is actually DISPATCHED
    // to the worker (past the shared dispatch-tail wait), not when this bound is
    // enqueued. Dispatch supersedes the enqueue ceiling — clear it so a
    // legitimately-queued source is never charged its queue wait. Guarded against a
    // double-fire so a runner that (incorrectly) signals dispatch twice cannot start
    // two competing timers.
    const startDeadline = (): void => {
      if (settled || timer !== null) {
        return;
      }
      // The precise dispatch clock takes over from the enqueue-ceiling backstop.
      clearCeiling();
      timer = setTimeout(
        () => resolveTimedOut(`${timeoutMs}ms after dispatch`),
        timeoutMs
      );
      timer.unref?.();
    };
    const finish = (sessions: NormalizedSession[]): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearAllTimers();
      resolve({ timedOut: false, sessions });
    };
    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearAllTimers();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    // ISS-4572 (wongk / T9): arm the enqueue-scoped absolute ceiling NOW, before
    // dispatch, so the bound can never wait forever if `onDispatch` is never fired
    // (a runner that omits or forgets the signal). Cleared by `startDeadline` on a
    // normal dispatch, so it only ever fires for a genuinely-unarmed deadline.
    if (enqueueCeilingMs !== null) {
      ceilingTimer = setTimeout(
        () =>
          resolveTimedOut(
            `${enqueueCeilingMs}ms enqueue ceiling (never dispatched)`
          ),
        enqueueCeilingMs
      );
      ceilingTimer.unref?.();
    }
    try {
      Promise.resolve(invoker(source, startDeadline)).then(finish, fail);
    } catch (error) {
      fail(error);
    }
  });
}
