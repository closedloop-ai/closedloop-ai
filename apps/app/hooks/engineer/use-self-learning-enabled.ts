"use client";

import { useFeatureFlag } from "@repo/analytics/client";

export function useSelfLearningEnabled(): boolean {
  return useFeatureFlag("self-learning")?.enabled !== false;
}
