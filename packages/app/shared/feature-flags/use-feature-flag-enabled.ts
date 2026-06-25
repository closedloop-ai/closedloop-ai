"use client";

import { useFeatureFlagAdapter } from "./provider";

/**
 * Whether the named feature flag is enabled for the current surface. Resolves
 * through the injected feature-flag port (PostHog on web; the desktop shell's
 * own adapter), so `@repo/app` stays free of the analytics SDK.
 */
export function useFeatureFlagEnabled(key: string): boolean {
  return useFeatureFlagAdapter().useFeatureFlagEnabled(key);
}
