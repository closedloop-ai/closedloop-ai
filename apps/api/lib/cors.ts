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
const ALLOWED_REQUEST_HEADERS = [
  "Content-Type",
  "Authorization",
  "X-Requested-With",
  ORG_IDENTITY_HEADER,
  DEPLOYMENT_ID_HEADER,
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
