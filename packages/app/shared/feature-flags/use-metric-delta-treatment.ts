"use client";

import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import {
  METRIC_DELTA_NEUTRAL_PILL_FEATURE_FLAG_KEY,
  METRIC_DELTA_UNIFIED_PILL_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { MetricDeltaTreatment } from "@repo/design-system/components/ui/primitives/metric-polarity";

/**
 * ISS-5842 / ISS-6493 — resolve the delta treatment this surface has opted into.
 *
 * `MetricCard` and the Insights `TrendBadge` live in `packages/design-system`,
 * which cannot read app feature flags, so the primitives take the treatment as a
 * PROP and every consuming surface resolves it here. One hook rather than a flag
 * read per call site: the Sessions strip, the Branches strip, the Insights
 * dashboard, the packs cards and the agents catalog must flip TOGETHER, or the
 * same delta chip renders two ways in one product — the half-migrated state the
 * ticket's own acceptance criteria forbid. It is also why ISS-6493 adds its gate
 * HERE rather than at a call site: all five consumers inherit it at once.
 *
 * ## How the two gates compose
 *
 * `UnifiedPill` is a strict superset of `NeutralPill` — it pills every tone AND
 * drops the verdict word — so it is checked first and wins whenever both are on.
 * There is no fourth state to reason about, and no permutation in which the
 * neutral gate can subtract something the unified gate was adding.
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
  const neutralPillEnabled = useFeatureFlagEnabledOptional(
    METRIC_DELTA_NEUTRAL_PILL_FEATURE_FLAG_KEY
  );
  if (unifiedPillEnabled) {
    return MetricDeltaTreatment.UnifiedPill;
  }
  return neutralPillEnabled
    ? MetricDeltaTreatment.NeutralPill
    : MetricDeltaTreatment.Legacy;
}
