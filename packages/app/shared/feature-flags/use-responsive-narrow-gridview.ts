"use client";

import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { useViewportWidth } from "@repo/design-system/hooks/use-media-query";
import { GRID_TABLE_V2_NARROW_VIEWPORT_MAX_WIDTH } from "@repo/design-system/lib/grid-table-v2-responsive";
import { useFeatureFlagEnabledOptional } from "./use-feature-flag-enabled";

/** Resolves the single web/Desktop rollout key for PRD-727. */
export function useResponsiveNarrowGridviewEnabled(): boolean {
  return useFeatureFlagEnabledOptional(GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY);
}

/** Whether the closed rollout is open and the current viewport is phone-width. */
export function useProductNarrowGridview(): boolean {
  const enabled = useResponsiveNarrowGridviewEnabled();
  const viewportWidth = useViewportWidth();
  return (
    enabled &&
    viewportWidth !== null &&
    viewportWidth <= GRID_TABLE_V2_NARROW_VIEWPORT_MAX_WIDTH
  );
}
