// Direct submission to the Datadog v2 metrics API (`/api/v2/series`).
//
// ## Why this exists alongside emitTelemetryMetric
// `metrics.ts` emits metrics as structured LOGS, which become metrics only via a
// log-to-metric rule created by hand in the Datadog UI. That is invisible to
// Terraform and to anyone reading this repo, and it adds an intake delay that
// monitors then have to compensate for with `evaluation_delay`.
//
// For a signal whose whole purpose is to be trustworthy — an alerting metric
// whose definition should be as reviewable as the code that emits it — the
// series API is the right transport: the metric exists because this code posted
// it, with no second, unversioned config step in between. Use `metrics.ts` for
// ordinary telemetry; use this when a monitor's correctness depends on the
// metric being exactly what the code says it is.
//
// ISS-4450.

import {
  DEFAULT_DD_SITE,
  isAllowedDatadogSite,
} from "@repo/api/src/types/datadog-sites";
import { keys } from "../keys";
import { log } from "../log";

/** Datadog v2 `/api/v2/series` metric types. */
export const DatadogMetricType = {
  Count: 1,
  Gauge: 3,
} as const;
export type DatadogMetricType =
  (typeof DatadogMetricType)[keyof typeof DatadogMetricType];

export type DatadogSeries = {
  metric: string;
  type: DatadogMetricType;
  points: { timestamp: number; value: number }[];
  tags?: string[];
  /** Required by Datadog for COUNT metrics; the reporting interval in seconds. */
  interval?: number;
};

export const SeriesSubmitStatus = {
  /** Datadog accepted the payload. */
  Ok: "ok",
  /** No API key configured — nothing was sent, and that is expected locally. */
  NotConfigured: "not_configured",
  /** DD_SITE is not a recognised Datadog host; nothing was sent. */
  DisallowedSite: "disallowed_site",
  /** Sent, but Datadog rejected it or the request failed. */
  Rejected: "rejected",
} as const;
export type SeriesSubmitStatus =
  (typeof SeriesSubmitStatus)[keyof typeof SeriesSubmitStatus];

const SERIES_TIMEOUT_MS = 10_000;

/**
 * The workflow this replaced submitted with `curl --retry 2`. Dropping that in
 * the port would turn a single transient blip into a lost sample — and, because
 * the poll beat is derived from whether the submission landed, into a false
 * "poller is down" alert.
 */
const SERIES_MAX_RETRIES = 2;
const SERIES_RETRY_BACKOFF_MS = 200;

/** Statuses worth a second attempt; everything else is a terminal rejection. */
const RETRYABLE_STATUSES = new Set([408, 429]);

/** Internal per-attempt outcome: a terminal status, or "this may succeed later". */
const RETRY_ATTEMPT = "retry" as const;
type AttemptOutcome = SeriesSubmitStatus | typeof RETRY_ATTEMPT;

/**
 * Posts one or more series to Datadog.
 *
 * Never throws and never rejects: a telemetry failure must not take down the
 * caller. The returned status tells the caller whether the point actually
 * landed, which matters when a companion liveness metric is supposed to mean
 * "the data arrived" rather than merely "the job ran".
 */
export async function submitSeries(
  series: readonly DatadogSeries[],
  logTag: string,
  options: { maxRetries?: number } = {}
): Promise<SeriesSubmitStatus> {
  const maxRetries = Math.max(0, options.maxRetries ?? SERIES_MAX_RETRIES);
  const { DD_API_KEY, DD_SITE } = keys();
  if (!DD_API_KEY) {
    log.info(`${logTag} DD_API_KEY not configured — not submitting series`);
    return SeriesSubmitStatus.NotConfigured;
  }

  const site = DD_SITE || DEFAULT_DD_SITE;
  if (!isAllowedDatadogSite(site)) {
    // Never attach DD-API-KEY to an unrecognised authority (SSRF / key egress).
    //
    // Reported with `console.error` and NOT `log.error`. `log.ts` now closes
    // its own sink on a disallowed site, so this is belt-and-braces rather than
    // load-bearing — but the ordering still matters: this module must not
    // depend on the log sink having already made that decision in order to
    // avoid leaking. The workflow this replaced reasoned the same way and wrote
    // only to its local job log — there is nowhere safe to report this, so it
    // stays local and the heartbeat monitor's silence is the correct signal.
    console.error(
      `${logTag} DD_SITE is not an allowed Datadog site — emitting nothing`,
      { site }
    );
    return SeriesSubmitStatus.DisallowedSite;
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await sleep(SERIES_RETRY_BACKOFF_MS * attempt);
    }

    const outcome = await attemptSubmit(series, site, DD_API_KEY, logTag);
    if (outcome !== RETRY_ATTEMPT) {
      return outcome;
    }
  }

  log.warn(`${logTag} series submission failed after retries`, {
    attempts: maxRetries + 1,
    metrics: series.map((entry) => entry.metric),
  });
  return SeriesSubmitStatus.Rejected;
}

/**
 * Worst-case wall time a `submitSeries` call can consume, so a caller under a
 * platform deadline can budget for it instead of guessing.
 */
export function seriesWorstCaseMs(maxRetries = SERIES_MAX_RETRIES): number {
  const attempts = Math.max(0, maxRetries) + 1;
  let backoff = 0;
  for (let attempt = 1; attempt <= Math.max(0, maxRetries); attempt++) {
    backoff += SERIES_RETRY_BACKOFF_MS * attempt;
  }
  return attempts * SERIES_TIMEOUT_MS + backoff;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status) || status >= 500;
}

async function attemptSubmit(
  series: readonly DatadogSeries[],
  site: string,
  apiKey: string,
  logTag: string
): Promise<AttemptOutcome> {
  try {
    const response = await fetch(`https://api.${site}/api/v2/series`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "DD-API-KEY": apiKey,
      },
      body: JSON.stringify({ series }),
      signal: AbortSignal.timeout(SERIES_TIMEOUT_MS),
      // Do NOT follow redirects: a 307/308 replays the body AND the
      // DD-API-KEY header to the redirect target, which would carry the key
      // past the allowlist above.
      redirect: "error",
    });

    if (response.ok) {
      return SeriesSubmitStatus.Ok;
    }

    if (isRetryableStatus(response.status)) {
      return RETRY_ATTEMPT;
    }

    // A terminal non-2xx means the points were dropped. Saying so is the whole
    // point: silently treating a rejection as success is how a metric ends up
    // not existing while everything upstream looks green.
    log.warn(`${logTag} Datadog rejected the series submission`, {
      status: response.status,
      metrics: series.map((entry) => entry.metric),
    });
    return SeriesSubmitStatus.Rejected;
  } catch (error) {
    // NEVER interpolate the raw error message. Undici's "invalid header value"
    // error echoes the offending header VALUE — here that is DD-API-KEY — which
    // would then be written straight to the log sink. The same guard, for the
    // same reason, is in packages/database/scripts/migrate-telemetry.ts. The
    // name alone still separates a timeout from a transport failure.
    log.warn(`${logTag} series submission failed (transport error)`, {
      errorName: error instanceof Error ? error.name : "unknown",
      metrics: series.map((entry) => entry.metric),
    });
    return RETRY_ATTEMPT;
  }
}
