"use client";

import { useFeatureFlagEnabled } from "@/hooks/use-feature-flag-enabled";

export function useMultiRepoPlanEnabled(): boolean {
  return useFeatureFlagEnabled("multi-repo-plan");
}
