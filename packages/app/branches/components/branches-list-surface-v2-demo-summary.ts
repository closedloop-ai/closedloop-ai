import type { BranchAnalytics } from "@repo/api/src/types/branch";
import {
  type BranchListMetricBundle,
  type BranchListMetricValue,
  BranchMetricAvailability,
  BranchMetricDisclosure,
  type BranchMetricResult,
} from "@repo/api/src/types/branch-metrics";
import { makeBranchAnalytics } from "./branch-analytics-fixtures";

export const PreviewSummaryState = {
  Complete: "complete",
  Partial: "partial",
  Unavailable: "unavailable",
  NotApplicable: "notApplicable",
  NoData: "noData",
  Loading: "loading",
  Error: "error",
} as const;
export type PreviewSummaryState =
  (typeof PreviewSummaryState)[keyof typeof PreviewSummaryState];

/** Wrap canonical list metrics in the analytics envelope consumed by the surface. */
export function createPreviewBranchAnalytics(
  canonicalMetrics: BranchListMetricBundle
): BranchAnalytics {
  return makeBranchAnalytics({ canonicalMetrics });
}

export function previewSummaryPresentation(
  cards: BranchAnalytics | undefined,
  state: PreviewSummaryState
): { cards: BranchAnalytics | undefined; pending: boolean; errored: boolean } {
  if (state === PreviewSummaryState.Loading) {
    return { cards: undefined, pending: true, errored: false };
  }
  if (state === PreviewSummaryState.Error) {
    return { cards: undefined, pending: false, errored: true };
  }
  if (state === PreviewSummaryState.Complete || !cards?.canonicalMetrics) {
    return { cards, pending: false, errored: false };
  }
  return {
    cards: {
      ...cards,
      canonicalMetrics: forceMetricBundleState(cards.canonicalMetrics, state),
    },
    pending: false,
    errored: false,
  };
}

function forceMetricBundleState(
  bundle: BranchListMetricBundle,
  state: Exclude<PreviewSummaryState, "complete" | "loading" | "error">
): BranchListMetricBundle {
  const metrics = {
    activeBranches: forceMetricValueState(
      bundle.activeBranches,
      state,
      BranchMetricDisclosure.DefaultIncomplete
    ),
    aiSpendUsd: forceMetricValueState(
      bundle.aiSpendUsd,
      state,
      BranchMetricDisclosure.CostIncomplete
    ),
    canonicalLocPerDollar: forceOptionalMetricValueState(
      bundle.canonicalLocPerDollar,
      state,
      BranchMetricDisclosure.LocIncomplete
    ),
    lastActiveAt: forceMetricResultState(
      bundle.lastActiveAt,
      state,
      BranchMetricDisclosure.DefaultIncomplete
    ),
    locPerDollar: forceMetricValueState(
      bundle.locPerDollar,
      state,
      BranchMetricDisclosure.LocIncomplete
    ),
    medianPrSize: forceMetricValueState(
      bundle.medianPrSize,
      state,
      BranchMetricDisclosure.PrIncomplete
    ),
    mergeRatePct: forceMetricValueState(
      bundle.mergeRatePct,
      state,
      BranchMetricDisclosure.PrCoverageIncomplete
    ),
    penseroPointsPerDollar: forceOptionalMetricValueState(
      bundle.penseroPointsPerDollar,
      state,
      BranchMetricDisclosure.PenseroAcquisitionIncomplete
    ),
    pushedLocPerDollar: forceOptionalMetricValueState(
      bundle.pushedLocPerDollar,
      state,
      BranchMetricDisclosure.LocIncomplete
    ),
    totalLocPushed: forceOptionalMetricValueState(
      bundle.totalLocPushed,
      state,
      BranchMetricDisclosure.PushedLocIncomplete
    ),
  } satisfies Record<BranchListMetricKey, BranchListMetricEntry | undefined>;
  return {
    ...bundle,
    ...metrics,
    windowScoped: forceWindowScopedMetrics(bundle.windowScoped, state),
  };
}

type BranchListMetricEntry =
  | BranchListMetricValue
  | BranchMetricResult<unknown>;

type BranchListMetricKey = {
  [Key in keyof BranchListMetricBundle]-?: BranchListMetricBundle[Key] extends
    | BranchListMetricEntry
    | undefined
    ? Key
    : never;
}[keyof BranchListMetricBundle];

function forceWindowScopedMetrics(
  windowScoped: BranchListMetricBundle["windowScoped"],
  state: Exclude<PreviewSummaryState, "complete" | "loading" | "error">
): BranchListMetricBundle["windowScoped"] {
  if (!windowScoped) {
    return;
  }
  return {
    activeBranches: forceMetricValueState(
      windowScoped.activeBranches,
      state,
      BranchMetricDisclosure.DefaultIncomplete
    ),
    aiSpendUsd: forceMetricValueState(
      windowScoped.aiSpendUsd,
      state,
      BranchMetricDisclosure.CostIncomplete
    ),
  };
}

function forceOptionalMetricValueState(
  metric: BranchListMetricValue | undefined,
  state: Exclude<PreviewSummaryState, "complete" | "loading" | "error">,
  partialDisclosure: BranchMetricDisclosure
): BranchListMetricValue | undefined {
  return metric
    ? forceMetricValueState(metric, state, partialDisclosure)
    : undefined;
}

function forceMetricValueState(
  metric: BranchListMetricValue,
  state: Exclude<PreviewSummaryState, "complete" | "loading" | "error">,
  partialDisclosure: BranchMetricDisclosure
): BranchListMetricValue {
  return {
    ...metric,
    current: forceMetricResultState(metric.current, state, partialDisclosure),
    comparison: metric.comparison
      ? {
          ...metric.comparison,
          deltaPct: forceMetricResultState(
            metric.comparison.deltaPct,
            state,
            partialDisclosure
          ),
        }
      : undefined,
  };
}

function forceMetricResultState<Value>(
  result: BranchMetricResult<Value>,
  state: Exclude<PreviewSummaryState, "complete" | "loading" | "error">,
  partialDisclosure: BranchMetricDisclosure
): BranchMetricResult<Value> {
  if (state === PreviewSummaryState.Partial) {
    return result.value === null
      ? result
      : {
          disclosure:
            result.state === BranchMetricAvailability.Partial
              ? result.disclosure
              : partialDisclosure,
          state: BranchMetricAvailability.Partial,
          value: result.value,
        };
  }
  return {
    state: previewMetricAvailability(state),
    value: null,
  };
}

function previewMetricAvailability(
  state: Exclude<
    PreviewSummaryState,
    "complete" | "partial" | "loading" | "error"
  >
) {
  if (state === PreviewSummaryState.NotApplicable) {
    return BranchMetricAvailability.NotApplicable;
  }
  if (state === PreviewSummaryState.NoData) {
    return BranchMetricAvailability.NoData;
  }
  return BranchMetricAvailability.Unavailable;
}
