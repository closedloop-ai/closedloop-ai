// ---------------------------------------------------------------------------
// Tracing configuration (ISS-4659).
//
// Pure env resolution — deliberately free of any OpenTelemetry import so it can
// be unit-tested, and read from, without pulling the Node SDK in. The SDK lives
// behind `./provider`, which is the only module that imports it.
//
// Mirrors log.ts's `loadConfig()`: `keys()` first, falling back to raw
// `process.env` reads because `keys()` throws outside a Next.js runtime (the
// standalone relay, the containerized E2E server, a test worker).
// ---------------------------------------------------------------------------

import { keys } from "../keys";
import { isLoopbackUrl } from "../loopback-url";

/** Why tracing is inert. Surfaced in diagnostics so a silent no-op is explainable. */
export const TracingDisabledReason = {
  /** `DD_TRACING_DISABLED` was set truthy. */
  ExplicitlyDisabled: "explicitly_disabled",
  /**
   * No `DD_API_KEY`, and the endpoint is not a loopback collector that
   * authenticates the export itself — nothing would authenticate it.
   */
  MissingApiKey: "missing_api_key",
  /** No OTLP endpoint configured. See `resolveTracesEndpoint`. */
  MissingEndpoint: "missing_endpoint",
  /** Not a deployed runtime, and tracing was not explicitly opted into. */
  NotDeployed: "not_deployed",
  /** The SDK bootstrap threw. The process stays untraced rather than broken. */
  InitFailed: "init_failed",
} as const;
export type TracingDisabledReason =
  (typeof TracingDisabledReason)[keyof typeof TracingDisabledReason];

export type TracingConfig =
  | {
      enabled: true;
      endpoint: string;
      /** Unset when a loopback collector sidecar authenticates the export. */
      apiKey: string | undefined;
      service: string;
      env: string;
      sampleRate: number;
    }
  | { enabled: false; reason: TracingDisabledReason };

/**
 * Conservative default head-sampling rate. APM ingest is billed, and `cl-api`
 * serves a high-volume desktop-sync surface, so the default deliberately
 * under-samples; raise it per environment via `DD_TRACE_SAMPLE_RATE`.
 */
const DEFAULT_SAMPLE_RATE = 0.1;
const MIN_SAMPLE_RATE = 0;
const MAX_SAMPLE_RATE = 1;

const TRUTHY_FLAG_VALUES = new Set(["1", "true"]);

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value !== undefined && value.length > 0 ? value : undefined;
}

/** Datadog identity, resolved the same way the logger resolves it. */
function loadDatadogIdentity(): {
  apiKey: string | undefined;
  service: string;
  env: string;
} {
  try {
    const env = keys();
    return {
      apiKey: env.DD_API_KEY,
      service: env.DD_SERVICE ?? "cl-unknown",
      env: env.DD_ENV ?? process.env.NODE_ENV ?? "development",
    };
  } catch {
    // keys() throws outside Next.js (standalone relay, container, test worker).
    return {
      apiKey: readEnv("DD_API_KEY"),
      service: readEnv("DD_SERVICE") ?? "cl-unknown",
      env: readEnv("DD_ENV") ?? process.env.NODE_ENV ?? "development",
    };
  }
}

/**
 * The OTLP traces endpoint, e.g. `https://<datadog-otlp-intake>/v1/traces`.
 *
 * Intentionally has **no implicit default**. A wrong endpoint does not fail
 * loudly — it black-holes every span while the service looks instrumented — so
 * the host is explicit deployment configuration rather than something this code
 * guesses from `DD_SITE`. Unset means tracing stays off, which is the safe
 * direction.
 */
export function resolveTracesEndpoint(): string | undefined {
  return readEnv("DD_OTLP_TRACES_ENDPOINT");
}

/**
 * Head-sampling rate in [0, 1]. A malformed or out-of-range value falls back to
 * the default rather than disabling tracing or sampling everything: both of
 * those turn a typo into either blindness or an unbounded bill.
 *
 * Parsed with `Number`, not `Number.parseFloat`: `parseFloat` accepts a numeric
 * PREFIX, so `"1oops"` would parse as `1` and silently switch the service to
 * 100% sampling — the exact opposite of the documented malformed-value
 * fallback, and an expensive way to learn about a typo. `Number` rejects the
 * whole string.
 */
export function resolveSampleRate(): number {
  const raw = readEnv("DD_TRACE_SAMPLE_RATE");
  if (raw === undefined) {
    return DEFAULT_SAMPLE_RATE;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_SAMPLE_RATE;
  }
  return Math.min(MAX_SAMPLE_RATE, Math.max(MIN_SAMPLE_RATE, parsed));
}

/**
 * Whether this runtime should trace at all.
 *
 * Defaults **off** outside a deployed runtime. `DD_API_KEY` is not a
 * deployed-runtime signal — CI steps hold it to post metrics, and until
 * ISS-12354 every instrumented test lane held it for dd-trace (see the note at
 * the top of log.ts) — so keying purely off its presence would turn a CI
 * process into a span exporter. `VERCEL`
 * is the same deployed-runtime signal `resolveStructuredConsole()` already
 * uses. `DD_TRACING_ENABLED=1` opts a non-Vercel runtime in deliberately.
 */
export function resolveTracingConfig(): TracingConfig {
  if (TRUTHY_FLAG_VALUES.has(process.env.DD_TRACING_DISABLED ?? "")) {
    return { enabled: false, reason: TracingDisabledReason.ExplicitlyDisabled };
  }

  const deployed =
    Boolean(process.env.VERCEL) ||
    TRUTHY_FLAG_VALUES.has(process.env.DD_TRACING_ENABLED ?? "");
  if (!deployed) {
    return { enabled: false, reason: TracingDisabledReason.NotDeployed };
  }

  const identity = loadDatadogIdentity();
  const endpoint = resolveTracesEndpoint();
  const viaCollector = endpoint !== undefined && isLoopbackUrl(endpoint);
  if (identity.apiKey === undefined && !viaCollector) {
    return { enabled: false, reason: TracingDisabledReason.MissingApiKey };
  }

  if (!endpoint) {
    return { enabled: false, reason: TracingDisabledReason.MissingEndpoint };
  }

  return {
    enabled: true,
    endpoint,
    // The collector adds the key itself, so none is sent to it, as with the
    // log forwarder (log.ts).
    apiKey: viaCollector ? undefined : identity.apiKey,
    service: identity.service,
    env: identity.env,
    sampleRate: resolveSampleRate(),
  };
}
