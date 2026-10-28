"use client";

import {
  BranchesListSurfaceV2PreviewAdapter,
  BranchesListSurfaceV2PreviewPullRequestState,
  type BranchesListSurfaceV2PreviewState,
  type BranchesListSurfaceV2PreviewSummaryState,
  createBranchesListSurfaceV2PreviewAnalytics,
  createBranchesListSurfaceV2PreviewRow,
  type DateRange,
  DateRange as DateRangeValue,
  BranchesListSurfaceV2PreviewSummaryState as PresentationState,
} from "@repo/app/branches/components/branches-list-surface-v2-demo";
import {
  type BranchPrototypeMetricPeriod,
  calculatePrototypeBranchListMetrics,
  BranchPrototypeMetricPeriod as PrototypeMetricPeriod,
} from "@repo/lib/branches/branch-prototype-metric-adapter";
import { type Dispatch, type SetStateAction, useCallback } from "react";
import {
  type BranchRow,
  branchRows,
  type PrState as PrototypePrState,
  PrState,
} from "../mock";
import {
  BRANCH_METRIC_FIXTURE_NOW,
  branchMetricEvidence,
} from "./branch-list-fixtures";
import type { BranchMetricEvidence } from "./branch-list-metric-types";

export function BranchesList({
  onOpenDetail,
  state,
  onStateChange,
  rows = branchRows,
  evidence = branchMetricEvidence,
  now = BRANCH_METRIC_FIXTURE_NOW,
  presentationState = PresentationState.Complete,
}: {
  onOpenDetail: (item: BranchRow) => void;
  state: BranchesListSurfaceV2PreviewState;
  onStateChange: Dispatch<SetStateAction<BranchesListSurfaceV2PreviewState>>;
  rows?: readonly BranchRow[];
  evidence?: BranchMetricEvidence;
  now?: Date;
  presentationState?: BranchesListSurfaceV2PreviewSummaryState;
}) {
  const resolveSummaryCards = useCallback(
    (cohort: readonly { id: string }[], dateRange: DateRange) => {
      return createBranchesListSurfaceV2PreviewAnalytics(
        calculatePrototypeBranchListMetrics(
          cohort.map((row) => row.id),
          evidence,
          toPrototypeMetricPeriod(dateRange),
          now
        )
      );
    },
    [evidence, now]
  );

  return (
    <BranchesListSurfaceV2PreviewAdapter
      now={now}
      onOpenDetail={onOpenDetail}
      onStateChange={onStateChange}
      projectRow={toPreviewRow}
      resolveSummaryCards={resolveSummaryCards}
      rows={rows}
      state={state}
      summaryState={presentationState}
    />
  );
}

/** Projects the preserved prototype fixture into the production list contract. */
export function toPreviewRow(row: BranchRow) {
  return createBranchesListSurfaceV2PreviewRow({
    additions: row.additions,
    baseBranch: row.baseBranch,
    branchName: row.branchName,
    checksPassed: row.checksPassed,
    checksTotal: row.checksTotal,
    collaborators: row.collaborators,
    commentCount: row.commentCount,
    dataState: row.dataState,
    deletions: row.deletions,
    id: row.id,
    lastActivityAt: row.lastActivityAt,
    lastActivityLabel: row.lastActivityLabel,
    owner: row.owner,
    priority: row.priority,
    provenance: row.provenance,
    prNumber: row.prNumber,
    prState: toPreviewPrState(row.prState),
    prTitle: row.prTitle,
    prUrl: row.prUrl,
    repo: row.repo,
    sessionCount: row.sessionCount,
    status: row.status,
    tags: row.tags,
  });
}

/** Converts the production toolbar range to the prototype metric kernel period. */
export function toPrototypeMetricPeriod(
  dateRange: DateRange
): BranchPrototypeMetricPeriod {
  if (dateRange === DateRangeValue.Last7Days) {
    return PrototypeMetricPeriod.SevenDays;
  }
  if (dateRange === DateRangeValue.Last30Days) {
    return PrototypeMetricPeriod.ThirtyDays;
  }
  if (dateRange === DateRangeValue.Last60Days) {
    return PrototypeMetricPeriod.SixtyDays;
  }
  if (dateRange === DateRangeValue.Last90Days) {
    return PrototypeMetricPeriod.NinetyDays;
  }
  return PrototypeMetricPeriod.All;
}

function toPreviewPrState(state: PrototypePrState | null) {
  if (state === PrState.Open) {
    return BranchesListSurfaceV2PreviewPullRequestState.Open;
  }
  if (state === PrState.Merged) {
    return BranchesListSurfaceV2PreviewPullRequestState.Merged;
  }
  if (state === PrState.Closed) {
    return BranchesListSurfaceV2PreviewPullRequestState.Closed;
  }
  return null;
}
