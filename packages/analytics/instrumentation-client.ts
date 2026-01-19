import posthog from "posthog-js";
import { keys } from "./keys";

export const initializeAnalytics = () => {
  const { NEXT_PUBLIC_POSTHOG_KEY, NEXT_PUBLIC_POSTHOG_HOST } = keys();

  // Skip initialization if using placeholder credentials
  if (NEXT_PUBLIC_POSTHOG_KEY === "phc_placeholder") {
    return;
  }

  posthog.init(NEXT_PUBLIC_POSTHOG_KEY, {
    api_host: NEXT_PUBLIC_POSTHOG_HOST,
    defaults: "2025-05-24",
  });
};
