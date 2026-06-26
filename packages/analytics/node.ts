import { PostHog } from "posthog-node";
import { keys } from "./keys";

const { NEXT_PUBLIC_POSTHOG_KEY, NEXT_PUBLIC_POSTHOG_HOST } = keys();

/**
 * Node-safe analytics client for non-Next server runtimes such as the custom
 * API Socket.IO server. Use `@repo/analytics/server` in Next route modules so
 * accidental Client Component imports still fail fast.
 */
const createNodeAnalytics = () => {
  if (!NEXT_PUBLIC_POSTHOG_KEY) {
    return {
      capture: () => {},
      groupIdentify: () => {},
      identify: () => {},
      shutdown: () => Promise.resolve(),
    } as unknown as PostHog;
  }

  return new PostHog(NEXT_PUBLIC_POSTHOG_KEY, {
    host: NEXT_PUBLIC_POSTHOG_HOST,
    flushAt: 1,
    flushInterval: 0,
  });
};

export const nodeAnalytics = createNodeAnalytics();
