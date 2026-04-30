// ---------------------------------------------------------------------------
// Structured logger with optional agentless Datadog export.
//
// API: same as console — log.info("msg", { key: val }), log.error(...), etc.
//
// When DD_API_KEY and DD_SITE are set, logs are batched and shipped to
// Datadog's HTTP intake API (agentless). Console output is always preserved
// for local dev and container stdout.
//
// Serverless callers must wrap log.flush() with waitUntil() to ensure
// pending logs are delivered before the function freezes.
// ---------------------------------------------------------------------------

import { keys } from "./keys";
import { resolveServerVersion } from "./telemetry/context";
import { KNOWN_ORIGINS, ORIGIN, type Origin } from "./telemetry/origin";

function loadConfig() {
  try {
    const env = keys();
    return {
      apiKey: env.DD_API_KEY,
      site: env.DD_SITE ?? "datadoghq.com",
      service: env.DD_SERVICE ?? "cl-unknown",
      env: env.DD_ENV ?? process.env.NODE_ENV ?? "development",
    };
  } catch {
    // keys() may throw outside Next.js (e.g., standalone relay).
    // Fall back to direct process.env reads.
    return {
      apiKey: process.env.DD_API_KEY,
      site: process.env.DD_SITE ?? "datadoghq.com",
      // "??" preserves ""; the "!"-falsy guard below catches empty DD_SERVICE (intentional asymmetry)
      service: process.env.DD_SERVICE ?? "cl-unknown",
      env: process.env.DD_ENV ?? process.env.NODE_ENV ?? "development",
    };
  }
}

function resolveGitSha(): string {
  return process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GIT_SHA ?? "unknown";
}

const DD: {
  apiKey?: string;
  site: string;
  service: string;
  env: string;
  version: string;
  gitSha: string;
} = {
  ...loadConfig(),
  version: resolveServerVersion(),
  gitSha: resolveGitSha(),
};

const FLUSH_INTERVAL_MS = 5000;
const MAX_BATCH_SIZE = 100;
const MAX_RETRY_COUNT = 2;

type LogLevel = "debug" | "info" | "warn" | "error";

type DatadogLogEntry = {
  message: string;
  level: LogLevel;
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

const buffer: DatadogLogEntry[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let flushInProgress: Promise<void> | null = null;
let retryCount = 0;

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
  if (buffer.length === 0 || !DD.apiKey || flushInProgress) {
    return flushInProgress ?? Promise.resolve();
  }

  const batch = buffer.splice(0, MAX_BATCH_SIZE);

  flushInProgress = fetch(`https://http-intake.logs.${DD.site}/api/v2/logs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "DD-API-KEY": DD.apiKey,
    },
    body: JSON.stringify(batch),
    signal: AbortSignal.timeout(10_000),
  })
    .then(() => {
      retryCount = 0;
    })
    .catch((error) => {
      console.error("[observability] Failed to flush logs to Datadog:", error);
      // Re-enqueue only if under retry limit; drop the batch otherwise
      if (retryCount < MAX_RETRY_COUNT) {
        retryCount++;
        buffer.unshift(...batch);
      } else {
        console.error(
          `[observability] Dropping ${batch.length} log entries after ${MAX_RETRY_COUNT} retries`
        );
        retryCount = 0;
      }
    })
    .finally(() => {
      flushInProgress = null;
      if (buffer.length >= MAX_BATCH_SIZE) {
        flushToDatadog();
      }
    });

  return flushInProgress;
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
    ...meta,
    message,
    level,
    service: DD.service,
    ddsource: "nodejs",
    ddtags: `env:${DD.env},version:${DD.version},git_sha:${DD.gitSha}`,
    timestamp: new Date().toISOString(),
    origin,
  };
}

function makeLogFn(
  level: LogLevel,
  consoleFn: (...args: unknown[]) => void
): (message: string, ...args: unknown[]) => void {
  return (message: string, ...args: unknown[]) => {
    // Always write to console (local dev + container stdout)
    if (args.length > 0) {
      consoleFn(message, ...args);
    } else {
      consoleFn(message);
    }

    // Ship to Datadog when configured
    if (DD.apiKey) {
      // If the second arg is a plain object, use it as structured meta.
      // Otherwise, pack extra args into a generic "args" field.
      const firstArg = args[0];
      let meta: Record<string, unknown> | undefined;
      if (
        args.length === 1 &&
        typeof firstArg === "object" &&
        firstArg !== null &&
        !Array.isArray(firstArg)
      ) {
        meta = firstArg as Record<string, unknown>;
      } else if (args.length > 0) {
        meta = { args };
      }
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

if (typeof process !== "undefined" && DD.apiKey) {
  process.on("beforeExit", () => {
    if (buffer.length > 0) {
      flushToDatadog();
    }
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
  flush: (): Promise<void> => flushToDatadog(),
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
