type FeatureFlagAnalyticsClient = {
  isFeatureEnabled?: (
    flag: string,
    distinctId: string
  ) => boolean | Promise<boolean>;
};

/**
 * Evaluates a PostHog feature flag from server runtimes that may or may not be
 * allowed to import Next's server-only analytics entrypoint.
 */
export async function isFeatureFlagEnabledForDistinctId(
  flag: string,
  distinctId: string
): Promise<boolean | null> {
  const analytics = await loadFeatureFlagAnalyticsClient();
  if (typeof analytics?.isFeatureEnabled !== "function") {
    return null;
  }

  return (await analytics.isFeatureEnabled(flag, distinctId)) === true;
}

async function loadFeatureFlagAnalyticsClient(): Promise<FeatureFlagAnalyticsClient | null> {
  try {
    const serverAnalytics = await import("./server");
    return serverAnalytics.analytics as FeatureFlagAnalyticsClient;
  } catch {
    try {
      const nodeAnalytics = await import("./node");
      return nodeAnalytics.nodeAnalytics as FeatureFlagAnalyticsClient;
    } catch {
      return null;
    }
  }
}
