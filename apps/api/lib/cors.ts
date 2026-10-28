import { POSTHOG_TRACING_HEADERS } from "@repo/analytics/posthog-tracing-headers";
import { ARTIFACT_LINK_CONTINUATION_HEADERS } from "@repo/api/src/types/artifact";
import { DOCUMENT_LIST_CONTINUATION_HEADERS } from "@repo/api/src/types/document";
import {
  FEATURE_FLAG_OVERRIDES_HEADER,
  FEATURE_FLAGS_CHECKED_HEADER,
} from "@repo/api/src/types/feature-flag-overrides";
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
  // ISS-11929: posthog-js sends all three to the cl-api host together.
  ...Object.values(POSTHOG_TRACING_HEADERS),
  // ISS-12048: the Dev Tools overrides, sent only while Dev Mode is on.
  FEATURE_FLAG_OVERRIDES_HEADER,
] as const;

// Response headers a cross-origin browser caller is allowed to READ. Without
// this list the browser hands JavaScript only the CORS-safelisted response
// headers and silently drops the rest — no error, just `null` from
// `headers.get(...)`. Non-browser callers (API keys, MCP, the producer scrape)
// are unaffected either way; this is what makes the same metadata reachable
// from `apps/app`.
// ISS-6941: the `GET /documents` continuation metadata, which exists precisely
// so a paging caller can tell "that was everything" from "the server capped
// me". Listed from the shared contract rather than retyped, so the header a
// route sends and the header CORS exposes cannot drift apart.
// ISS-10102: the same shape for `GET /artifact-links/resolved`, whose bare-array
// arm would otherwise cap a lineage at ARTIFACT_LINK_PAGE_SIZE with no way for
// the caller to notice.
const EXPOSED_RESPONSE_HEADERS = [
  DOCUMENT_LIST_CONTINUATION_HEADERS.Total,
  DOCUMENT_LIST_CONTINUATION_HEADERS.HasMore,
  DOCUMENT_LIST_CONTINUATION_HEADERS.NextOffset,
  ARTIFACT_LINK_CONTINUATION_HEADERS.HasMore,
  ARTIFACT_LINK_CONTINUATION_HEADERS.NextCursor,
  ARTIFACT_LINK_CONTINUATION_HEADERS.SnapshotId,
  // ISS-12048: the flags a Dev Mode request checked, for the overlay.
  FEATURE_FLAGS_CHECKED_HEADER,
] as const;

export function getCorsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": ALLOWED_REQUEST_HEADERS.join(", "),
    "Access-Control-Expose-Headers": EXPOSED_RESPONSE_HEADERS.join(", "),
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
