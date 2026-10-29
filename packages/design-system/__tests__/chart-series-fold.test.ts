import {
  CHART_OTHER_SERIES_KEY,
  CHART_OTHER_SERIES_LABEL,
  chartOtherSeriesLabel,
  type FoldablePointDatum,
  type FoldableSeriesDef,
  foldTimeSeriesToMaxSeries,
} from "@closedloop-ai/design-system/components/ui/chart-series-fold";
import { describe, expect, it } from "vitest";

const makeSeries = (...keys: string[]): FoldableSeriesDef[] =>
  keys.map((key) => ({ key, label: `Label ${key}` }));

const makePoint = (
  date: string,
  values: Record<string, number | null>
): FoldablePointDatum => ({
  date,
  values,
});

describe("foldTimeSeriesToMaxSeries", () => {
  const series = makeSeries("a", "b", "c", "d");
  const points = [
    makePoint("2026-01-01", { a: 10, b: 5, c: 3, d: 1 }),
    makePoint("2026-01-02", { a: 20, b: 10, c: 6, d: 2 }),
  ];

  it("returns unchanged inputs when maxSeries is undefined", () => {
    const result = foldTimeSeriesToMaxSeries({ series, points });
    expect(result.foldedCount).toBe(0);
    expect(result.aggregateKey).toBeUndefined();
    expect(result.series).toHaveLength(4);
  });

  it("returns unchanged inputs when population fits within cap", () => {
    const result = foldTimeSeriesToMaxSeries({
      series,
      points,
      maxSeries: 5,
    });
    expect(result.foldedCount).toBe(0);
  });

  it("returns unchanged inputs when maxSeries equals population", () => {
    const result = foldTimeSeriesToMaxSeries({
      series,
      points,
      maxSeries: 4,
    });
    expect(result.foldedCount).toBe(0);
  });

  it("folds lowest-magnitude series into aggregate when cap < population", () => {
    const result = foldTimeSeriesToMaxSeries({
      series,
      points,
      maxSeries: 2,
    });
    expect(result.foldedCount).toBe(2);
    expect(result.aggregateKey).toBe(CHART_OTHER_SERIES_KEY);
    // Kept: a (30 total) and b (15 total); folded: c (9) and d (3)
    const keptKeys = result.series
      .filter((s) => s.key !== result.aggregateKey)
      .map((s) => s.key);
    expect(keptKeys).toContain("a");
    expect(keptKeys).toContain("b");
  });

  it("aggregate band leads the series array", () => {
    const result = foldTimeSeriesToMaxSeries({
      series,
      points,
      maxSeries: 2,
    });
    expect(result.series[0].key).toBe(result.aggregateKey);
  });

  it("sums folded values in points", () => {
    const result = foldTimeSeriesToMaxSeries({
      series,
      points,
      maxSeries: 2,
    });
    const aggKey = result.aggregateKey!;
    // c + d: 3+1=4 for day 1, 6+2=8 for day 2
    expect(result.points[0].values[aggKey]).toBe(4);
    expect(result.points[1].values[aggKey]).toBe(8);
  });

  it("labels the aggregate band with count", () => {
    const result = foldTimeSeriesToMaxSeries({
      series,
      points,
      maxSeries: 2,
    });
    const aggSeries = result.series[0];
    expect(aggSeries.label).toBe(`${CHART_OTHER_SERIES_LABEL} (2)`);
  });

  it("uses custom otherSeriesLabel when provided", () => {
    const result = foldTimeSeriesToMaxSeries({
      series,
      points,
      maxSeries: 2,
      otherSeriesLabel: "models",
    });
    expect(result.series[0].label).toBe("models (2)");
  });

  it("preserves original series order for kept series", () => {
    // b has lower magnitude than a but comes second in the original order
    const result = foldTimeSeriesToMaxSeries({
      series,
      points,
      maxSeries: 3,
    });
    const keptKeys = result.series
      .filter((s) => s.key !== result.aggregateKey)
      .map((s) => s.key);
    expect(keptKeys).toEqual(["a", "b", "c"]);
  });

  it("treats non-finite maxSeries as no cap", () => {
    expect(
      foldTimeSeriesToMaxSeries({ series, points, maxSeries: Number.NaN })
        .foldedCount
    ).toBe(0);
    expect(
      foldTimeSeriesToMaxSeries({
        series,
        points,
        maxSeries: Number.POSITIVE_INFINITY,
      }).foldedCount
    ).toBe(0);
  });

  it("treats zero and negative maxSeries as no cap", () => {
    expect(
      foldTimeSeriesToMaxSeries({ series, points, maxSeries: 0 }).foldedCount
    ).toBe(0);
    expect(
      foldTimeSeriesToMaxSeries({ series, points, maxSeries: -1 }).foldedCount
    ).toBe(0);
  });

  it("truncates fractional maxSeries", () => {
    const result = foldTimeSeriesToMaxSeries({
      series,
      points,
      maxSeries: 2.9,
    });
    // Truncated to 2
    expect(result.foldedCount).toBe(2);
  });

  it("handles maxSeries of 1", () => {
    const result = foldTimeSeriesToMaxSeries({
      series,
      points,
      maxSeries: 1,
    });
    expect(result.foldedCount).toBe(3);
    const keptKeys = result.series
      .filter((s) => s.key !== result.aggregateKey)
      .map((s) => s.key);
    expect(keptKeys).toEqual(["a"]);
  });

  it("breaks ties by original order", () => {
    const tiedSeries = makeSeries("x", "y", "z");
    const tiedPoints = [makePoint("2026-01-01", { x: 10, y: 10, z: 10 })];
    const result = foldTimeSeriesToMaxSeries({
      series: tiedSeries,
      points: tiedPoints,
      maxSeries: 2,
    });
    const keptKeys = result.series
      .filter((s) => s.key !== result.aggregateKey)
      .map((s) => s.key);
    expect(keptKeys).toEqual(["x", "y"]);
  });

  it("uses absolute values for ranking so negative swings do not cancel out", () => {
    const swingSeries = makeSeries("pos", "neg");
    const swingPoints = [
      makePoint("2026-01-01", { pos: 5, neg: -20 }),
      makePoint("2026-01-02", { pos: 5, neg: 20 }),
    ];
    const result = foldTimeSeriesToMaxSeries({
      series: swingSeries,
      points: swingPoints,
      maxSeries: 1,
    });
    // neg has magnitude 40, pos has magnitude 10 — neg should be kept
    const keptKeys = result.series
      .filter((s) => s.key !== result.aggregateKey)
      .map((s) => s.key);
    expect(keptKeys).toEqual(["neg"]);
  });

  it("skips non-finite values in ranking", () => {
    const badSeries = makeSeries("good", "bad");
    const badPoints = [makePoint("2026-01-01", { good: 100, bad: Number.NaN })];
    const result = foldTimeSeriesToMaxSeries({
      series: badSeries,
      points: badPoints,
      maxSeries: 1,
    });
    const keptKeys = result.series
      .filter((s) => s.key !== result.aggregateKey)
      .map((s) => s.key);
    expect(keptKeys).toEqual(["good"]);
  });

  it("returns null aggregate value when any folded key has a null value", () => {
    const nullSeries = makeSeries("a", "b", "c");
    const nullPoints = [makePoint("2026-01-01", { a: 100, b: 5, c: null })];
    const result = foldTimeSeriesToMaxSeries({
      series: nullSeries,
      points: nullPoints,
      maxSeries: 1,
    });
    const aggKey = result.aggregateKey!;
    // b=5 is finite but c=null makes the total unknown
    expect(result.points[0].values[aggKey]).toBeNull();
  });

  it("returns null aggregate value when any folded key has NaN", () => {
    const nanSeries = makeSeries("a", "b", "c");
    const nanPoints = [
      makePoint("2026-01-01", { a: 100, b: 5, c: Number.NaN }),
    ];
    const result = foldTimeSeriesToMaxSeries({
      series: nanSeries,
      points: nanPoints,
      maxSeries: 1,
    });
    const aggKey = result.aggregateKey!;
    expect(result.points[0].values[aggKey]).toBeNull();
  });

  it("treats absent keys as known zero in the aggregate", () => {
    const absentSeries = makeSeries("a", "b", "c");
    const absentPoints = [
      // b is absent in this bucket — known zero, not unknown
      makePoint("2026-01-01", { a: 100, c: 3 }),
    ];
    const result = foldTimeSeriesToMaxSeries({
      series: absentSeries,
      points: absentPoints,
      maxSeries: 1,
    });
    const aggKey = result.aggregateKey!;
    // b absent (0) + c (3) = 3
    expect(result.points[0].values[aggKey]).toBe(3);
  });

  it("resolves a collision-free aggregate key when a series owns the reserved key", () => {
    const collisionSeries = [
      { key: CHART_OTHER_SERIES_KEY, label: "Collision" },
      ...makeSeries("a", "b"),
    ];
    const collisionPoints = [
      makePoint("2026-01-01", {
        [CHART_OTHER_SERIES_KEY]: 1,
        a: 10,
        b: 5,
      }),
    ];
    const result = foldTimeSeriesToMaxSeries({
      series: collisionSeries,
      points: collisionPoints,
      maxSeries: 2,
    });
    expect(result.aggregateKey).not.toBe(CHART_OTHER_SERIES_KEY);
    expect(result.aggregateKey?.startsWith("__chartOtherSeries")).toBe(true);
  });
});

describe("chartOtherSeriesLabel", () => {
  it("formats count with default noun", () => {
    expect(chartOtherSeriesLabel(5)).toBe("Other (5)");
  });

  it("uses custom noun", () => {
    expect(chartOtherSeriesLabel(3, "providers")).toBe("providers (3)");
  });
});
