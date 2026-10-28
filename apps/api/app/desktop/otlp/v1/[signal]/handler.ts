import { parseDesktopClientAttributionHeaders } from "@repo/api/src/types/desktop-client-attribution";
import { log } from "@repo/observability/log";
import {
  isKeylessTelemetrySignal,
  KEYLESS_TELEMETRY_COLLECTOR_TIMEOUT_MS,
  KEYLESS_TELEMETRY_CONTENT_TYPE,
  KEYLESS_TELEMETRY_MAX_BODY_BYTES,
  KEYLESS_TELEMETRY_RETRY_AFTER_SECONDS,
  KeylessTelemetryRejectionReason,
  type KeylessTelemetrySignal,
  keylessTelemetrySignalPath,
} from "@repo/shared-platform/keyless-telemetry";
import { getVercelOidcToken } from "@vercel/oidc";
import type { NextResponse } from "next/server";
import {
  rateLimitedResponse,
  readCappedRequestBytes,
} from "@/app/desktop/route-helpers";
import { env } from "@/env";
import {
  FixedWindowRateLimiter,
  fixedWindowRetryAfterSeconds,
} from "@/lib/fixed-window-rate-limiter";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  payloadTooLargeResponse,
  requestBodyTruncationError,
  successResponse,
} from "@/lib/route-utils";

export const DESKTOP_OTLP_EXPORT_MEASURED_EVENT =
  "desktop_otlp_export_measured";

type DesktopOtlpRouteContext = {
  params: Promise<{ signal?: string }>;
};

export async function handleDesktopOtlpExport(
  request: Request,
  context: DesktopOtlpRouteContext
): Promise<Response> {
  const { signal } = await context.params;
  const collectorUrl = env.DESKTOP_OTLP_COLLECTOR_URL;
  const audience = env.DESKTOP_OTLP_COLLECTOR_OIDC_AUDIENCE;
  if (!(collectorUrl && audience && isKeylessTelemetrySignal(signal))) {
    return notFoundResponse("Route");
  }
  if (request.headers.get("content-type") !== KEYLESS_TELEMETRY_CONTENT_TYPE) {
    return reject(KeylessTelemetryRejectionReason.InvalidContentType);
  }
  const { installationId } = parseDesktopClientAttributionHeaders(
    request.headers
  );
  if (!installationId) {
    return reject(KeylessTelemetryRejectionReason.InvalidRequest);
  }
  if (!desktopOtlpInstallBudget.attempt(installationId, Date.now())) {
    return rateLimitedResponse(
      KeylessTelemetryRejectionReason.RateLimited,
      fixedWindowRetryAfterSeconds(DESKTOP_OTLP_INSTALL_BUDGET_WINDOW_MS)
    );
  }

  // Body cap: the desktop transport's own ceiling, above which it never sends.
  // No batch byte size has been measured anywhere (the relay logs none and the
  // Collector's level:normal telemetry has no request-size metric), so this is
  // the smallest value that cannot reject a real batch. Re-derive it from the
  // wireBytes this route logs below, then retire that log (ISS-12229).
  let read: Awaited<ReturnType<typeof readCappedRequestBytes>>;
  try {
    read = await readCappedRequestBytes(
      request,
      KEYLESS_TELEMETRY_MAX_BODY_BYTES
    );
  } catch (error) {
    return errorResponse("Failed to read request body", error);
  }
  if (!read.ok) {
    return payloadTooLargeResponse("Request body too large", {
      code: KeylessTelemetryRejectionReason.PayloadTooLarge,
    });
  }
  const truncationError = requestBodyTruncationError(request, read.bytesRead);
  if (truncationError !== null) {
    return errorResponse("Failed to read request body", truncationError);
  }
  log.info(DESKTOP_OTLP_EXPORT_MEASURED_EVENT, {
    signal,
    wireBytes: read.bytesRead,
  });

  return forwardToCollector(collectorUrl, audience, signal, read.value);
}

async function forwardToCollector(
  collectorUrl: string,
  audience: string,
  signal: KeylessTelemetrySignal,
  body: Buffer
): Promise<Response> {
  const timeout = AbortSignal.timeout(KEYLESS_TELEMETRY_COLLECTOR_TIMEOUT_MS);
  let response: Response;
  try {
    // The token exchange takes no signal, so it shares the deadline by race.
    const token = await Promise.race([
      getVercelOidcToken({ audience }),
      new Promise<never>((_, rejectToken) =>
        timeout.addEventListener("abort", () => rejectToken(timeout.reason), {
          once: true,
        })
      ),
    ]);
    response = await fetch(
      new URL(keylessTelemetrySignalPath(signal), collectorUrl),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": KEYLESS_TELEMETRY_CONTENT_TYPE,
        },
        body: new Uint8Array(body),
        signal: timeout,
      }
    );
  } catch (error) {
    return collectorUnavailable(
      timeout.aborted
        ? KeylessTelemetryRejectionReason.RequestTimeout
        : KeylessTelemetryRejectionReason.CollectorUnavailable,
      error
    );
  }
  await response.body?.cancel().catch(() => undefined);
  if (response.ok) {
    return successResponse({ accepted: true });
  }
  if (COLLECTOR_PAYLOAD_REFUSAL_STATUSES.has(response.status)) {
    log.warn("desktop otlp: collector rejected payload", {
      status: response.status,
    });
    return reject(KeylessTelemetryRejectionReason.OtlpRejected);
  }
  return collectorUnavailable(
    KeylessTelemetryRejectionReason.CollectorUnavailable,
    new Error(`Collector answered ${response.status}`)
  );
}

function reject(reason: KeylessTelemetryRejectionReason): NextResponse {
  return badRequestResponse("Invalid OTLP export", { code: reason });
}

function collectorUnavailable(
  reason: KeylessTelemetryRejectionReason,
  error: unknown
): NextResponse {
  const response = errorResponse("Failed to forward OTLP export", error, 503, {
    code: reason,
  });
  response.headers.set(
    "Retry-After",
    String(KEYLESS_TELEMETRY_RETRY_AFTER_SECONDS)
  );
  return response;
}

/**
 * ISS-12211 per-install budget: 47 exports per 60 s, the most one install's
 * OTel SDK can send in a minute given the fleet's measured peaks (prod
 * Collector `otelcol_receiver_accepted_*`, 7 days to 2026-10-07 20:20Z):
 *   1  metric export     PeriodicExportingMetricReader, 60 s interval
 * + 12 span exports      BatchSpanProcessor 5 s timer (sdk-trace-base 2.8.0)
 * +  6 span exports      size-triggered: ceil(2,685 / 512), 2,685 being the
 *                        fleet's peak spans in one minute, 512 the batch size
 * + 28 log exports       BatchLogRecordProcessor sends >= 1 record per export;
 *                        28 is the fleet's peak log records in one minute
 * +  0 renderer exports  one per renderer span; 0 of 173,472 indexed cl-desktop
 *                        spans came from the renderer scope
 * = 47. The fleet peaks bound any single install, so this is an upper bound.
 * Process-local, so a request that lands on another instance is not charged
 * here (apps/api serverless rule).
 */
export const DESKTOP_OTLP_INSTALL_BUDGET_PER_WINDOW = 47;
export const DESKTOP_OTLP_INSTALL_BUDGET_WINDOW_MS = 60_000;

export const desktopOtlpInstallBudget = new FixedWindowRateLimiter({
  maxRequests: DESKTOP_OTLP_INSTALL_BUDGET_PER_WINDOW,
  windowMs: DESKTOP_OTLP_INSTALL_BUDGET_WINDOW_MS,
});

/**
 * The statuses an OTLP/HTTP receiver answers when the payload itself is at
 * fault: malformed (400), too large (413), wrong media type (415). Any other
 * 4xx comes from the hop in front of it (the relay ALB's JWT check or 403
 * deny rule, a wrong path, a throttle), which is the ingress being unavailable
 * to this deployment, not a bad batch, so it takes the retryable 503 path.
 */
const COLLECTOR_PAYLOAD_REFUSAL_STATUSES: ReadonlySet<number> = new Set([
  400, 413, 415,
]);
