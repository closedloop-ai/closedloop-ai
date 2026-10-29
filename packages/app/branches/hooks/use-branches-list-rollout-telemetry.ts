"use client";

import { BranchDataState } from "@repo/api/src/types/branch";
import { BranchesListRolloutDecisionReason } from "@repo/api/src/types/branches-list-rollout";
import {
  GridviewRolloutDecisionOutcome,
  SharedAnalyticsComponent,
  SurfaceAnalyticsEvent,
} from "@repo/api/src/types/surface-analytics";
import { useSurfaceAnalytics } from "@repo/app/shared/observability/surface-analytics-context";
import { useEffect, useRef } from "react";
import type { BranchRow } from "../lib/branch-row";

export type BranchesListTelemetryInput = {
  rows: readonly BranchRow[];
  total: number;
  hasCompletePopulation: boolean;
  isPending: boolean;
};

/** Emits production health evidence without changing the rendered body. */
export function useBranchesListRolloutTelemetry({
  rows,
  total,
  hasCompletePopulation,
  isPending,
}: BranchesListTelemetryInput): void {
  const { capture } = useSurfaceAnalytics();
  const emittedSignatureRef = useRef("");
  const hydratedRowCount = rows.filter(
    (row) =>
      row.dataState === undefined || row.dataState === BranchDataState.Ready
  ).length;

  useEffect(() => {
    if (isPending) {
      return;
    }
    const signature = [
      rows.length,
      hydratedRowCount,
      total,
      hasCompletePopulation,
    ].join(":");
    if (signature === emittedSignatureRef.current) {
      return;
    }
    emittedSignatureRef.current = signature;
    capture(SurfaceAnalyticsEvent.GridviewRolloutDecision, {
      component: SharedAnalyticsComponent.BranchesListSurfaceV2,
      hydrated_row_count: hydratedRowCount,
      outcome:
        hydratedRowCount === rows.length
          ? GridviewRolloutDecisionOutcome.Enabled
          : GridviewRolloutDecisionOutcome.Unresolved,
      reason:
        hydratedRowCount === rows.length
          ? BranchesListRolloutDecisionReason.HydrationComplete
          : BranchesListRolloutDecisionReason.HydrationPartial,
      row_count: rows.length,
    });
    capture(SurfaceAnalyticsEvent.GridviewRolloutDecision, {
      component: SharedAnalyticsComponent.BranchesListSurfaceV2,
      outcome: parityOutcome(hasCompletePopulation, rows.length, total),
      reason: parityReason(hasCompletePopulation, rows.length, total),
      row_count: rows.length,
    });
  }, [
    capture,
    hasCompletePopulation,
    hydratedRowCount,
    isPending,
    rows,
    total,
  ]);
}
function parityOutcome(
  hasCompletePopulation: boolean,
  rowCount: number,
  total: number
) {
  if (!hasCompletePopulation) {
    return GridviewRolloutDecisionOutcome.Unresolved;
  }
  return rowCount === total
    ? GridviewRolloutDecisionOutcome.Enabled
    : GridviewRolloutDecisionOutcome.Disabled;
}
function parityReason(
  hasCompletePopulation: boolean,
  rowCount: number,
  total: number
) {
  if (!hasCompletePopulation) {
    return BranchesListRolloutDecisionReason.ParityUnmeasured;
  }
  return rowCount === total
    ? BranchesListRolloutDecisionReason.ParityAligned
    : BranchesListRolloutDecisionReason.ParityMismatch;
}
