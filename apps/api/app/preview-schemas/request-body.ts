import "server-only";

import type { z } from "zod";
import { createThrottledMonitoredEvent } from "@/lib/observability/throttled-monitored-event";
import { type ParseBodyResult, parseBody } from "@/lib/route-utils";
import { PREVIEW_SCHEMA_REQUEST_MAX_BYTES } from "./constants";

/**
 * ISS-11034 (ISS-7567 AC2): the monitored event for a preview-schemas request
 * refused by `PREVIEW_SCHEMA_REQUEST_MAX_BYTES`. The cap is checked only after
 * GitHub OIDC auth, so a 413 here is a deploy job outgrowing the cap (and
 * failing on it) or a replayed token probing it. `parseBody` still logs the
 * generic `api.request_body_over_cap` warning; this is the per-surface event.
 */
export const PREVIEW_SCHEMA_REQUEST_BODY_OVER_CAP_EVENT =
  "preview_schemas_request_body_over_cap";

const overCapEvent = createThrottledMonitoredEvent();

/**
 * Exposed so tests can `clear()` it between cases; production code must not
 * reach into it.
 */
export const previewSchemaRequestBodyOverCapThrottle = overCapEvent.throttle;

const PAYLOAD_TOO_LARGE_STATUS = 413;

/**
 * `parseBody` at this surface's cap, reporting a 413 to the monitored event.
 * Keyed by route path, so the keyspace is the routes on this surface. Drains on
 * every call, before the route's log flush, so a burst followed by in-cap
 * requests still flushes its suppressed count (#7887 review, whitlockk).
 */
export async function parsePreviewSchemaRequestBody<T extends z.ZodType>(
  request: Request,
  validator: T,
  maxBytes: number = PREVIEW_SCHEMA_REQUEST_MAX_BYTES
): Promise<ParseBodyResult<z.infer<T>>> {
  const result = await parseBody(request, validator, { maxBytes });
  overCapEvent.drainExpired(Date.now());
  if (result.errorResponse?.status === PAYLOAD_TOO_LARGE_STATUS) {
    const route = new URL(request.url).pathname;
    overCapEvent.report(
      route,
      {
        event: PREVIEW_SCHEMA_REQUEST_BODY_OVER_CAP_EVENT,
        payload: { route, maxBytes },
      },
      {}
    );
  }
  return result;
}
