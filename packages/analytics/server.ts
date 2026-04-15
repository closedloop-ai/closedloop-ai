import "server-only";
import { PostHog } from "posthog-node";
import { keys } from "./keys";

const { NEXT_PUBLIC_POSTHOG_KEY, NEXT_PUBLIC_POSTHOG_HOST } = keys();

// Create a no-op analytics client for placeholder credentials
const createAnalytics = () => {
  if (!NEXT_PUBLIC_POSTHOG_KEY) {
    return {
      capture: () => {},
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

export const analytics = createAnalytics();
