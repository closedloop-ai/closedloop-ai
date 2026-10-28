import {
  CHART_COLOR_PAIR_TOKEN_INDEXES,
  CHART_COLOR_TOKENS,
  CHART_OTHER_SERIES_COLOR,
  CHART_SERIES_COLOR_LIMIT,
  CHART_SERIES_TOKEN_INDEXES,
  chartColor,
  chartColorPair,
  chartColorPairForTokenIndex,
  chartSeriesColor,
} from "@closedloop-ai/design-system/components/ui/chart-colors";
import {
  CHART_OTHER_SERIES_KEY,
  chartOtherSeriesLabel,
  type FoldablePointDatum,
  foldTimeSeriesToMaxSeries,
} from "@closedloop-ai/design-system/components/ui/chart-series-fold";
import { describe, expect, it } from "vitest";

/**
 * ISS-7349. These two modules are the reason a stacked chart's legend can be
 * resolved against its bands at all: the palette decides which colour a series
 * gets, and the fold decides which series exist. Both carry contracts that a
 * story cannot reach because a story draws one chart with one series count.
 *
 * The palette's contract is that `chartSeriesColor` NEVER wraps — silently
 * restarting the sequence is what made two unrelated series render identically
 * in the first place. The fold's is that a sum is ALL-OR-NOTHING: the aggregate
 * band may only state a number when it can account for every folded key in the
 * bucket, or it fabricates a plausible subtotal that reads as complete.
 */

describe("chartColor", () => {
  it("returns the token at the given slot", () => {
    expect(chartColor(0)).toBe(CHART_COLOR_TOKENS[0]);
    expect(chartColor(3)).toBe(CHART_COLOR_TOKENS[3]);
  });

  it("wraps past the end of the palette", () => {
    expect(chartColor(CHART_COLOR_TOKENS.length)).toBe(CHART_COLOR_TOKENS[0]);
  });

  it("wraps a negative index into range rather than reading out of bounds", () => {
    // A bare `%` yields a negative remainder and an undefined lookup; the true
    // modulo is what stops that.
    expect(chartColor(-1)).toBe(CHART_COLOR_TOKENS.at(-1));
  });

  it("truncates a fractional index", () => {
    expect(chartColor(2.9)).toBe(CHART_COLOR_TOKENS[2]);
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("falls back to the first token for %s", (_label, index) => {
    expect(chartColor(index)).toBe(CHART_COLOR_TOKENS[0]);
  });
});

describe("chartColorPair", () => {
  it("opens on the second palette token", () => {
    expect(chartColorPair(0).base).toBe(chartColor(1));
  });

  it("wraps around the pair order", () => {
    const count = CHART_COLOR_PAIR_TOKEN_INDEXES.length;

    expect(chartColorPair(count)).toEqual(chartColorPair(0));
  });

  it("wraps a negative index into range", () => {
    expect(chartColorPair(-1)).toEqual(
      chartColorPair(CHART_COLOR_PAIR_TOKEN_INDEXES.length - 1)
    );
  });

  it("falls back to the first pair for a non-finite index", () => {
    expect(chartColorPair(Number.NaN)).toEqual(
      chartColorPairForTokenIndex(CHART_COLOR_PAIR_TOKEN_INDEXES[0])
    );
  });

  it("derives soft and strong companions from the base token", () => {
    const pair = chartColorPairForTokenIndex(0);

    expect(pair.base).toBe(CHART_COLOR_TOKENS[0]);
    expect(pair.soft).toContain(CHART_COLOR_TOKENS[0]);
    expect(pair.soft).toContain("var(--background)");
    expect(pair.strong).toContain("var(--foreground)");
  });

  it("leaves the final chart token available as a reserved fallback", () => {
    // Documented invariant of the pair order — nine pairs over ten tokens. The
    // count alone does not say WHICH token is held back: swapping the final
    // token in for any other keeps the length at nine. Name the reserved index.
    const reservedIndex = CHART_COLOR_TOKENS.length - 1;

    expect(CHART_COLOR_PAIR_TOKEN_INDEXES).toHaveLength(reservedIndex);
    expect(CHART_COLOR_PAIR_TOKEN_INDEXES).not.toContain(reservedIndex);
  });
});

describe("chartSeriesColor", () => {
  it("assigns slots from the distinguishable-adjacent order", () => {
    expect(chartSeriesColor(0)).toBe(chartColor(CHART_SERIES_TOKEN_INDEXES[0]));
  });

  it("covers the whole palette without repeating a colour", () => {
    // The palette's size claim: every slot below the limit is a distinct hue.
    const assigned = Array.from(
      { length: CHART_SERIES_COLOR_LIMIT },
      (_unused, index) => chartSeriesColor(index)
    );

    expect(new Set(assigned).size).toBe(CHART_SERIES_COLOR_LIMIT);
    expect(assigned).not.toContain(CHART_OTHER_SERIES_COLOR);
  });

  it("returns the neutral overflow colour past the last slot instead of wrapping", () => {
    // Wrapping is exactly the defect the order exists to fix — two unrelated
    // series rendering identically.
    expect(chartSeriesColor(CHART_SERIES_COLOR_LIMIT)).toBe(
      CHART_OTHER_SERIES_COLOR
    );
  });

  it("returns the neutral overflow colour for a negative slot", () => {
    expect(chartSeriesColor(-1)).toBe(CHART_OTHER_SERIES_COLOR);
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("returns the neutral overflow colour for %s", (_label, index) => {
    expect(chartSeriesColor(index)).toBe(CHART_OTHER_SERIES_COLOR);
  });
});

describe("chartOtherSeriesLabel", () => {
  it("carries the count of what it hides", () => {
    expect(chartOtherSeriesLabel(7)).toBe("Other (7)");
  });

  it("takes the aggregate noun from the caller", () => {
    // The chart cannot know a series is a "model" — that word belongs to the
    // surface that owns the data.
    expect(chartOtherSeriesLabel(7, "Other models")).toBe("Other models (7)");
  });
});

/**
 * The fold returns a union of the caller's point type and the generic
 * `FoldablePointDatum`, so the aggregate key is only indexable through the
 * generic half. Narrowing here keeps the assertions honest without an `as`.
 */
function aggregateValue(
  point: FoldablePointDatum | undefined,
  key: string
): number | null | undefined {
  return point?.values[key];
}

describe("foldTimeSeriesToMaxSeries", () => {
  const SERIES = [
    { key: "a", label: "A" },
    { key: "b", label: "B" },
    { key: "c", label: "C" },
  ];
  const POINTS = [
    { date: "2026-08-01", values: { a: 10, b: 5, c: 1 } },
    { date: "2026-08-02", values: { a: 10, b: 5, c: 1 } },
  ];

  it.each([
    ["no cap", undefined],
    ["a zero cap", 0],
    ["a negative cap", -1],
    ["NaN", Number.NaN],
  ])("returns the population untouched for %s", (_label, maxSeries) => {
    const result = foldTimeSeriesToMaxSeries({
      maxSeries,
      points: POINTS,
      series: SERIES,
    });

    expect(result.foldedCount).toBe(0);
    expect(result.aggregateKey).toBeUndefined();
    expect(result.series).toEqual(SERIES);
  });

  it("returns the population untouched when it already fits the cap", () => {
    const result = foldTimeSeriesToMaxSeries({
      maxSeries: 3,
      points: POINTS,
      series: SERIES,
    });

    expect(result.foldedCount).toBe(0);
    expect(result.series).toHaveLength(3);
  });

  it("keeps the highest-magnitude series and folds the rest", () => {
    const result = foldTimeSeriesToMaxSeries({
      maxSeries: 2,
      points: POINTS,
      series: SERIES,
    });

    expect(result.foldedCount).toBe(1);
    expect(result.series.map((entry) => entry.key)).toEqual([
      CHART_OTHER_SERIES_KEY,
      "a",
      "b",
    ]);
  });

  it("leads with the aggregate so it stacks at the bottom", () => {
    // A heavy folded tail on TOP would cap the silhouette the eye reads with the
    // one band that has no identity.
    const result = foldTimeSeriesToMaxSeries({
      maxSeries: 1,
      points: POINTS,
      series: SERIES,
    });

    expect(result.series[0]?.key).toBe(CHART_OTHER_SERIES_KEY);
    expect(result.series[0]?.label).toBe("Other (2)");
  });

  it("ranks on absolute magnitude so a swinging series is not cancelled out", () => {
    const swinging = [
      { date: "d1", values: { steady: 1, swing: 100 } },
      { date: "d2", values: { steady: 1, swing: -100 } },
    ];

    const result = foldTimeSeriesToMaxSeries({
      maxSeries: 1,
      points: swinging,
      series: [
        { key: "steady", label: "Steady" },
        { key: "swing", label: "Swing" },
      ],
    });

    expect(result.series.map((entry) => entry.key)).toContain("swing");
  });

  it("breaks a magnitude tie on the caller's original order", () => {
    const tied = [{ date: "d1", values: { first: 5, second: 5 } }];

    const result = foldTimeSeriesToMaxSeries({
      maxSeries: 1,
      points: tied,
      series: [
        { key: "first", label: "First" },
        { key: "second", label: "Second" },
      ],
    });

    expect(result.series.map((entry) => entry.key)).toContain("first");
  });

  it("emits kept series in the caller's original order, not ranked order", () => {
    // Palette assignment is positional, so re-sorting by magnitude would repaint
    // every surviving series whenever the ranking shifted.
    const result = foldTimeSeriesToMaxSeries({
      maxSeries: 2,
      points: [{ date: "d1", values: { high: 100, low: 1, mid: 50 } }],
      series: [
        { key: "low", label: "Low" },
        { key: "mid", label: "Mid" },
        { key: "high", label: "High" },
      ],
    });

    expect(result.series.map((entry) => entry.key)).toEqual([
      CHART_OTHER_SERIES_KEY,
      "mid",
      "high",
    ]);
  });

  it("picks a free aggregate key when the caller already owns the reserved one", () => {
    // A collision would overwrite a real series' values with the aggregate sum
    // and hand two bands one legend identity.
    const result = foldTimeSeriesToMaxSeries({
      maxSeries: 1,
      points: [
        { date: "d1", values: { [CHART_OTHER_SERIES_KEY]: 5, real: 9 } },
      ],
      series: [
        { key: CHART_OTHER_SERIES_KEY, label: "Collides" },
        { key: "real", label: "Real" },
      ],
    });

    expect(result.aggregateKey).toBe(`${CHART_OTHER_SERIES_KEY}2`);
  });

  it("sums the folded keys for a fully-known bucket", () => {
    const result = foldTimeSeriesToMaxSeries({
      maxSeries: 1,
      points: [{ date: "d1", values: { a: 10, b: 5, c: 1 } }],
      series: SERIES,
    });

    expect(aggregateValue(result.points[0], CHART_OTHER_SERIES_KEY)).toBe(6);
  });

  it("treats an absent key as a known zero", () => {
    // Documented: an absent key is a statement about the dataset's shape, not a
    // failed measurement.
    const result = foldTimeSeriesToMaxSeries({
      maxSeries: 1,
      points: [{ date: "d1", values: { a: 10, b: 5 } }],
      series: SERIES,
    });

    expect(aggregateValue(result.points[0], CHART_OTHER_SERIES_KEY)).toBe(5);
  });

  it.each([
    ["an explicit null", null],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])(
    "makes the bucket a gap when a folded contribution is %s",
    (_label, bad) => {
      // A sum is all-or-nothing. A subtotal here would be read as the total of all
      // N folded series and would look complete.
      const result = foldTimeSeriesToMaxSeries({
        maxSeries: 1,
        points: [{ date: "d1", values: { a: 10, b: bad, c: 1 } }],
        series: SERIES,
      });

      expect(
        aggregateValue(result.points[0], CHART_OTHER_SERIES_KEY)
      ).toBeNull();
    }
  );

  it("skips a non-finite value for RANKING rather than poisoning the total", () => {
    // +Infinity must not pin a series at the top of the ranking and evict a real
    // series on the strength of one malformed point.
    const result = foldTimeSeriesToMaxSeries({
      maxSeries: 1,
      points: [
        { date: "d1", values: { real: 100, spike: Number.POSITIVE_INFINITY } },
        { date: "d2", values: { real: 100, spike: 1 } },
      ],
      series: [
        { key: "real", label: "Real" },
        { key: "spike", label: "Spike" },
      ],
    });

    expect(result.series.map((entry) => entry.key)).toContain("real");
  });

  it("truncates a fractional cap rather than rejecting it", () => {
    const result = foldTimeSeriesToMaxSeries({
      maxSeries: 2.9,
      points: POINTS,
      series: SERIES,
    });

    expect(result.foldedCount).toBe(1);
  });
});
