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
// of a dependency it must not carry.
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

const noTraceContext: TraceContextProvider = () => undefined;

let traceContextProvider: TraceContextProvider = noTraceContext;

/**
 * Register the process-wide trace-context provider. Called once by the tracer
 * bootstrap in `@repo/observability/tracing`; never by application code.
 */
export function setTraceContextProvider(provider: TraceContextProvider): void {
  traceContextProvider = provider;
}

/** Restore the default no-op provider. Used by tests and by tracer shutdown. */
export function resetTraceContextProvider(): void {
  traceContextProvider = noTraceContext;
}

/**
 * Read the active trace context. Never throws — a provider that fails must not
 * be able to break a `log.info()` call.
 */
export function getTraceContext(): TraceContext | undefined {
  try {
    return traceContextProvider();
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
