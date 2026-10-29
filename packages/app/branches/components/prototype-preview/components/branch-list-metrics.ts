import {
  type BranchesListSurfaceV2PreviewSummaryState,
  BranchesListSurfaceV2PreviewSummaryState as PresentationState,
} from "@repo/app/branches/components/branches-list-surface-v2-demo";
import { calculatePrototypeBranchListMetrics } from "@repo/lib/branches/branch-prototype-metric-adapter";
import type { DateRange } from "../mock";
import type {
  BranchMetricBundle,
  BranchMetricEvidence,
} from "./branch-list-metric-types";

/** Prototype fixtures execute the shared production metric kernel. */
export function calculateBranchListMetrics(
  cohortIds: readonly string[],
  evidence: BranchMetricEvidence,
  dateRange: DateRange,
  now: Date
): BranchMetricBundle {
  return calculatePrototypeBranchListMetrics(
    cohortIds,
    evidence,
    dateRange,
    now
  );
}

/** Parses the prototype-only, non-visible visual-QA state selector. */
export function parseMetricPresentationState(
  value: string | null | undefined
): BranchesListSurfaceV2PreviewSummaryState {
  if (value === undefined || value === null || value.length > 64) {
    return PresentationState.Complete;
  }
  return (
    Object.values(PresentationState).find((state) => state === value) ??
    PresentationState.Complete
  );
}
