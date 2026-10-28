"use client";

import { usePostHog } from "@posthog/next";
import type { BrowserAnalyticsContext } from "./browser-context";
import { installBrowserAnalyticsContext } from "./posthog-context";

/** ISS-12555: before sibling render-time captures, including persistence repair. */
export function PostHogContextGuard({
  context,
}: {
  context: BrowserAnalyticsContext;
}) {
  const client = usePostHog();
  if (globalThis.window !== undefined && client) {
    installBrowserAnalyticsContext(client, context);
  }
  return null;
}
