import { z } from "zod";

/**
 * The request headers posthog-js attaches to a host listed in its
 * `__add_tracing_headers` option (ISS-11929). A wire value owned by posthog-js:
 * every one must be in `apps/api`'s CORS `Access-Control-Allow-Headers`, or the
 * browser's preflight blocks the request they ride on.
 */
export const POSTHOG_TRACING_HEADERS = {
  SessionId: "X-POSTHOG-SESSION-ID",
  WindowId: "X-POSTHOG-WINDOW-ID",
  DistinctId: "X-POSTHOG-DISTINCT-ID",
} as const;

// posthog-js mints every session id with `uuidv7()`; nothing else is one.
const POSTHOG_SESSION_ID = z.uuidv7();

/**
 * The browser's PostHog session id from a client-controlled header, or
 * `undefined` when it is absent or not a UUIDv7.
 */
export function parsePostHogSessionId(
  value: string | null | undefined
): string | undefined {
  const parsed = POSTHOG_SESSION_ID.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
