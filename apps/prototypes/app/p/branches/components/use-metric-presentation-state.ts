"use client";

import { useSearchParams } from "next/navigation";
import type { MetricPresentationState } from "./branch-list-metric-types";
import { parseMetricPresentationState } from "./branch-list-metrics";

/** Keeps the non-visible visual-QA selector reactive and hydration-safe. */
export function useMetricPresentationState(): MetricPresentationState {
  const searchParams = useSearchParams();
  return parseMetricPresentationState(
    searchParams?.get("metricsState") ?? null
  );
}
