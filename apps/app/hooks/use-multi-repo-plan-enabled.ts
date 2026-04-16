"use client";

import { useFeatureFlag } from "@repo/analytics/client";

export function useMultiRepoPlanEnabled(): boolean {
  return useFeatureFlag("multi-repo-plan")?.enabled === true;
}
