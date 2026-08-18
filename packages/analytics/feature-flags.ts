/**
 * ISS-4556: the return type admits `undefined`, because posthog-node's does.
 * `isFeatureEnabled(): Promise<boolean | undefined>` — "undefined if not found"
 * — and its failure path resolves rather than rejects: on a request failure
 * `getFeatureFlagDetailsStateless` returns `undefined` ("Request failed, return
 * undefined"), `_getFeatureFlagResult` records an internal `UNKNOWN_ERROR` and
 * leaves the result undefined, and that propagates out untouched. Declaring the
 * narrower `boolean` here is what made an outage indistinguishable from an
 * evaluated OFF below.
 */
type FeatureFlagAnalyticsClient = {
  isFeatureEnabled?: (
    flag: string,
    distinctId: string
  ) => boolean | undefined | Promise<boolean | undefined>;
};

/**
 * Evaluates a PostHog feature flag from server runtimes that may or may not be
 * allowed to import Next's server-only analytics entrypoint.
 *
 * @returns `true`/`false` when PostHog actually ANSWERED, and `null` when it did
 *   not — no analytics client is configured, or the client resolved `undefined`
 *   (flag unknown to the project, evaluation failed, or the request to PostHog
 *   failed outright).
 *
 * ISS-4556: that `undefined` case used to be folded into `false` by a bare
 * `=== true`. Every caller that only asks "is it on?" is unaffected — they all
 * compare `=== true` and so still fail CLOSED — but a caller that needs several
 * reads in one page load to AGREE has to be able to tell "PostHog said no" from
 * "PostHog said nothing", and the collapse made the UNAVAILABLE branch of
 * `evaluateFeatureFlagForAnyIdentity` unreachable for the outage it exists to
 * absorb: only a thrown evaluation or a wholly unconfigured client ever reached
 * it, and a real outage does neither.
 */
export async function isFeatureFlagEnabledForDistinctId(
  flag: string,
  distinctId: string
): Promise<boolean | null> {
  const analytics = await loadFeatureFlagAnalyticsClient();
  if (typeof analytics?.isFeatureEnabled !== "function") {
    return null;
  }

  const result = await analytics.isFeatureEnabled(flag, distinctId);
  return result === undefined ? null : result === true;
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
