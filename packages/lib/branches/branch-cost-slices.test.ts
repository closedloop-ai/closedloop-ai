import { describe, expect, it } from "vitest";
import {
  type CostMetricWindow,
  cohortHoldsCostEvents,
  foldCostWindow,
  HOLDS_EVENTS_SLICE,
  planCostSliceBoundaries,
  UNPLACEABLE_SLICE,
} from "./branch-cost-slices";

const A = "2026-08-01T00:00:00.000Z";
const B = "2026-08-02T00:00:00.000Z";
const C = "2026-08-03T00:00:00.000Z";

const first: CostMetricWindow = { key: "first", startAt: A, endAt: B };
const second: CostMetricWindow = { key: "second", startAt: B, endAt: C };

describe("planCostSliceBoundaries", () => {
  it("cuts once at every distinct edge, ascending, however the windows overlap", () => {
    const plan = planCostSliceBoundaries([second, first]);

    expect(plan.boundaries).toEqual([A, B, C]);
    expect(plan.unboundedBelow).toBe(false);
  });

  it("reports a window with no start as unbounded below", () => {
    const plan = planCostSliceBoundaries([
      { key: "all", startAt: null, endAt: B },
    ]);

    expect(plan.boundaries).toEqual([B]);
    expect(plan.unboundedBelow).toBe(true);
  });
});

describe("foldCostWindow", () => {
  const boundaries = [A, B, C];
  const rows = [
    { slice: 0, spend: 100, included: 1, unusable: 0 },
    { slice: 1, spend: 10, included: 2, unusable: 1 },
    { slice: 2, spend: 20, included: 3, unusable: 0 },
    { slice: 3, spend: 400, included: 4, unusable: 0 },
  ];

  it("sums only the slices between a window's own two edges", () => {
    expect(foldCostWindow(first, boundaries, rows)).toEqual({
      spendUsd: 10,
      included: 2,
      unusable: 1,
    });
    expect(foldCostWindow(second, boundaries, rows)).toEqual({
      spendUsd: 20,
      included: 3,
      unusable: 0,
    });
  });

  it("starts an unbounded window at the first slice", () => {
    expect(
      foldCostWindow({ key: "all", startAt: null, endAt: B }, boundaries, rows)
    ).toEqual({ spendUsd: 110, included: 3, unusable: 1 });
  });

  it("counts an event that cannot be placed in time as unusable in every window", () => {
    const withUnplaceable = [
      ...rows,
      { slice: UNPLACEABLE_SLICE, spend: 7, included: 0, unusable: 2 },
    ];

    expect(foldCostWindow(first, boundaries, withUnplaceable)).toEqual({
      spendUsd: 10,
      included: 2,
      unusable: 3,
    });
    expect(foldCostWindow(second, boundaries, withUnplaceable).unusable).toBe(
      2
    );
  });

  it("keeps the holds-events marker out of every window", () => {
    const marker = {
      slice: HOLDS_EVENTS_SLICE,
      spend: 0,
      included: 1,
      unusable: 0,
    };

    expect(foldCostWindow(first, boundaries, [marker])).toEqual({
      spendUsd: 0,
      included: 0,
      unusable: 0,
    });
  });
});

describe("cohortHoldsCostEvents", () => {
  it("reads only the holds-events marker row", () => {
    const marker = (included: number) => ({
      slice: HOLDS_EVENTS_SLICE,
      spend: 0,
      included,
      unusable: 0,
    });

    expect(cohortHoldsCostEvents([marker(1)])).toBe(true);
    expect(cohortHoldsCostEvents([marker(0)])).toBe(false);
    expect(
      cohortHoldsCostEvents([{ slice: 0, spend: 1, included: 5, unusable: 0 }])
    ).toBe(false);
  });
});
