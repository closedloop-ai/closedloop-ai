// ---------------------------------------------------------------------------
// Structured logger with optional agentless Datadog export.
//
// API: same as console — log.info("msg", { key: val }), log.error(...), etc.
//
// When DD_API_KEY and DD_SITE are set, logs are batched and shipped to
// Datadog's HTTP intake API (agentless). When DD_LOGS_FORWARDER_URL names a
// loopback forwarder (a collector sidecar that adds the key), the same batches
// go there instead and the process needs no key. DD_LOGS_DISABLED=1 forces the
// sink closed either way (see isLogExportDisabled). Console output is always
// preserved for local dev and container stdout.
//
// Serverless callers must wrap log.flush() with waitUntil() to ensure
// pending logs are delivered before the function freezes.
// ---------------------------------------------------------------------------

import {
  DEFAULT_DD_SITE,
  isAllowedDatadogSite,
} from "@repo/api/src/types/datadog-sites";
import type { z } from "zod";
import { isRetryableDatadogStatus } from "./datadog-retry";
import { keys } from "./keys";
import {
  BoundedLogBuffer,
  DatadogIntakeError,
  resolveMaxBufferEntries,
  type TelemetryDropStats,
  TelemetryFlushFailure,
} from "./log-buffer";
import {
  LOG_SAMPLE_RATE_KEY,
  LogLevel,
  logMinLevelSchema,
  logSampleRateSchema,
} from "./log-emit-rule";
import { isLoopbackUrl } from "./loopback-url";
import { redactLogValue } from "./redact";
import { resolveGitSha, resolveServerVersion } from "./telemetry/context";
import { KNOWN_ORIGINS, ORIGIN, type Origin } from "./telemetry/origin";
import { getTraceContext, toLogCorrelationFields } from "./trace-context";

// DD_API_KEY can reach a process that never meant to ship logs. Until ISS-12354
// CI set it on every instrumented test lane for dd-trace's agentless Test
// Optimization reporter (ISS-4399), which opened this sink inside the test
// workers — shipping the code-under-test's log calls to Datadog as if they were
// production, and holding a 5s flush interval plus an exit hook in every worker.
// DD_LOGS_DISABLED lets a caller that needs the key for something else keep the
// sink closed; pr-test.yml's test steps set it. Accepted values mirror
// DD_LOGS_JSON; anything else (including "") leaves the sink enabled.
export function isLogExportDisabled(): boolean {
  const flag = process.env.DD_LOGS_DISABLED;
  return flag === "1" || flag === "true";
}

/**
 * Closes the sink when `DD_SITE` is not a recognised Datadog host (ISS-5261).
 *
 * The flush below interpolates the site into the request AUTHORITY while
 * attaching `DD-API-KEY`, so `datadoghq.com@attacker.example` resolves to the
 * attacker and ships the key — along with the contents of every buffered log
 * line. Withholding the key is the same fail-closed lever `DD_LOGS_DISABLED`
 * already pulls: console output is unaffected, and nothing egresses.
 *
 * Reported with `console.error` rather than through this module's own `log.*`,
 * which at this point would be queueing for the sink being refused.
 */
function resolveExportTarget(apiKey: string | undefined, site: string) {
  if (apiKey && !isAllowedDatadogSite(site)) {
    console.error(
      `[observability] DD_SITE "${site}" is not an allowed Datadog site — log export disabled`
    );
    return undefined;
  }
  return apiKey;
}

const LOGS_INTAKE_PATH = "/api/v2/logs";

/** Where batches are POSTed, and the key to send with them, if any. */
type LogExportTarget = { url: string; apiKey: string | undefined };

/**
 * A forwarder wins over a key in the environment: it adds the key itself, and
 * the realtime app container holds none (ISS-11827). It must be loopback, so a
 * misconfigured value cannot ship every log line to another host.
 */
function resolveLogExportTarget(
  apiKey: string | undefined,
  site: string
): LogExportTarget | undefined {
  if (isLogExportDisabled()) {
    return undefined;
  }
  const forwarderUrl = process.env.DD_LOGS_FORWARDER_URL;
  if (forwarderUrl) {
    if (!isLoopbackUrl(forwarderUrl)) {
      console.error(
        "[observability] DD_LOGS_FORWARDER_URL is not a loopback HTTP(S) URL without credentials — log export disabled"
      );
      return undefined;
    }
    return {
      url: new URL(LOGS_INTAKE_PATH, forwarderUrl).toString(),
      apiKey: undefined,
    };
  }
  const key = resolveExportTarget(apiKey, site);
  return key
    ? {
        url: `https://http-intake.logs.${site}${LOGS_INTAKE_PATH}`,
        apiKey: key,
      }
    : undefined;
}

function loadConfig() {
  try {
    const env = keys();
    const site = env.DD_SITE ?? DEFAULT_DD_SITE;
    return {
      target: resolveLogExportTarget(env.DD_API_KEY, site),
      service: env.DD_SERVICE ?? "cl-unknown",
      env: env.DD_ENV ?? process.env.NODE_ENV ?? "development",
      minLevel: env.DD_LOGS_MIN_LEVEL ?? LogLevel.Debug,
      sampleRate: env.DD_LOGS_SAMPLE_RATE ?? 1,
    };
  } catch {
    // keys() may throw outside Next.js (e.g., standalone relay).
    // Fall back to direct process.env reads.
    // "||" throughout this branch, for the reason spelled out on `service`
    // below: these are RAW process.env reads (keys() threw), so "" is never
    // normalized away. An empty DD_SITE fails the `isAllowedDatadogSite`
    // allowlist in resolveExportTarget, which clears the api key — so the whole
    // sink closes and NOTHING is exported, where the default site would have
    // worked. Falling back keeps the sink open instead of losing every log to a
    // value that was never a site.
    const site = process.env.DD_SITE || DEFAULT_DD_SITE;
    return {
      target: resolveLogExportTarget(process.env.DD_API_KEY, site),
      // "||", not "??": this branch reads process.env RAW, because it is reached
      // only when keys() threw — so keys()'s `emptyStringAsUndefined` never ran
      // and "" survives. The module-load guard below is `!process.env.DD_SERVICE`,
      // so an empty value already WARNS that logs are tagged `cl-unknown`; "??"
      // would keep "" and make that warning a lie, dropping the logs out of every
      // service-scoped Datadog query.
      service: process.env.DD_SERVICE || "cl-unknown",
      env: process.env.DD_ENV || process.env.NODE_ENV || "development",
      minLevel: readRawEmitSetting(
        "DD_LOGS_MIN_LEVEL",
        process.env.DD_LOGS_MIN_LEVEL,
        logMinLevelSchema,
        LogLevel.Debug
      ),
      sampleRate: readRawEmitSetting(
        "DD_LOGS_SAMPLE_RATE",
        process.env.DD_LOGS_SAMPLE_RATE,
        logSampleRateSchema,
        1
      ),
    };
  }
}

const DD: {
  target?: LogExportTarget;
  service: string;
  env: string;
  minLevel: LogLevel;
  sampleRate: number;
  version: string;
  gitSha: string;
} = {
  ...loadConfig(),
  version: resolveServerVersion(),
  gitSha: resolveGitSha(),
};

// Read by the module-load `log.warn` calls below, so it cannot sit at the
// bottom of the file.
const LOG_LEVEL_SEVERITY: Record<LogLevel, number> = {
  [LogLevel.Debug]: 0,
  [LogLevel.Info]: 1,
  [LogLevel.Warn]: 2,
  [LogLevel.Error]: 3,
};

const FLUSH_INTERVAL_MS = 5000;

/** Entries per intake request. Exported so a test can assert the batch seam. */
export const MAX_BATCH_SIZE = 100;

/**
 * Retries a single drain cycle may spend before it gives up and leaves the
 * backlog for the next interval. Exported because it BOUNDS the cycle: the
 * intake sees at most `MAX_RETRY_COUNT + 1` requests per drain no matter how
 * many callers asked for one, and that bound is the contract a test pins.
 */
export const MAX_RETRY_COUNT = 2;

// ---------------------------------------------------------------------------
// Structured-JSON console output for deployed runtimes.
//
// Locally, `log.info("msg", { … })` writes a human-readable console line. But
// in deployed runtimes the platform log drain (Vercel → Datadog, container
// stdout → Datadog) only sees that console line — and util.inspect collapses
// the structured meta into the message text, so fields like `category` or
// `diagnostics.*` never become Datadog facets (they're buried in the message
// blob). Emitting a single JSON line instead lets the drain parse the meta into
// first-class attributes/facets, with no dependency on the agentless intake
// path (DD_API_KEY) being configured.
//
// Auto-on under Vercel (`process.env.VERCEL` is set on every Vercel
// deployment); force on/off with `DD_LOGS_JSON=1|0`. Off by default locally so
// dev logs stay readable.
function resolveStructuredConsole(): boolean {
  const flag = process.env.DD_LOGS_JSON;
  if (flag === "1" || flag === "true") {
    return true;
  }
  if (flag === "0" || flag === "false") {
    return false;
  }
  return Boolean(process.env.VERCEL);
}

const STRUCTURED_CONSOLE = resolveStructuredConsole();

// `status` is Datadog's RESERVED severity attribute; `level` is not. Datadog
// resolves a log's status from the first of `status`, `severity`, `level`,
// `syslog.severity` that the payload carries — so anything a caller put under
// `status` (an HTTP code, a domain status) decided the severity instead of the
// log call did, and a `log.error` carrying `{ status: 403 }` was indexed as
// info (ISS-6341). Emitting severity under both keys settles it at the source
// rather than relying on per-service pipeline configuration this repo does not
// own; `level` stays for existing consumers and queries.
export type DatadogLogEntry = {
  message: string;
  level: LogLevel;
  status: LogLevel;
  service: string;
  ddsource: string;
  ddtags: string;
  timestamp: string;
  origin: Origin;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// Datadog HTTP intake — batched with bounded retries
// ---------------------------------------------------------------------------

const buffer = new BoundedLogBuffer<DatadogLogEntry>(resolveMaxBufferEntries());
let flushTimer: ReturnType<typeof setInterval> | null = null;
// The ONE drain in flight, shared by every caller: the 5s interval, the
// batch-size trigger in `enqueue()`, and `log.flush()` all receive this exact
// promise rather than chaining a fresh follow-up onto it.
//
// Chaining was the bug. Every log arriving while a flush was active and the
// buffer was at the batch size queued another `then(() => flushToDatadog())`,
// so a sustained outage accumulated an unbounded promise queue — and each
// waiter in it started its own retry cycle against the same retained batch,
// hitting the intake far past the retry budget. One shared drain is bounded by
// construction: at most one cycle exists, and a joiner waits for it rather than
// scheduling another.
let drainInProgress: Promise<void> | null = null;
let retryCount = 0;
// Guards the `beforeExit` handler against re-arming itself forever; see there.
let exitFlushAttempted = false;

function startFlushTimer(): void {
  if (flushTimer) {
    return;
  }
  flushTimer = setInterval(() => {
    flushToDatadog();
  }, FLUSH_INTERVAL_MS);
  // Don't hold the process open for the flush timer
  if (typeof flushTimer === "object" && "unref" in flushTimer) {
    flushTimer.unref();
  }
}

function flushToDatadog(): Promise<void> {
  const target = DD.target;
  if (!target) {
    return Promise.resolve();
  }

  // Join the drain already running rather than scheduling another. Its loop
  // re-checks the buffer between batches, so entries enqueued during the drain
  // are still delivered before the shared promise resolves — the guarantee
  // `waitUntil(log.flush())` callers depend on in serverless, where the runtime
  // can freeze the function between batches.
  if (drainInProgress) {
    return drainInProgress;
  }
  if (buffer.length === 0) {
    return Promise.resolve();
  }

  const drain = drainBuffer(target).finally(() => {
    drainInProgress = null;
  });
  drainInProgress = drain;
  return drain;
}

/**
 * Drain the buffer batch by batch until it is empty or this cycle gives up.
 *
 * Bounded on both axes: one batch is in flight at a time, and the loop stops
 * the moment a cycle spends its retry budget, so a dead intake costs at most
 * `MAX_RETRY_COUNT + 1` requests per cycle no matter how many callers asked.
 * The 5s interval picks the backlog up again with a fresh budget.
 */
async function drainBuffer(target: LogExportTarget): Promise<void> {
  let abandoned = false;
  try {
    while (buffer.length > 0) {
      const keepDraining = await sendNextBatch(target);
      if (!keepDraining) {
        abandoned = true;
        break;
      }
    }
  } catch (error) {
    // `enqueue()` starts this drain without awaiting it, so a rejection
    // escaping here would surface as an unhandled rejection inside every
    // importer of this module — including client components. A logging sink
    // does not get to take its callers down.
    abandoned = true;
    console.error("[observability] Log drain failed unexpectedly:", error);
  } finally {
    // Everything below has to survive an unexpected throw mid-drain, which is
    // why it is a `finally` and not the tail of the `try`.
    //
    // `retryCount` is CYCLE-local state living in a module-level variable.
    // Leaving it wherever an error struck hands the next cycle a budget of
    // `MAX_RETRY_COUNT - retryCount` instead of the full one — a silent,
    // compounding shrink that makes a dead intake give up sooner on each pass
    // with nothing in the logs to explain it.
    retryCount = 0;
    if (abandoned) {
      buffer.noteCycleAbandoned();
    }
    // The pending drops are already tallied; this is only their EMISSION.
    // Skipping it on the error path strands them until the next drop event or
    // process exit — which is exactly the window an operator is staring at.
    buffer.reportPending();
  }
}

/**
 * Ship one batch. Resolves `false` when this cycle has spent its retry budget.
 *
 * The entries stay BUFFERED either way rather than being dropped — but buffered
 * is not the same as delivered, and on a runtime that freezes the process they
 * are lost with no drop counter moving. `buffer.noteCycleAbandoned()` in the
 * caller is what makes that window visible; see `TELEMETRY_UNDELIVERED_CATEGORY`.
 */
async function sendNextBatch(target: LogExportTarget): Promise<boolean> {
  const payload = buildIntakePayload(buffer.takeBatch(MAX_BATCH_SIZE));
  if (!payload) {
    // Nothing in the batch could be serialized; the loss is already counted.
    // Keep draining what is behind it.
    return true;
  }
  try {
    const response = await fetch(target.url, {
      method: "POST",
      headers: target.apiKey
        ? { "Content-Type": "application/json", "DD-API-KEY": target.apiKey }
        : { "Content-Type": "application/json" },
      body: payload.body,
      signal: AbortSignal.timeout(10_000),
      // Do NOT follow redirects: a 307/308 replays the batch AND the
      // DD-API-KEY header to the redirect target, carrying both past the site
      // allowlist.
      redirect: "error",
    });
    return handleIntakeResponse(response, payload.entries);
  } catch (error) {
    return await handleFlushError(error, payload.entries);
  }
}

function handleIntakeResponse(
  response: Response,
  entries: readonly DatadogLogEntry[]
): boolean {
  if (response.ok) {
    retryCount = 0;
    buffer.noteFlushSuccess();
    return true;
  }
  if (isRetryableDatadogStatus(response.status)) {
    throw new DatadogIntakeError(
      TelemetryFlushFailure.ServerError,
      response.status
    );
  }
  // Non-retryable: no amount of replay makes the intake accept this batch, so
  // the entries are gone. Counting them is what turns a silent loss into a
  // known denominator (ISS-7219).
  buffer.noteFlushFailure(TelemetryFlushFailure.ClientError);
  buffer.recordRejected(entries.length, response.status);
  retryCount = 0;
  return true;
}

async function handleFlushError(
  error: unknown,
  entries: readonly DatadogLogEntry[]
): Promise<boolean> {
  // Order is load-bearing. The entries are OUT of the buffer right now, so
  // anything that throws before `returnBatch` loses them with no counter
  // moving — the uncounted-loss shape this whole change exists to remove. Get
  // the data back first; the console line is the fallible part and goes last.
  //
  // `noteFlushFailure` still precedes `returnBatch`, because returning a batch
  // into a full buffer sheds and the shed report reads `lastFailure` for its
  // `cause` — noting after would attribute this cycle's shed to the previous
  // failure.
  buffer.noteFlushFailure(classifyFlushFailure(error));
  // The batch goes back regardless of the retry budget. Retries are what this
  // cycle gives up on, not the data — in a process that lives long enough for
  // the next interval. A serverless runtime that freezes after
  // `waitUntil(log.flush())` resolves takes the backlog with it, which is
  // reported as an abandoned cycle rather than pretended away.
  //
  // These are the entries the payload was actually BUILT from, which is not
  // necessarily the batch that was taken: anything serialization refused has
  // already been counted and must not come back, or it would poison every
  // subsequent batch it lands in for the life of the process.
  buffer.returnBatch(entries);
  console.error("[observability] Failed to flush logs to Datadog:", error);
  if (retryCount >= MAX_RETRY_COUNT) {
    retryCount = 0;
    return false;
  }
  retryCount++;
  // Backoff: wait 2^retryCount * 100ms before the next retry so transient
  // failures (especially 429 rate-limiting) don't hammer the intake at full
  // speed.
  await delay(Math.min(100 * 2 ** retryCount, 10_000));
  return true;
}

function enqueue(entry: DatadogLogEntry): void {
  buffer.push(entry);
  startFlushTimer();
  if (buffer.length >= MAX_BATCH_SIZE) {
    flushToDatadog();
  }
}

// ---------------------------------------------------------------------------
// Structured log builder
// ---------------------------------------------------------------------------

function buildEntry(
  level: LogLevel,
  message: string,
  meta?: Record<string, unknown>
): DatadogLogEntry {
  const metaOrigin =
    typeof meta?.origin === "string" &&
    (KNOWN_ORIGINS as readonly string[]).includes(meta.origin)
      ? (meta.origin as Origin)
      : undefined;
  const origin = metaOrigin ?? ORIGIN;
  return {
    ...stampSeverity(level, message, meta),
    service: DD.service,
    ddsource: "nodejs",
    ddtags: `env:${DD.env},version:${DD.version},git_sha:${DD.gitSha}`,
    timestamp: new Date().toISOString(),
    origin,
  };
}

// JSON.stringify replacer for the structured console line and the Datadog
// intake payload. Two jobs:
//   1. Preserve Error instances — without it, Errors in meta (e.g.
//      `log.error("failed", { error })`) serialize to `{}` and the
//      name/message/stack are lost. The expanded object is re-visited by the
//      replacer, so its message/stack still pass through redaction below.
//   2. Redact secrets/PII — apply the shared redactLogValue so any apiKey,
//      token, password, authorization, cookie, credential, or email a caller
//      puts in meta is scrubbed before it leaves the process to Datadog.
function jsonReplacer(key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return redactLogValue(key, value);
}

// If the second arg is a plain object, use it as structured meta.
// Otherwise, pack extra args into a generic "args" field.
function extractMeta(args: unknown[]): Record<string, unknown> | undefined {
  const firstArg = args[0];
  if (
    args.length === 1 &&
    typeof firstArg === "object" &&
    firstArg !== null &&
    !Array.isArray(firstArg)
  ) {
    return firstArg as Record<string, unknown>;
  }
  if (args.length > 0) {
    return { args };
  }
  return undefined;
}

// Write the console sink. In deployed runtimes emit a single JSON line so the
// platform log drain parses meta into facets; locally keep the readable form.
// JSON.stringify can throw on circular/BigInt meta — fall back to the readable
// form so a logging call never throws.
function writeConsole(
  consoleFn: (...args: unknown[]) => void,
  level: LogLevel,
  message: string,
  args: unknown[],
  meta: Record<string, unknown> | undefined
): void {
  if (STRUCTURED_CONSOLE) {
    try {
      consoleFn(
        JSON.stringify(stampSeverity(level, message, meta), jsonReplacer)
      );
      return;
    } catch {
      // fall through to the human-readable form below
    }
  }
  if (args.length > 0) {
    consoleFn(message, ...args);
  } else {
    consoleFn(message);
  }
}

function makeLogFn(
  level: LogLevel,
  consoleFn: (...args: unknown[]) => void
): (message: string, ...args: unknown[]) => void {
  return (message: string, ...args: unknown[]) => {
    // ISS-12265: decided once, before the sinks split, so the console line the
    // platform drain reads and the intake entry are kept or dropped together.
    if (!isEmitted(level)) {
      return;
    }

    // ISS-4659: enrich here, not in buildEntry(). buildEntry() only feeds the
    // agentless intake payload, so trace ids added there would be missing on
    // the Vercel Log Drain path — the same asymmetry that made `origin` get
    // stamped at the emit site (see apps/api/instrumentation.ts). Enriching the
    // shared `meta` puts the ids on BOTH sinks.
    const meta = withTraceCorrelation(extractMeta(args));

    // Always write to console (local dev + container/platform stdout drain).
    writeConsole(consoleFn, level, message, args, meta);

    // Ship to Datadog when configured (agentless intake, or a forwarder).
    if (DD.target) {
      enqueue(buildEntry(level, message, meta));
    }
  };
}

// ---------------------------------------------------------------------------
// Flush on process exit (best-effort for long-running processes).
//
// For Vercel serverless, callers must use waitUntil(log.flush()) instead —
// signal handlers cannot await async work before the runtime freezes.
// ---------------------------------------------------------------------------

if (typeof process !== "undefined" && DD.target) {
  process.on("beforeExit", () => {
    // ONE attempt, ever. `beforeExit` re-fires every time the event loop
    // drains, and flushToDatadog() issues a fetch that keeps the loop alive.
    // A failed batch now stays buffered instead of being dropped, so during an
    // intake outage `buffer.length > 0` is permanently true — re-arming here
    // would flush, fail, re-buffer, drain, and fire again forever, and the
    // process could never exit. Durability across flush cycles is worth having;
    // an unkillable process is not.
    if (exitFlushAttempted) {
      return;
    }
    exitFlushAttempted = true;
    if (buffer.length > 0) {
      flushToDatadog();
    }
    // The ONLY throttle bypass in the module. A drop the throttle was still
    // holding when the process wound down is the one nobody would ever see
    // reported, and there is no later window to report it in. Every other
    // caller stays throttled, because a bypass on the normal drain path would
    // emit after each flush cycle and recreate the log storm the interval caps.
    buffer.reportFinal();
  });
}

// ---------------------------------------------------------------------------
// Public API — drop-in replacement for console
// ---------------------------------------------------------------------------

export const log = {
  debug: makeLogFn("debug", console.debug),
  info: makeLogFn("info", console.info),
  warn: makeLogFn("warn", console.warn),
  error: makeLogFn("error", console.error),
  /**
   * Flush pending log entries to Datadog. Returns a promise that resolves
   * when the current batch has been sent (or immediately if nothing to flush).
   *
   * In Vercel serverless routes, wrap with waitUntil(log.flush()).
   */
  flush: (): Promise<void> =>
    flushToDatadog().then(() => {
      // Throttled, like every non-shutdown caller. The drain already reports on
      // its way out; this covers the case where there was nothing to drain but
      // a drop is still pending.
      buffer.reportPending();
    }),
  /**
   * Cumulative telemetry-loss accounting for this process (ISS-7219).
   *
   * Every count sourced from logs is a floor unless the reader can put a number
   * on what never arrived. `cumulativeDropped` is that number for entries that
   * left the pipeline DEFINITIVELY — capacity shed, an intake refusal replay
   * cannot fix, metadata nothing could serialize.
   *
   * It is deliberately NOT a complete account of loss, and reading it as one is
   * the mistake this docstring exists to prevent. Entries still buffered when a
   * drain cycle gave up are not counted here, because a long-running process
   * usually delivers them on the next interval — but a serverless runtime that
   * freezes after `waitUntil(log.flush())` resolves loses them, and this counter
   * would read 0 throughout. `cumulativeAbandonedCycles` is the signal for that
   * window; both reach Datadog on the `telemetry.dropped` and
   * `telemetry.undelivered` categories, which ride the platform log drain
   * rather than the intake that is failing.
   */
  droppedStats: (): TelemetryDropStats => buffer.stats(),
};

// Server-only diagnostics: these warnings signal a misconfigured deploy to
// ops. In client bundles (the logger is imported by client components), the
// env vars are never defined, so emitting the warnings in browsers would
// pollute every end-user's DevTools console on page load.
if (typeof window === "undefined") {
  // console.warn (not log.warn) — mirrors origin.ts; guarantees synchronous stdout delivery
  if (!process.env.DD_SERVICE) {
    console.warn(
      JSON.stringify({
        level: "warn",
        status: "warn",
        event: "telemetry.dd_service_fallback",
        message:
          "observability: DD_SERVICE is not set; logs will be tagged service:cl-unknown. Set DD_SERVICE in your environment.",
      })
    );
  }

  if (DD.version === "unknown") {
    log.warn("telemetry.version_fallback");
  }

  if (DD.gitSha === "unknown") {
    log.warn("telemetry.git_sha_fallback");
  }
}

/**
 * Merge the active trace's correlation ids into a log call's metadata.
 *
 * Returns `meta` unchanged when nothing is traced, so an untraced call (every
 * browser bundle, and any runtime with tracing disabled) allocates nothing new
 * and the emitted shape is byte-for-byte what it was before ISS-4659.
 *
 * The correlation fields are spread AFTER the caller's meta so a caller cannot
 * spoof `dd.trace_id`/`dd.span_id` — the same reserved-key precedence the
 * `origin` footgun in `buildEntry()` exists to enforce.
 */
function withTraceCorrelation(
  meta: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  const traceContext = getTraceContext();
  if (!traceContext) {
    return meta;
  }
  return { ...meta, ...toLogCorrelationFields(traceContext) };
}

/**
 * Key a caller's own `status` is moved to when it collides with the reserved one.
 *
 * `status` is Datadog's reserved severity attribute, so the value a call site
 * puts there (an HTTP code, a domain status) is read as the log's severity and
 * mis-classifies it. Relocating rather than dropping keeps the attribute
 * queryable — 45 call sites pass one today.
 */
const CALLER_STATUS_KEY = "callerStatus";

/**
 * Stamp the fields both sinks must agree on: the message, the severity
 * under Datadog's reserved `status` as well as the legacy `level`, and the
 * sample rate when one below 1 is set.
 *
 * Shared by `buildEntry()` (agentless HTTP intake) and `writeConsole()` (the
 * JSON line the platform drain parses) so the two cannot drift — the same
 * two-sink asymmetry the ISS-4659 comment in `makeLogFn()` documents.
 *
 * Spread AFTER the caller's meta, so a caller cannot downgrade the severity
 * Datadog indexes. Unlike `origin`, which `buildEntry()` deliberately lets a
 * caller override with a known origin, severity is never caller-supplied.
 */
function stampSeverity(
  level: LogLevel,
  message: string,
  meta: Record<string, unknown> | undefined
): StampedSeverity {
  const stamped: StampedSeverity = { ...meta, message, level, status: level };
  if (meta && Object.hasOwn(meta, "status")) {
    stamped[CALLER_STATUS_KEY] = meta.status;
  }
  // ISS-12265: only below 1, so the default entry is unchanged.
  if (DD.sampleRate < 1) {
    stamped[LOG_SAMPLE_RATE_KEY] = DD.sampleRate;
  }
  return stamped;
}

/** What both sinks receive: the caller's meta plus the fields they must agree on. */
type StampedSeverity = Record<string, unknown> & {
  message: string;
  level: LogLevel;
  status: LogLevel;
};

/**
 * Name the failure mode a rejected flush represents, so a drop report can say
 * WHY the backlog built rather than only that it did.
 *
 * `redirect: "error"` and DNS/socket failures both surface as a plain
 * `TypeError` here, which is `transport_error` — the one case a caller cannot
 * distinguish from the outside and should not have to.
 */
function classifyFlushFailure(error: unknown): TelemetryFlushFailure {
  if (error instanceof DatadogIntakeError) {
    return error.failure;
  }
  if (isTimeoutError(error)) {
    return TelemetryFlushFailure.Timeout;
  }
  return TelemetryFlushFailure.TransportError;
}

/**
 * Match the NAME the web spec fixes, not the class.
 *
 * `AbortSignal.timeout()` rejects with a `DOMException`, and whether that
 * shares a prototype chain with `Error` is a host-object detail that differs by
 * runtime. Testing `instanceof Error` would make the whole `cause` facet depend
 * on that detail, and would fail open to `transport_error` — a wrong reason on
 * the exact signal this module exists to make trustworthy.
 */
function isTimeoutError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  return Reflect.get(error, "name") === "TimeoutError";
}

/** The intake body, and exactly the entries it was built from. */
type IntakePayload = {
  body: string;
  entries: readonly DatadogLogEntry[];
};

/** `JSON.stringify`, reporting refusal instead of raising it. */
function trySerialize(value: unknown): string | undefined {
  try {
    return JSON.stringify(value, jsonReplacer);
  } catch {
    return undefined;
  }
}

/**
 * Build the intake body from a batch, tolerating metadata `JSON.stringify`
 * refuses.
 *
 * A logging call must never throw into its caller, and serializing the whole
 * batch in one go did exactly that: `JSON.stringify` raises SYNCHRONOUSLY on
 * circular (or BigInt) metadata, so `log.info("x", circular)` threw out of
 * `log.info` itself the moment the batch-size trigger fired — from inside the
 * `fetch(...)` argument list, before any `.catch` existed to see it. The
 * console sink deliberately ACCEPTS such values, so the caller had every reason
 * to think the call was safe.
 *
 * The entries are already out of the buffer by then, so discarding the poison
 * ones silently would be an uncounted loss — the exact false-completeness this
 * whole change exists to remove. Each poison entry is counted as
 * `unserializable`; replay cannot help, since the same value throws every time.
 * Entries that DO serialize are still shipped, and are the ones handed back for
 * a retry if the intake later refuses the batch.
 *
 * Serializing per entry and joining is byte-identical to serializing the array:
 * `jsonReplacer` only rewrites `Error` instances and redacts by KEY NAME, and
 * neither the array's `""` root key nor its `"0"`, `"1"`, … element keys are
 * sensitive.
 */
function buildIntakePayload(
  batch: readonly DatadogLogEntry[]
): IntakePayload | undefined {
  const serialized: string[] = [];
  const entries: DatadogLogEntry[] = [];
  for (const entry of batch) {
    const line = trySerialize(entry);
    if (line !== undefined) {
      serialized.push(line);
      entries.push(entry);
    }
  }
  buffer.recordUnserializable(batch.length - entries.length);
  if (serialized.length === 0) {
    return undefined;
  }
  return { body: `[${serialized.join(",")}]`, entries };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Whether log entries leave the process beyond the console sink. */
export function isLogExportOpen(): boolean {
  return DD.target !== undefined;
}

/**
 * `DD_LOGS_MIN_LEVEL` and `DD_LOGS_SAMPLE_RATE`; the defaults emit every call.
 * At rate 1 the RNG is not drawn, so a log call does not shift a caller's
 * `Math.random()` sequence.
 */
function isEmitted(level: LogLevel): boolean {
  return (
    LOG_LEVEL_SEVERITY[level] >= LOG_LEVEL_SEVERITY[DD.minLevel] &&
    (DD.sampleRate === 1 || Math.random() < DD.sampleRate)
  );
}

/**
 * `loadConfig()`'s raw-env branch: `keys()` threw, so its schema never ran. An
 * invalid value is reported and treated as unset, per key, the way an invalid
 * `DD_SITE` is reported and closes the sink.
 */
function readRawEmitSetting<T>(
  key: string,
  raw: string | undefined,
  schema: z.ZodType<T>,
  fallback: T
): T {
  if (!raw) {
    return fallback;
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) {
    return parsed.data;
  }
  console.error(
    `[observability] ${key} "${raw}" is not valid — treated as unset`
  );
  return fallback;
}
