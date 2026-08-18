"use client";

import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { METRIC_DELTA_UNIFIED_PILL_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { MetricDeltaTreatment } from "@repo/design-system/components/ui/primitives/metric-polarity";

/**
 * ISS-5842 — resolve the delta treatment this surface has opted into.
 *
 * `MetricCard` and the Insights `TrendBadge` live in `packages/design-system`,
 * which cannot read app feature flags, so the primitives take the treatment as a
 * PROP and every consuming surface resolves it here. One hook rather than a flag
 * read per call site: the Sessions strip, the Branches strip, the Insights
 * dashboard, the packs cards and the agents catalog must flip TOGETHER, or the
 * same delta chip renders two ways in one product — the half-migrated state the
 * ticket's own acceptance criteria forbid.
 *
 * `useFeatureFlagEnabledOptional` resolves false with no provider mounted, so a
 * surface (or a Storybook/prototype mount) without flag wiring gets
 * {@link MetricDeltaTreatment.Legacy} — the pre-ISS-5842 render — rather than
 * throwing or leaking the new look.
 */
export function useMetricDeltaTreatment(): MetricDeltaTreatment {
  const unifiedPillEnabled = useFeatureFlagEnabledOptional(
    METRIC_DELTA_UNIFIED_PILL_FEATURE_FLAG_KEY
  );
  return unifiedPillEnabled
    ? MetricDeltaTreatment.UnifiedPill
    : MetricDeltaTreatment.Legacy;
}
