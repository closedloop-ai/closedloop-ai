import type { BranchMetricCostWindowFacts } from "./branch-cost-facts";

export type CostMetricWindow = {
  key: string;
  /** `null` is unbounded below. */
  startAt: string | null;
  endAt: string;
};

export type CostSliceRow = {
  slice: number;
  spend: number | null;
  included: number;
  unusable: number;
};

export type CostSliceBoundaries = {
  /** Every window edge, ascending: the elementary time slices are cut here. */
  boundaries: string[];
  /** A window with no start reads events from before the first edge. */
  unboundedBelow: boolean;
};

/** Slice -1 carries whether the cohort holds any cost events, not a time slice. */
export const HOLDS_EVENTS_SLICE = -1;
/** Events whose instant cannot be placed in time are unusable in every window. */
export const UNPLACEABLE_SLICE = -2;

export function planCostSliceBoundaries(
  windows: readonly CostMetricWindow[]
): CostSliceBoundaries {
  const edges = new Set<string>();
  for (const window of windows) {
    if (window.startAt !== null) {
      edges.add(window.startAt);
    }
    edges.add(window.endAt);
  }
  return {
    boundaries: [...edges].sort(
      (left, right) => Date.parse(left) - Date.parse(right)
    ),
    unboundedBelow: windows.some((window) => window.startAt === null),
  };
}

/**
 * Slice `i` holds events in `[boundaries[i - 1], boundaries[i])`; slice 0 is
 * everything before the first edge and the last slice everything from the last
 * edge on. A window is the run of slices between its own two edges.
 */
export function foldCostWindow(
  window: CostMetricWindow,
  boundaries: readonly string[],
  rows: readonly CostSliceRow[]
): BranchMetricCostWindowFacts {
  const first =
    window.startAt === null ? 0 : boundaries.indexOf(window.startAt) + 1;
  const last = boundaries.indexOf(window.endAt);
  let spendUsd = 0;
  let included = 0;
  let unusable = 0;
  for (const row of rows) {
    if (row.slice === UNPLACEABLE_SLICE) {
      unusable += Number(row.unusable);
    } else if (row.slice >= first && row.slice <= last) {
      spendUsd += Number(row.spend ?? 0);
      included += Number(row.included);
      unusable += Number(row.unusable);
    }
  }
  return { spendUsd, included, unusable };
}

export function cohortHoldsCostEvents(rows: readonly CostSliceRow[]): boolean {
  return rows.some(
    (row) => row.slice === HOLDS_EVENTS_SLICE && Number(row.included) > 0
  );
}
