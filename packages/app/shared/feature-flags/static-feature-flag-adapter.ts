import type { FeatureFlagAdapter } from "./feature-flag-adapter";

/**
 * Fixed-state feature-flag adapter for unit tests and Storybook. Proves shared
 * code runs against a non-PostHog flag source (FEA-1510 injection seam) and
 * avoids mocking the analytics SDK in consumers. Flags default to disabled —
 * the deterministic baseline for stories/tests — with named flags opted in.
 */
export type StaticFeatureFlagOptions = {
  enabledFlags?: readonly string[];
};

export function createStaticFeatureFlagAdapter(
  options: StaticFeatureFlagOptions = {}
): FeatureFlagAdapter {
  const enabled = new Set(options.enabledFlags ?? []);
  return {
    // Reads a closed-over Set: no hooks called, trivially rules-of-hooks safe.
    useFeatureFlagEnabled: (key: string) => enabled.has(key),
  };
}
