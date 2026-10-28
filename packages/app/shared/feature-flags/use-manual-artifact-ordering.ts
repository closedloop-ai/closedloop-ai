"use client";

import { MANUAL_ARTIFACT_ORDERING_FLAG_KEY } from "@repo/api/src/types/manual-artifact-ordering-flag";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";

/** Resolve the one manual-ordering rollout key shared by every UI consumer. */
export function useManualArtifactOrderingEnabled(): boolean {
  return useFeatureFlagEnabledOptional(MANUAL_ARTIFACT_ORDERING_FLAG_KEY);
}
