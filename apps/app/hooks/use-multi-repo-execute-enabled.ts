"use client";

import { useFeatureFlag } from "@repo/analytics/client";

export function useMultiRepoExecuteEnabled(): boolean {
  return useFeatureFlag("multi-repo-execute")?.enabled === true;
}
