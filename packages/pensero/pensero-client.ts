import "server-only";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { z } from "zod";
import { keys } from "./keys";
import {
  PenseroMetric,
  type PenseroPersonDeliveryRecord,
} from "./normalization";

/** Default production Pensero API base (overridable via PENSERO_API_BASE_URL). */
const DEFAULT_PENSERO_BASE_URL = "https://pensero.ai/api";

/** Path of the person-centric delivery-metrics collection on the Pensero API. */
const DELIVERY_METRICS_PATH = "/delivery-metrics/";

/** Matches one-or-more trailing slashes on a base URL path, for normalization. */
const TRAILING_SLASHES_RE = /\/+$/;

/**
 * Per-request wall-clock ceiling. A stalled Pensero page would otherwise pin the
 * (serverless) invocation open until the platform kills it — with no result and
 * a wasted budget. Each page fetch is bounded by this timeout (overridable per
 * call), in addition to the caller-supplied `signal`.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Resolve the Pensero credential + base URL from env, throwing a clear error
 * when the integration is not configured. The token is read ONLY here (server
 * side) and never returned to callers or logged. `keys()` is evaluated on each
 * call so a late-injected credential (or an env change) is always honored;
 * validation is cheap relative to the network round-trip it guards.
 */
function getRequiredConfig(): { token: string; baseUrl: string } {
  const config = keys();
  if (!config.PENSERO_API_TOKEN) {
    throw new Error(
      "Pensero integration not configured. Set PENSERO_API_TOKEN (a tk_<public>:sk_<secret> token)."
    );
  }
  return {
    token: config.PENSERO_API_TOKEN,
    baseUrl: config.PENSERO_API_BASE_URL ?? DEFAULT_PENSERO_BASE_URL,
  };
}

/**
 * Per-metric-family boundary schemas. A blanket `z.number().finite()` is too
 * loose for this contract — it would trust a provider response that sends a
 * negative count or an out-of-range "score", polluting the numerator. Each
 * metric is validated against the domain its meaning actually allows:
 *
 * - COUNT metrics (delivered features, merged PRs, resolved comments) are
 *   non-negative integers.
 * - QUALITY SCORE metrics (review thoroughness, defect freedom) are normalized
 *   to the closed [0, 1] range (see their `PenseroMetric` docs).
 * - DURATION metrics (cycle time in hours) are non-negative reals.
 */
const countMetricSchema = z.number().int().nonnegative();
const scoreMetricSchema = z.number().min(0).max(1);
const durationHoursMetricSchema = z.number().nonnegative().finite();

/**
 * Boundary schema for the per-metric map. Every consumed `PenseroMetric` is an
 * OPTIONAL numeric key (Pensero omits metrics it has no data for); unknown keys
 * are stripped (NOT `.strict()`) so a Pensero-side additive metric we do not
 * yet consume degrades gracefully instead of rejecting the whole record.
 *
 * `metricsShape` is typed `Record<PenseroMetric, …>` so the next metric added
 * to the `PenseroMetric` enum fails `tsc` here until its key is added — the
 * boundary can never silently drop a newly-consumed metric, and each new metric
 * must be assigned a family schema (count / score / duration).
 */
const metricsShape: Record<PenseroMetric, z.ZodType<number>> = {
  [PenseroMetric.DeliveredFeatures]: countMetricSchema,
  [PenseroMetric.MergedPullRequests]: countMetricSchema,
  [PenseroMetric.ResolvedReviewComments]: countMetricSchema,
  [PenseroMetric.ReviewThoroughness]: scoreMetricSchema,
  [PenseroMetric.DefectFreedom]: scoreMetricSchema,
  [PenseroMetric.CycleTimeHours]: durationHoursMetricSchema,
};

const metricsSchema = z
  .object(
    Object.fromEntries(
      Object.entries(metricsShape).map(([key, schema]) => [
        key,
        schema.optional(),
      ])
    ) as Record<PenseroMetric, z.ZodOptional<z.ZodType<number>>>
  )
  .partial();

/**
 * Boundary schema for one person's delivery record. Correlation ids are
 * optional (see normalization); extra Pensero fields are ignored. Field names
 * are camelCase on our side; the client maps Pensero's snake_case wire keys
 * before parsing (see `parseDeliveryMetricsResponse`).
 */
const personDeliveryRecordSchema = z.object({
  personId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  branchId: z.string().min(1).optional(),
  prId: z.string().min(1).optional(),
  metrics: metricsSchema,
});

/**
 * DRF-style paginated envelope. `next` is a cursor URL (or null on the last
 * page); we follow it internally so a paginated response is never silently
 * truncated at the server default page size.
 */
const deliveryMetricsPageSchema = z.object({
  results: z.array(personDeliveryRecordSchema),
  next: z.string().url().nullable().optional(),
});

/**
 * Map one raw Pensero wire record (snake_case correlation keys) onto the
 * camelCase shape our boundary schema validates. Unknown/extra keys are left
 * for Zod to strip. Kept separate so the wire contract is documented in one
 * place.
 */
function toCamelRecord(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) {
    return raw;
  }
  const record = raw as Record<string, unknown>;
  return {
    personId: record.person_id ?? record.personId,
    sessionId: record.session_id ?? record.sessionId,
    branchId: record.branch_id ?? record.branchId,
    prId: record.pr_id ?? record.prId,
    metrics: record.metrics,
  };
}

/**
 * Validate a raw Pensero delivery-metrics page at the boundary. Exported for
 * boundary round-trip tests; throws a `ZodError` on a malformed page.
 */
export function parseDeliveryMetricsPage(json: unknown): {
  records: PenseroPersonDeliveryRecord[];
  next: string | null;
} {
  const shaped =
    typeof json === "object" && json !== null && "results" in json
      ? {
          ...(json as Record<string, unknown>),
          results: Array.isArray((json as { results: unknown }).results)
            ? (json as { results: unknown[] }).results.map(toCamelRecord)
            : (json as { results: unknown }).results,
        }
      : json;
  const page = deliveryMetricsPageSchema.parse(shaped);
  return { records: page.results, next: page.next ?? null };
}

/**
 * Build the absolute first-page delivery-metrics URL from the configured base.
 *
 * String-concatenating `baseUrl + DELIVERY_METRICS_PATH` is unsafe: a base with
 * a trailing slash yields `/api//delivery-metrics/`, and a base carrying a query
 * or fragment (`https://host/api?x=1`) drops the path onto the wrong place. We
 * instead parse the base, reject any query/fragment (they have no meaning on a
 * collection base and signal a misconfiguration), normalize the path so exactly
 * one slash joins it to the endpoint, and resolve against a real `URL` — which
 * also percent-encodes safely. Throws a clear error on a malformed base.
 */
function resolveDeliveryMetricsUrl(baseUrl: string): string {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new Error(
      `Pensero base URL is not a valid absolute URL: "${baseUrl}".`
    );
  }
  if (base.search || base.hash) {
    throw new Error(
      "Pensero base URL must not contain a query string or fragment; set PENSERO_API_BASE_URL to a plain origin/path (e.g. https://pensero.ai/api)."
    );
  }
  // Collapse a trailing slash on the base path so it joins the leading-slash
  // endpoint path with exactly one separator (no `/api//delivery-metrics/`).
  base.pathname = base.pathname.replace(TRAILING_SLASHES_RE, "");
  return `${base.origin}${base.pathname}${DELIVERY_METRICS_PATH}`;
}

/**
 * Combine the caller's abort signal (if any) with a fresh per-request timeout
 * signal so each page fetch aborts on whichever fires first: the caller
 * cancelling, or the request exceeding `timeoutMs`. `AbortSignal.timeout`
 * schedules its own timer that is GC'd with the signal, so there is nothing to
 * clear once the fetch settles.
 */
function buildRequestSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return callerSignal
    ? AbortSignal.any([callerSignal, timeoutSignal])
    : timeoutSignal;
}

/**
 * Fetch all person-centric delivery-metrics records from Pensero, following
 * DRF cursor pagination internally. Returns the validated, person-keyed records
 * — normalization onto our session/branch/PR entities is the caller's job (see
 * `normalizePersonMetrics`).
 *
 * The `tk_...:sk_...` token is sent as `Authorization: Token <token>` (DRF
 * `TokenAuth`). Credentials are resolved from env only; nothing about the token
 * is logged.
 *
 * Each page fetch is bounded by `requestTimeoutMs` (default 30s) and by the
 * caller-supplied `signal`, so a stalled page cannot pin the invocation open —
 * the fetch aborts on whichever fires first.
 */
export async function fetchDeliveryMetrics(options?: {
  /** Bound the number of pages followed (defence against a runaway cursor). */
  maxPages?: number;
  /** Caller cancellation signal; aborts the in-flight page fetch. */
  signal?: AbortSignal;
  /** Per-page wall-clock ceiling in ms (default `DEFAULT_REQUEST_TIMEOUT_MS`). */
  requestTimeoutMs?: number;
}): Promise<PenseroPersonDeliveryRecord[]> {
  const { token, baseUrl } = getRequiredConfig();
  const maxPages = Math.max(1, options?.maxPages ?? 50);
  const requestTimeoutMs = Math.max(
    1,
    options?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  );
  const callerSignal = options?.signal;

  const collected: PenseroPersonDeliveryRecord[] = [];
  const firstUrl = resolveDeliveryMetricsUrl(baseUrl);
  const expectedOrigin = new URL(firstUrl).origin;
  let url: string | null = firstUrl;
  let pages = 0;

  while (url && pages < maxPages) {
    const response: Response = await fetch(url, {
      headers: {
        Authorization: `Token ${token}`,
        Accept: "application/json",
      },
      signal: buildRequestSignal(callerSignal, requestTimeoutMs),
    });

    if (!response.ok) {
      // Do not include the response body — it could echo the token.
      log.error("[pensero/client] Delivery-metrics fetch failed", {
        status: response.status,
      });
      throw new Error(
        `Pensero delivery-metrics request failed: ${response.status}`
      );
    }

    let json: unknown;
    try {
      json = await response.json();
      const { records, next } = parseDeliveryMetricsPage(json);
      collected.push(...records);
      // Only follow a `next` cursor that stays on the Pensero origin. A
      // compromised or spoofed response pointing `next` at another host would
      // otherwise receive our `Authorization: Token` header on the next hop —
      // a credential-exfiltration vector. Cross-origin cursors end pagination.
      url = next && new URL(next).origin === expectedOrigin ? next : null;
    } catch (error) {
      log.error("[pensero/client] Failed to parse delivery-metrics page", {
        error: parseError(error),
      });
      throw error;
    }
    pages += 1;
  }

  // If we exit because we hit the page cap while Pensero still had a `next`
  // cursor, `collected` is a TRUNCATED prefix, not the exhaustive dataset.
  // Returning it silently would make the numerator undercount delivery value,
  // so surface the truncation as an error rather than lie about completeness.
  if (url) {
    log.error("[pensero/client] Delivery-metrics pagination hit the page cap", {
      maxPages,
    });
    throw new Error(
      `Pensero delivery-metrics pagination exceeded maxPages (${maxPages}) with a remaining cursor; result would be truncated. Raise maxPages or narrow the query.`
    );
  }

  return collected;
}
