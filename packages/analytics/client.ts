"use client";

import {
  useFeatureFlag as useFeatureFlagOriginal,
  usePostHog as usePostHogOriginal,
} from "@posthog/next";
import type { FeatureFlagResult } from "posthog-js";
import type { PostHog } from "posthog-js/react";
import { keys } from "./keys";

export type AnalyticsClient = Pick<PostHog, "identify" | "capture" | "reset">;
type RawFeatureFlagResult = FeatureFlagResult | boolean | string | undefined;

export function useAnalytics(): AnalyticsClient {
  return usePostHogSafe();
}

export function useFeatureFlag(flag: string): FeatureFlagResult | undefined {
  return normalizeFeatureFlagResult(flag, useFeatureFlagSafe(flag));
}

const { NEXT_PUBLIC_POSTHOG_KEY } = keys();
const posthogEnabled = !!NEXT_PUBLIC_POSTHOG_KEY;
const usePostHogSafe = posthogEnabled ? usePostHogOriginal : () => noopClient;
const useFeatureFlagSafe = posthogEnabled
  ? (flag: string) => useFeatureFlagOriginal(flag) as RawFeatureFlagResult
  : (flag: string) => ({
      key: flag,
      enabled: true,
      variant: undefined,
      payload: undefined,
    });

/**
 * Preserve the app-facing object contract even when the underlying PostHog hook
 * returns its bare boolean/string feature-flag value.
 */
function normalizeFeatureFlagResult(
  flag: string,
  result: RawFeatureFlagResult
): FeatureFlagResult | undefined {
  if (typeof result === "boolean") {
    return {
      key: flag,
      enabled: result,
      variant: undefined,
      payload: undefined,
    };
  }
  if (typeof result === "string") {
    return {
      key: flag,
      enabled: true,
      variant: result,
      payload: undefined,
    };
  }
  return result;
}

const noopClient: AnalyticsClient = {
  identify: () => {},
  capture: () => undefined,
  reset: () => {},
};
