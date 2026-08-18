"use client";

import { CHART_SERIES_COLOR_LIMIT } from "@repo/design-system/components/ui/chart-colors";
import { useFeatureFlagEnabledOptional } from "../feature-flags/use-feature-flag-enabled";
import { CHART_DISTINGUISHABLE_SERIES_FEATURE_FLAG_KEY } from "./feature-flags";

/**
 * ISS-5523 — the series cap a categorical chart should draw with, or `undefined`
 * to draw every series exactly as the chart always has.
 *
 * One hook rather than a flag read at each chart, so the three surfaces that
 * draw per-model series (the Insights dashboard row, the Insights dashboard
 * tile, and the agent-detail usage trend) cannot end up capped at different
 * numbers, or gated on different keys, after a later edit to only one of them.
 *
 * Reads the flag via the OPTIONAL variant: these charts are shared components
 * that also mount under Storybook and unit tests with no feature-flag provider,
 * where the gate should read closed rather than throw.
 */
export function useChartMaxSeries(): number | undefined {
  const enabled = useFeatureFlagEnabledOptional(
    CHART_DISTINGUISHABLE_SERIES_FEATURE_FLAG_KEY
  );
  return enabled ? CHART_SERIES_COLOR_LIMIT : undefined;
}
