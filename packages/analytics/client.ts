"use client";

import {
  useFeatureFlag as useFeatureFlagOriginal,
  usePostHog as usePostHogOriginal,
} from "@posthog/next";
import type { FeatureFlagResult } from "posthog-js";
import type { PostHog } from "posthog-js/react";
import { keys } from "./keys";

export type AnalyticsClient = Pick<PostHog, "identify" | "capture" | "reset">;

export function useAnalytics(): AnalyticsClient {
  return usePostHogSafe();
}

export function useFeatureFlag(flag: string): FeatureFlagResult | undefined {
  return useFeatureFlagSafe(flag);
}

const { NEXT_PUBLIC_POSTHOG_KEY } = keys();
const posthogEnabled = !!NEXT_PUBLIC_POSTHOG_KEY;
const usePostHogSafe = posthogEnabled ? usePostHogOriginal : () => noopClient;
const useFeatureFlagSafe = posthogEnabled
  ? useFeatureFlagOriginal
  : (flag: string) => ({
      key: flag,
      enabled: true,
      variant: undefined,
      payload: undefined,
    });

const noopClient: AnalyticsClient = {
  identify: () => {},
  capture: () => undefined,
  reset: () => {},
};
