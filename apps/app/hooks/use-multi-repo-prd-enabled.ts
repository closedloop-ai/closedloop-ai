"use client";

import { useFeatureFlagEnabled } from "@/hooks/use-feature-flag-enabled";

export function useMultiRepoPrdEnabled(): boolean {
  return useFeatureFlagEnabled("multi-repo-prd");
}
