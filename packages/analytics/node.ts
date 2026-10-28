import { PostHog } from "posthog-node";
import { keys } from "./keys";
import {
  POSTHOG_TRACING_HEADERS,
  parsePostHogSessionId,
} from "./posthog-tracing-headers";

const { NEXT_PUBLIC_POSTHOG_KEY, NEXT_PUBLIC_POSTHOG_HOST } = keys();

/**
 * Node-safe analytics client for non-Next server runtimes such as the custom
 * API Socket.IO server. Use `@repo/analytics/server` in Next route modules so
 * accidental Client Component imports still fail fast.
 */
const createNodeAnalytics = () => {
  if (!NEXT_PUBLIC_POSTHOG_KEY) {
    return {
      // ISS-10503: the real client's `alias` merges a pre-auth onboarding id
      // into the authenticated person; a caller reaching for it on an
      // unconfigured deployment must no-op, not crash on `undefined`.
      alias: () => {},
      capture: () => {},
      // Awaitable, like the real client's: a caller that awaits delivery (and
      // holds a serverless function open for it) must not get `undefined` back
      // here and crash on `.then`, nor silently skip the await it asked for.
      captureImmediate: () => Promise.resolve(),
      groupIdentify: () => {},
      identify: () => {},
      shutdown: () => Promise.resolve(),
      withContext: <T>(_data: unknown, fn: () => T) => fn(),
    } as unknown as PostHog;
  }

  return new PostHog(NEXT_PUBLIC_POSTHOG_KEY, {
    host: NEXT_PUBLIC_POSTHOG_HOST,
    flushAt: 1,
    flushInterval: 0,
  });
};

export const nodeAnalytics = createNodeAnalytics();

/**
 * Run `fn` so every capture it makes through {@link nodeAnalytics} carries the
 * browser's `$session_id` from `X-POSTHOG-SESSION-ID` (ISS-11929), linking the
 * server-side event to that session's replay. The header is client-controlled:
 * a missing or malformed value runs `fn` with no session, never a made-up one.
 */
export function withPostHogRequestContext<T>(headers: Headers, fn: () => T): T {
  const sessionId = parsePostHogSessionId(
    headers.get(POSTHOG_TRACING_HEADERS.SessionId)
  );
  return sessionId ? nodeAnalytics.withContext({ sessionId }, fn) : fn();
}
