import {
  DEPLOYMENT_ID_HEADER,
  ORG_IDENTITY_HEADER,
} from "@repo/api/src/types/headers";
import { isTrustedOrigin } from "@/lib/trusted-origins";

// Custom (non-CORS-safelisted) request headers the browser app sends on
// cross-origin app→api requests. Each MUST appear in
// Access-Control-Allow-Headers or the browser's preflight blocks the actual
// request. `X-Organization-Id` (org identity) and `x-deployment-id` (FEA-1485
// skew-protection pin) are both set client-side in
// `packages/app/shared/api/use-api-client.ts`.
// ISS-4659: `traceparent`/`tracestate` are the W3C trace-context headers the
// browser RUM SDK attaches to app→api requests once `allowedTracingUrls` is
// configured. Neither is CORS-safelisted, so without them here the browser's
// preflight blocks the real request outright — per the contract above. They are
// listed together because they travel in the same propagator; naming only
// `traceparent` would make a later `tracestate` start failing preflight
// silently.
const ALLOWED_REQUEST_HEADERS = [
  "Content-Type",
  "Authorization",
  "X-Requested-With",
  ORG_IDENTITY_HEADER,
  DEPLOYMENT_ID_HEADER,
  "traceparent",
  "tracestate",
] as const;

export function getCorsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": ALLOWED_REQUEST_HEADERS.join(", "),
    "Access-Control-Max-Age": "86400",
  };

  if (origin && isTrustedOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
    // ISS-4659: without Timing-Allow-Origin the browser zeroes the detailed
    // Resource Timing fields on cross-origin responses, so RUM reports no
    // first_byte_time / download_time / size for api.closedloop.ai and the
    // TTFB-vs-download split is invisible. Scoped to the same trusted origin as
    // the ACAO above — never `*` — so timing detail is not exposed to arbitrary
    // sites.
    headers["Timing-Allow-Origin"] = origin;
    headers.Vary = "Origin"; // important with CDN caching
  }

  return headers;
}

export function addCorsHeaders(response: Response, origin: string | null) {
  const corsHeaders = getCorsHeaders(origin);
  for (const [key, value] of Object.entries(corsHeaders)) {
    response.headers.set(key, value);
  }
  return response;
}
