"use client";

import type { Priority } from "@repo/api/src/types/common";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { ARTIFACT_PRIORITY_SURFACES_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import {
  PRIORITY_OPTIONS_HIGHEST_FIRST,
  PRIORITY_OPTIONS_LOWEST_FIRST,
} from "@repo/app/shared/lib/priority-constants";

/**
 * The order every priority menu offers its options in, behind the
 * `artifact-priority-surfaces` gate. One hook so the menus cannot drift from
 * each other the way they had drifted from sorting and grouping.
 *
 * `…Optional` because these menus also mount in Storybook and in mini-table
 * tests, where no flag provider exists; there they resolve closed rather than
 * throwing.
 */
export function usePriorityOptions(): readonly Priority[] {
  return useFeatureFlagEnabledOptional(
    ARTIFACT_PRIORITY_SURFACES_FEATURE_FLAG_KEY
  )
    ? PRIORITY_OPTIONS_HIGHEST_FIRST
    : PRIORITY_OPTIONS_LOWEST_FIRST;
}
