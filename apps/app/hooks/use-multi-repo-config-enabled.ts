"use client";

import { useFeatureFlagEnabled } from "@/hooks/use-feature-flag-enabled";

export function useMultiRepoConfigEnabled(): boolean {
  return useFeatureFlagEnabled("multi-repo-config");
}
