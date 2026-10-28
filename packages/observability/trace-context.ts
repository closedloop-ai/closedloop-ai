// ---------------------------------------------------------------------------
// Trace-context bridge for the structured logger (ISS-4659).
//
// `@repo/observability/log` is imported by client components — see the
// `typeof window === "undefined"` guard at the bottom of log.ts, and the live
// importers `packages/collaboration/client/liveblocks-error-boundary.tsx` and
// `apps/web/app/[locale]/global-error.tsx`. It therefore must NEVER statically
// import an OpenTelemetry package: that would pull the Node SDK into every
// browser bundle that reaches the logger.
//
// Instead the server-side tracer registers a provider here at startup, and the
// logger reads the active trace through this indirection. With no provider
// registered — every browser bundle, and any server runtime with tracing
// disabled — this module is a handful of bytes and returns `undefined`.
//
// This mirrors the existing `setPoolTelemetrySink` injection in
// `packages/database`, which exists for the same reason: to keep a package free
// of a dependency it must not carry. It stored the registration in a
// module-local binding, which ISS-5857 established is exactly what does not
// survive bundling (see `TRACE_CONTEXT_PROVIDER` below) — so it carried the
// same defect until ISS-6942 moved it, and `setSchemaBootstrapHook` beside it,
// onto the same kind of `globalThis` slot. `setSpanFlushHook` in
// `./tracing/hooks` did too until ISS-6817.
// ---------------------------------------------------------------------------

/** The active span's identifiers, as OpenTelemetry reports them (lowercase hex). */
export type TraceContext = {
  /** 128-bit trace id, 32 lowercase hex characters. */
  traceId: string;
  /** 64-bit span id, 16 lowercase hex characters. */
  spanId: string;
};

/** Returns the currently-active trace context, or `undefined` when untraced. */
export type TraceContextProvider = () => TraceContext | undefined;

/**
 * Where the registered provider lives: one process-wide slot, not a
 * module-local binding.
 *
 * ISS-5857. A module-local `let` does not survive bundling. Turbopack merges
 * this module into each importer's chunk group, so the `apps/api` build emits
 * two copies of it: one that `tracing/provider.ts` reaches from the
 * instrumentation entry, and one inlined into the `log.ts` that every route
 * handler loads. Nothing in that second copy ever calls the setter, so the
 * bundler goes further and constant-folds its read to `undefined` — the
 * emitted route code is literally `function(){try{return}catch{return}}()`.
 * No runtime registration could ever reach it, which is why
 * `service:cl-api @dd.trace_id:*` matched 0 of 46,577 logs rather than some
 * of them.
 *
 * A `Symbol.for` key on `globalThis` is opaque to the bundler and shared by
 * every copy it emits, so registration and read meet whichever chunks they
 * land in. It is the same reason `@opentelemetry/api` keeps its own globals
 * there instead of in module scope.
 */
const TRACE_CONTEXT_PROVIDER = Symbol.for(
  "closedloop.observability.traceContextProvider"
);

type TraceContextGlobal = typeof globalThis & {
  [TRACE_CONTEXT_PROVIDER]?: TraceContextProvider;
};

const traceContextGlobal = globalThis as TraceContextGlobal;

/**
 * Whether this runtime may touch the slot at all.
 *
 * `Symbol.for` returns a REGISTERED symbol, so the key above is discoverable by
 * any code sharing the realm — and this module ships to browsers (see the file
 * header). Ungated, a third-party script or an XSS payload could assign the
 * slot and both run on every `log.*` call and forge the `dd.trace_id` the
 * spoofing test in `__tests__/log-trace-correlation.test.ts` exists to prevent.
 * The module-local binding this replaces was unreachable from outside, so the
 * gate is what keeps that property rather than trading it away for the fix.
 *
 * Nothing is lost by gating: the tracer bootstrap is server-only, so a browser
 * never had a provider to read. The same `typeof window` shape `log.ts` uses
 * for its server-only diagnostics, which also lets a browser build drop this
 * module's body entirely.
 */
const IS_SERVER_RUNTIME = typeof window === "undefined";

/**
 * Register the process-wide trace-context provider. Called once by the tracer
 * bootstrap in `@repo/observability/tracing`; never by application code, and
 * inert off the server.
 */
export function setTraceContextProvider(provider: TraceContextProvider): void {
  if (!IS_SERVER_RUNTIME) {
    return;
  }
  traceContextGlobal[TRACE_CONTEXT_PROVIDER] = provider;
}

/**
 * Clear the registered provider. Used by tests and by tracer shutdown, and
 * inert off the server.
 *
 * Gated for the same reason the setter is. ISS-6817 (review davetho) found
 * this gap on the `./tracing/hooks` sibling; it was identical here, and the two
 * slots are cleared by the same line of `resetTracingForTest`, so leaving one
 * ungated would have re-opened exactly the drift between these siblings that
 * ISS-6817 closed. A DELETE is easy to read as harmless, but it is still a write
 * to a slot a browser runtime does not own: the registered symbol is
 * discoverable realm-wide, so off-server this would clear whatever another
 * holder of that key had put there.
 *
 * Deletes rather than assigns `undefined`, so "cleared" and "never registered"
 * stay the same state for anything probing the slot with `in` or `Reflect`.
 */
export function resetTraceContextProvider(): void {
  if (!IS_SERVER_RUNTIME) {
    return;
  }
  Reflect.deleteProperty(traceContextGlobal, TRACE_CONTEXT_PROVIDER);
}

/**
 * Read the active trace context. Never throws — a provider that fails must not
 * be able to break a `log.info()` call.
 */
export function getTraceContext(): TraceContext | undefined {
  if (!IS_SERVER_RUNTIME) {
    return undefined;
  }
  const provider = traceContextGlobal[TRACE_CONTEXT_PROVIDER];
  if (!provider) {
    return undefined;
  }
  try {
    return provider();
  } catch {
    return undefined;
  }
}

/**
 * Map a trace context onto the log attributes Datadog joins traces on.
 *
 * Kept as a single pure function because the correct encoding for
 * OTLP-ingested traces is the one thing here that rollout has to confirm:
 * Datadog's classic (dd-trace) correlation expects decimal ids, while OTLP
 * ingestion carries the W3C hex form. If verification shows Datadog wants a
 * different encoding, this function is the only thing that changes.
 */
export function toLogCorrelationFields(
  context: TraceContext
): Record<string, string> {
  return {
    "dd.trace_id": context.traceId,
    "dd.span_id": context.spanId,
  };
}
