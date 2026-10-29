// ---------------------------------------------------------------------------
// SDK-free tracing seam (ISS-4659).
//
// This is the module application code imports to flush spans. It deliberately
// has NO OpenTelemetry import, so pulling it in never drags the Node SDK along.
//
// `apps/api/lib/route-utils.ts` is the reason. It is imported by ~40 route
// modules; if it reached the SDK through a static import, the first route that
// ever opts into the edge runtime would fail to build — the same class of
// evaluation-order trap that `apps/api/instrumentation.ts` already guards
// against with a dynamic import and an AST test. Routing the flush through a
// registered hook removes the hazard structurally instead of relying on nobody
// adding an edge route later.
//
// `./provider` registers the real implementation when the tracer starts; until
// then every call here is inert. Same injection shape as `setPoolTelemetrySink`
// in `packages/database`, and — since ISS-6817 — the same STORAGE as
// `setTraceContextProvider` in `../trace-context`.
// ---------------------------------------------------------------------------

/** Flushes buffered spans. Registered by the tracer bootstrap. */
export type SpanFlushHook = () => Promise<void>;

/**
 * Where the registered hook lives: one process-wide slot, not a module-local
 * binding.
 *
 * ISS-6817, the sibling of ISS-5857. A module-local `let` does not survive
 * bundling. The `apps/api` Turbopack build emits this module into three chunk
 * groups; `./provider` reaches the instrumentation entry's copy, while 265 of
 * the 283 route entries load one of two route-side copies where the binding is
 * emitted as a bare `let t;` that nothing ever assigns — `setSpanFlushHook` is
 * tree-shaken out of those chunks entirely, because `route-utils` imports only
 * the two readers. `isTracingActive()` is inlined at its one call site as
 * `if(void 0===t)return;`, so the pre-freeze span flush was unconditionally
 * skipped on every route.
 *
 * A `Symbol.for` key on `globalThis` is opaque to the bundler and shared by
 * every copy it emits, so registration and read meet whichever chunks they land
 * in. Same key shape, and same reason, as `TRACE_CONTEXT_PROVIDER`.
 */
const SPAN_FLUSH_HOOK = Symbol.for("closedloop.observability.spanFlushHook");

type SpanFlushGlobal = typeof globalThis & {
  [SPAN_FLUSH_HOOK]?: SpanFlushHook;
};

const spanFlushGlobal = globalThis as SpanFlushGlobal;

/**
 * Whether this runtime may touch the slot at all.
 *
 * `Symbol.for` returns a REGISTERED symbol, so the key above is discoverable
 * and writable by any code sharing the realm, and `packages/observability`
 * ships to browsers. The module-local binding this replaces was unreachable
 * from outside the module; the gate is what keeps that property rather than
 * trading it away for the fix — the same reasoning, and the same `typeof
 * window` shape, as `../trace-context`.
 *
 * Unlike `getTraceContext`, this seam has no browser reader today: its one
 * importer, `apps/api/lib/route-utils.ts`, is server-only, so a planted hook
 * has nothing to run it. The gate is what keeps that true if the seam ever
 * gains one, and it costs nothing — the tracer bootstrap is server-only, so a
 * browser never had a hook to register.
 */
const IS_SERVER_RUNTIME = typeof window === "undefined";

/**
 * Register the process-wide span-flush implementation. Called once by
 * `./provider` after the tracer is installed; never by application code, and
 * inert off the server.
 */
export function setSpanFlushHook(hook: SpanFlushHook): void {
  if (!IS_SERVER_RUNTIME) {
    return;
  }
  spanFlushGlobal[SPAN_FLUSH_HOOK] = hook;
}

/**
 * Clear the hook. Used by tracer shutdown and by tests, and inert off the
 * server.
 *
 * Gated for the same reason the setter is, which is easy to miss because a
 * DELETE looks harmless: it is still a write to a slot this runtime does not own
 * (review davetho). The module states that non-server runtimes must not touch
 * the slot, and a browser copy reaching this function would clear a value in its
 * realm that some other holder of the same registered symbol had put there.
 * Ungated, one of the three slot-touching functions here would contradict the
 * invariant the other two enforce.
 *
 * Deletes rather than assigns `undefined`, so "cleared" and "never registered"
 * stay the same state for anything probing the slot with `in` or `Reflect`.
 */
export function resetSpanFlushHook(): void {
  if (!IS_SERVER_RUNTIME) {
    return;
  }
  Reflect.deleteProperty(spanFlushGlobal, SPAN_FLUSH_HOOK);
}

/**
 * Whether a tracer is installed and therefore has spans worth flushing.
 *
 * Callers use this to avoid scheduling flush work at all when tracing is off —
 * every local run, every CI worker, any deploy with the kill switch set.
 * `flushSpans()` is already inert in that state, but *scheduling* it is not
 * free: it consumes a `waitUntil` slot on the serverless response, and route
 * tests legitimately assert on how much deferred work a request schedules.
 */
export function isTracingActive(): boolean {
  return readSpanFlushHook() !== undefined;
}

/**
 * Flush buffered spans. Never rejects — a failed export must not surface as a
 * failed request — and resolves immediately when no tracer is installed.
 */
export async function flushSpans(): Promise<void> {
  const hook = readSpanFlushHook();
  if (!hook) {
    return;
  }
  try {
    await hook();
  } catch {
    // Best-effort, by contract.
  }
}

/**
 * The single read of the slot, so the gate and the "is this usable" test cannot
 * drift between the two readers. Anything but a function counts as absent: the
 * slot is writable by anything sharing the realm, and an `isTracingActive()`
 * that answered `true` for a planted `null` would make every request schedule
 * an `after()` callback for a flush that can never run.
 */
function readSpanFlushHook(): SpanFlushHook | undefined {
  if (!IS_SERVER_RUNTIME) {
    return undefined;
  }
  const hook = spanFlushGlobal[SPAN_FLUSH_HOOK];
  return typeof hook === "function" ? hook : undefined;
}
