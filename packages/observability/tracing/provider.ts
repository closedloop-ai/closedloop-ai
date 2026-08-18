// ---------------------------------------------------------------------------
// OpenTelemetry tracer bootstrap for server runtimes (ISS-4659).
//
// This is the ONLY module in @repo/observability that imports the OpenTelemetry
// SDK. `log.ts` reaches the active trace through `../trace-context` instead,
// because the logger is bundled into browsers (see the header of that file).
// Keep it that way: a static OTel import anywhere in the logger's graph ships
// the Node SDK to every end user.
//
// Everything here is fail-open. Tracing is a diagnostic aid; it must never add
// latency to, or fail, a request. Callers get a boolean, never an exception.
// ---------------------------------------------------------------------------

import { context, propagation, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-node";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { resolveServerVersion } from "../telemetry/context";
import {
  resetTraceContextProvider,
  setTraceContextProvider,
} from "../trace-context";
import {
  resolveTracingConfig,
  type TracingConfig,
  TracingDisabledReason,
} from "./config";
import { resetSpanFlushHook, setSpanFlushHook } from "./hooks";
import { RemoteParentEntropySampler } from "./remote-parent-sampler";
import { RouteResourceSpanProcessor } from "./route-resource-processor";

/** Datadog's OTLP intake authenticates with this header, not a bearer token. */
const DATADOG_API_KEY_HEADER = "dd-api-key";

/**
 * Resource attribute recording the head-sampling rate the process ran with, so
 * ingest volume is auditable from the spans themselves rather than from
 * whatever the deploy config happened to be at the time.
 */
const ATTR_TRACE_SAMPLE_RATE = "cl.trace.sample_rate";

let tracerProvider: NodeTracerProvider | undefined;
let initResult: TracingConfig | undefined;

/**
 * Initialise the tracer once per process. Safe to call repeatedly — subsequent
 * calls return the FIRST call's outcome, matching the `initDatadogRum`
 * idempotence pattern.
 *
 * Returning the cached outcome matters: re-resolving the config on a later call
 * would report whatever the environment says *now*, which can disagree with the
 * tracer that actually got installed (or with a bootstrap that failed). A
 * caller logging that answer would describe a tracer that does not exist.
 *
 * Returns whether tracing is active, so the caller can report *why* it is not
 * without this module deciding how to log.
 */
export function initTracing(): TracingConfig {
  if (initResult) {
    return initResult;
  }

  const config = resolveTracingConfig();
  initResult = config;
  if (!config.enabled) {
    return config;
  }

  try {
    const provider = createTracerProvider(config);
    // Instrumentation is registered BEFORE the provider is installed globally.
    // Both steps can throw, and doing it the other way round would leave a
    // globally-registered tracer behind after a failed bootstrap — spans would
    // be produced with nothing tracking the provider to flush them. Failing
    // before the global is touched keeps the failure clean.
    registerInstrumentations({
      // `pg` is what Prisma's driver adapter (`@prisma/adapter-pg`) actually
      // issues queries through, so patching the module here is what produces
      // per-query child spans WITHOUT `packages/database` gaining an
      // observability dependency it deliberately does not carry.
      instrumentations: [new PgInstrumentation()],
      tracerProvider: provider,
    });
    provider.register();
    tracerProvider = provider;
    setTraceContextProvider(readActiveTraceContext);
    setSpanFlushHook(forceFlushSpans);
    return config;
  } catch {
    // A failed bootstrap must leave the process untraced, not broken.
    tracerProvider = undefined;
    initResult = { enabled: false, reason: TracingDisabledReason.InitFailed };
    return initResult;
  }
}

/**
 * Flush buffered spans. On Vercel the function freezes as soon as the response
 * is returned, so a `BatchSpanProcessor` would drop whatever is still buffered.
 *
 * Application code does NOT call this directly — it calls `flushSpans()` from
 * `./hooks`, the SDK-free seam this registers into. Keeping the app's import
 * off this module is what stops the OpenTelemetry SDK from being reachable from
 * `route-utils.ts` and, through it, every route.
 */
async function forceFlushSpans(): Promise<void> {
  await tracerProvider?.forceFlush();
}

/**
 * Test seam: tear the tracer down so a suite can re-initialise from a clean
 * state.
 *
 * Shuts the provider down and disables the OpenTelemetry globals. Without this
 * a suite that exercises the enabled path leaves a registered global tracer
 * (and its exporter timers) behind for every subsequent test in the worker.
 *
 * **Await it.** `shutdown()` drains the span processor asynchronously; letting
 * it run unawaited lets the next test's `register()` race a provider that is
 * still tearing down, which is precisely the kind of order-dependent flake the
 * repo's determinism rule exists to prevent.
 */
export async function resetTracingForTest(): Promise<void> {
  const provider = tracerProvider;
  tracerProvider = undefined;
  initResult = undefined;
  resetSpanFlushHook();
  resetTraceContextProvider();
  try {
    await provider?.shutdown();
  } catch {
    // Teardown is best-effort; a failed shutdown must not fail the suite.
  }
  trace.disable();
  context.disable();
  propagation.disable();
}

function createTracerProvider(
  config: Extract<TracingConfig, { enabled: true }>
): NodeTracerProvider {
  const exporter = new OTLPTraceExporter({
    url: config.endpoint,
    headers: { [DATADOG_API_KEY_HEADER]: config.apiKey },
  });

  return new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: config.service,
      [ATTR_SERVICE_VERSION]: resolveServerVersion(),
      "deployment.environment.name": config.env,
      [ATTR_TRACE_SAMPLE_RATE]: config.sampleRate,
    }),
    // Remote parents are sampled with SERVER-side entropy — a security
    // property, not a tuning choice. `traceparent` is an untrusted header on a
    // public origin, so neither the caller's sampled bit (AlwaysOn, the
    // `ParentBasedSampler` default) nor anything derived from the caller's
    // trace id can be trusted to bound export. See `./remote-parent-sampler`
    // for why the trace-id-ratio variant is also attacker-defeatable.
    //
    // Root spans keep the trace-id ratio: we mint those ids ourselves, so the
    // determinism is a feature rather than an attack surface.
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(config.sampleRate),
      remoteParentSampled: new RemoteParentEntropySampler(config.sampleRate),
    }),
    // ISS-5856: the route-resource processor stamps each SERVER span's route
    // onto `resource.name`. Without it Datadog derives the resource from the
    // HTTP method alone and all ~40 API routes share four resources, which is
    // what makes per-route DB attribution impossible to read. It stamps in
    // `onEnding`, which the SDK runs for every processor before any `onEnd`, so
    // sitting ahead of the exporter here is convention, not a requirement.
    spanProcessors: [
      new RouteResourceSpanProcessor(),
      new BatchSpanProcessor(exporter),
    ],
  });
}

/**
 * Read the active span's ids for the logger. Returns `undefined` when there is
 * no recording span, so untraced log calls stay byte-identical to pre-ISS-4659.
 *
 * The `isRecording()` check is load-bearing. A sampled-out span is still a real
 * object with a real `spanContext()`, so reading the ids unconditionally would
 * stamp `dd.trace_id` onto logs for traces that are never exported — at the
 * default 10% rate, ~90% of correlated log lines would link to a trace that
 * does not exist in Datadog. A log that points at nothing is worse than a log
 * with no trace id at all.
 */
function readActiveTraceContext():
  | { traceId: string; spanId: string }
  | undefined {
  const span = trace.getSpan(context.active());
  if (!span?.isRecording()) {
    return undefined;
  }
  const spanContext = span.spanContext();
  return { traceId: spanContext.traceId, spanId: spanContext.spanId };
}
