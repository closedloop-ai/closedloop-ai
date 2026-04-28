"use client";

import { useFeatureFlagEnabled } from "@/hooks/use-feature-flag-enabled";

export function useMultiRepoExecuteEnabled(): boolean {
  return useFeatureFlagEnabled("multi-repo-execute");
}
