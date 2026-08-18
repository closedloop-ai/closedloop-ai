import type { Harness } from "../types.js";
import type { HistoricalParseResult } from "./historical-parse-source.js";

/** Off-main-process parser used for automatic historical maintenance sweeps. */
export type HistoricalParseRunner = {
  /**
   * Parse one source off the main process. Dispatch is serialized across the
   * five concurrent boot-import loops (a shared worker turn runs one request at a
   * time), so a call can wait in the queue before its request is posted.
   *
   * ISS-4572: `onDispatch` (optional) is invoked synchronously EXACTLY ONCE at the
   * moment this request is actually dispatched to the worker — past the shared
   * dispatch-tail wait — so a caller's per-source deadline can start at dispatch
   * rather than at enqueue, and a source waiting behind a poison parse does not
   * charge that queue wait to its own bound.
   *
   * ISS-5266: resolves with the parse's sessions AND any side-report it
   * produced. A collector side effect that reaches storage through an injected
   * sink cannot work out here — the parse ran on a different collector instance,
   * in another process, with no DB handle — so whatever the parse learned has to
   * come back as DATA on this result and be applied by the main process.
   */
  parseSource(
    collectorKey: Harness,
    source: string,
    onDispatch?: () => void
  ): Promise<HistoricalParseResult>;
  /**
   * Stop any active worker and reject in-flight parser jobs. The runner remains
   * reusable so collector restarts can spawn a fresh worker lazily.
   */
  stop(): void;
  /**
   * ISS-4444 (optional): abort the currently-running parse turn — kill the worker
   * process so a catastrophic CPU-spin inside a parser stops pegging a core after
   * the manager's per-source parse watchdog has already given up and moved on. The
   * runner stays reusable: the NEXT parseSource lazily spawns a fresh worker. A
   * no-op is a safe default (an in-process parse cannot be preempted), so the field
   * is optional and callers must degrade gracefully when it is absent.
   */
  abortInFlightParse?(): void;
};

/**
 * A {@link HistoricalParseRunner} that DOES implement the optional ISS-4444
 * abort capability. `abortInFlightParse` is optional on the base contract so
 * in-process runners (which cannot preempt a parse) satisfy it; this alias is
 * the return type of a factory that owns a killable worker process, and its
 * whole job is to fail typecheck if such a factory ever stops providing the
 * method.
 *
 * It does NOT remove the existence probe at the call site. `CollectorManager`
 * accepts `historicalParseRunner?: HistoricalParseRunner` — it must, so
 * in-process and test runners remain injectable — so the dispatch in
 * `collector-manager.ts` stays `?.abortInFlightParse?.()` and degrades to a
 * no-op for a runner that cannot preempt. Narrowing that option to this type
 * would buy an unconditional call at the cost of rejecting every runner without
 * a worker process, which is not a trade this contract wants.
 */
export type AbortableHistoricalParseRunner = HistoricalParseRunner & {
  abortInFlightParse(): void;
};
