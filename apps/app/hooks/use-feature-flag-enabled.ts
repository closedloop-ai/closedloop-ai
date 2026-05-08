"use client";

import { useFeatureFlag } from "@repo/analytics/client";

export function useFeatureFlagEnabled(key: string): boolean {
  return useFeatureFlag(key)?.enabled === true;
}
