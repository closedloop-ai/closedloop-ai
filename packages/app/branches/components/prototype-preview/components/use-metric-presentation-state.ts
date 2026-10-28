"use client";

import type { BranchesListSurfaceV2PreviewSummaryState } from "@repo/app/branches/components/branches-list-surface-v2-demo";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { parseMetricPresentationState } from "./branch-list-metrics";

/** Keeps the non-visible visual-QA selector reactive and hydration-safe. */
export function useMetricPresentationState(): BranchesListSurfaceV2PreviewSummaryState {
  const searchParams = useSearchParamsValue();
  return parseMetricPresentationState(
    searchParams?.get("metricsState") ?? null
  );
}
