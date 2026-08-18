import {
  CHART_OTHER_SERIES_KEY,
  chartOtherSeriesLabel,
  type FoldablePointDatum,
  type FoldableSeriesDef,
  foldTimeSeriesToMaxSeries,
} from "@repo/design-system/components/ui/chart-series-fold";
import { describe, expect, it } from "vitest";

// ISS-5523 — the fold kernel behind the chart's series cap. The rendered-chart
// suite (`time-series-area-chart-series-cap.test.tsx`) proves the cap reaches the
// DOM; this proves the arithmetic and the selection underneath it, which that
// suite only exercises on one all-positive, strictly-descending dataset.
//
// `@repo/design-system` has no test runner of its own, so its unit coverage
// lives with the consuming package, beside the sibling chart suites.

function seriesOf(keys: readonly string[]): FoldableSeriesDef[] {
  return keys.map((key) => ({ key, label: key }));
}

function pointOf(
  date: string,
  values: Record<string, number | null>
): FoldablePointDatum {
  return { date, values };
}

describe("foldTimeSeriesToMaxSeries cap resolution", () => {
  const series = seriesOf(["a", "b", "c"]);
  const points = [pointOf("2026-07-01", { a: 3, b: 2, c: 1 })];

  it.each([
    ["absent", undefined],
    ["zero", 0],
    ["negative", -5],
    ["fractional below one", 0.5],
    ["not a number", Number.NaN],
  ])("treats a %s cap as no cap at all", (_label, maxSeries) => {
    const folded = foldTimeSeriesToMaxSeries({ maxSeries, points, series });

    expect(folded.foldedCount).toBe(0);
    expect(folded.series).toHaveLength(series.length);
  });

  it("truncates a fractional cap rather than folding on a partial series", () => {
    const wider = seriesOf(["a", "b", "c", "d"]);
    const widerPoints = [pointOf("2026-07-01", { a: 4, b: 3, c: 2, d: 1 })];

    const folded = foldTimeSeriesToMaxSeries({
      maxSeries: 2.9,
      points: widerPoints,
      series: wider,
    });

    // 2.9 means two whole series plus the aggregate — never "2.9 series".
    expect(folded.foldedCount).toBe(2);
    expect(folded.series).toHaveLength(3);
  });

  it("folds a single overflow series rather than drawing one series past the cap", () => {
    // This previously asserted the OPPOSITE — that 3 series at a cap of 2 draw
    // all three, on the reasoning that folding one series costs it its identity
    // while the palette "provably had a free slot for it" (wongk review).
    //
    // The palette provably did NOT. The chart clamps the cap to
    // `CHART_SERIES_COLOR_LIMIT`, and the product passes exactly that limit, so
    // at the cap the free slot does not exist: `cap + 1` series numbered slots
    // `0..cap`, and slot `cap` is `chartSeriesColor`'s overflow branch — the
    // reserved aggregate neutral. A named model wore the one colour that means
    // "these could not be told apart individually".
    //
    // The cap is now honoured literally, so the highest slot ever requested is
    // `cap - 1` and that branch is unreachable from here.
    const folded = foldTimeSeriesToMaxSeries({ maxSeries: 2, points, series });

    expect(folded.foldedCount).toBe(1);
    expect(folded.aggregateKey).toBe(CHART_OTHER_SERIES_KEY);
    // Aggregate leads (it stacks on the baseline); the two largest keep names.
    expect(folded.series.map((entry) => entry.key)).toEqual([
      CHART_OTHER_SERIES_KEY,
      "a",
      "b",
    ]);
    expect(folded.series[0].label).toBe("Other (1)");
  });

  it("never asks for a palette slot at or beyond the cap, at any population size", () => {
    // The invariant the off-by-one broke, stated directly and swept across the
    // boundary rather than probed at one size. `kept` is what the chart numbers
    // 0..kept-1, so `kept > cap` is precisely the condition that reaches
    // `chartSeriesColor(cap)` — the overflow branch.
    const cap = 4;
    for (let population = 1; population <= 12; population += 1) {
      const keys = Array.from({ length: population }, (_u, i) => `s${i}`);
      const folded = foldTimeSeriesToMaxSeries({
        maxSeries: cap,
        points: [
          pointOf(
            "2026-07-01",
            Object.fromEntries(keys.map((k, i) => [k, population - i]))
          ),
        ],
        series: seriesOf(keys),
      });

      const kept = folded.series.filter(
        (entry) => entry.key !== folded.aggregateKey
      ).length;
      expect(kept).toBeLessThanOrEqual(cap);
      // Every source series is accounted for: drawn by name, or counted in the
      // band. Folding must never silently drop one.
      expect(kept + folded.foldedCount).toBe(population);
    }
  });

  it("leaves a population equal to the cap untouched", () => {
    const folded = foldTimeSeriesToMaxSeries({ maxSeries: 3, points, series });

    expect(folded.foldedCount).toBe(0);
    expect(folded.series.map((entry) => entry.key)).toEqual(["a", "b", "c"]);
    // No aggregate key injected into the buckets when nothing folded.
    expect(folded.points[0].values).not.toHaveProperty(CHART_OTHER_SERIES_KEY);
  });
});

describe("foldTimeSeriesToMaxSeries aggregate arithmetic", () => {
  it("keeps the stacked total identical to the uncapped total, bucket by bucket", () => {
    // The stack's height is the metric a reader trusts. Folding regroups which
    // band carries a value; it must never change how much there is.
    //
    // SCOPE, so this is not mistaken for an unconditional invariant: it holds
    // for FULLY KNOWN buckets, which is what this fixture is. Once any folded
    // value is unknown (explicit `null`, `NaN`, `±Infinity`) the aggregate
    // reports the bucket as a gap rather than a partial sum, and the drawn total
    // deliberately drops — see the unknown-propagation tests below. Preserving
    // the total THERE would mean plotting a number nobody measured, which is the
    // defect those tests exist to prevent, not a regression in this one.
    const series = seriesOf(["a", "b", "c", "d", "e"]);
    const points = [
      pointOf("2026-07-01", { a: 50, b: 40, c: 30, d: 20, e: 10 }),
      pointOf("2026-07-02", { a: 5, b: 4, c: 3, d: 2, e: 1 }),
    ];

    const folded = foldTimeSeriesToMaxSeries({ maxSeries: 2, points, series });

    for (const [index, point] of folded.points.entries()) {
      const uncappedTotal = series.reduce(
        (sum, entry) => sum + (points[index].values[entry.key] ?? 0),
        0
      );
      const foldedTotal = folded.series.reduce(
        (sum, entry) => sum + (point.values[entry.key] ?? 0),
        0
      );
      expect(foldedTotal).toBe(uncappedTotal);
    }
  });

  it("sums only the folded keys into the aggregate band", () => {
    const series = seriesOf(["a", "b", "c", "d"]);
    const points = [pointOf("2026-07-01", { a: 100, b: 50, c: 7, d: 3 })];

    const folded = foldTimeSeriesToMaxSeries({ maxSeries: 2, points, series });

    expect(folded.points[0].values[CHART_OTHER_SERIES_KEY]).toBe(10);
  });

  it("reports the aggregate as unmeasured when every folded series is a gap", () => {
    // A day on which none of the folded models reported anything is not a day
    // they cost nothing. Plotting 0 would state a measurement never taken; the
    // band must carry the chart's own gap value instead.
    const series = seriesOf(["a", "b", "c"]);
    const points = [pointOf("2026-07-01", { a: 100, b: null, c: null })];

    const folded = foldTimeSeriesToMaxSeries({ maxSeries: 1, points, series });

    expect(folded.points[0].values[CHART_OTHER_SERIES_KEY]).toBeNull();
  });

  it("keeps a missing key as 0, matching the chart's documented default", () => {
    // Absent is not the same signal as null: the chart reads a missing key as 0
    // everywhere else, so the aggregate must not invent a gap for it.
    const series = seriesOf(["a", "b", "c"]);
    const points = [pointOf("2026-07-01", { a: 100 })];

    const folded = foldTimeSeriesToMaxSeries({ maxSeries: 1, points, series });

    expect(folded.points[0].values[CHART_OTHER_SERIES_KEY]).toBe(0);
  });

  it("reports a PARTIALLY unknown bucket as unknown, not as the subtotal it can see", () => {
    // This previously asserted `4` — the sum of the folded values that happened
    // to be present (codex P2 + wongk review). That is the defect: before the
    // fold, `b`'s gap was its own visible series and a reader could see exactly
    // what was missing. After it, the band says "Other models (2)" and plots a
    // number, which is read as the total of BOTH. Emitting 4 states a complete
    // figure that was never measured.
    //
    // A sum is all-or-nothing: one unknown contribution makes the total unknown,
    // and the honest rendering is the gap the chart already draws for `null`.
    const series = seriesOf(["a", "b", "c"]);
    const points = [pointOf("2026-07-01", { a: 100, b: null, c: 4 })];

    const folded = foldTimeSeriesToMaxSeries({ maxSeries: 1, points, series });

    expect(folded.points[0].values[CHART_OTHER_SERIES_KEY]).toBeNull();
  });

  it.each([
    ["NaN", Number.NaN],
    ["+Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])("reports a bucket as unknown when a folded value is %s, instead of dropping it", (_label, malformed) => {
    // A present-but-malformed value used to be discarded, letting the one valid
    // sibling carry the band as a confident subtotal (codex P2). It is not a
    // measurement of zero and it is not absence — it is a value we cannot add.
    const series = seriesOf(["a", "b", "c"]);
    const points = [pointOf("2026-07-01", { a: 100, b: malformed, c: 4 })];

    const folded = foldTimeSeriesToMaxSeries({ maxSeries: 1, points, series });

    expect(folded.points[0].values[CHART_OTHER_SERIES_KEY]).toBeNull();
  });

  it("does not fabricate 0 for a bucket whose folded values are all malformed", () => {
    // The sharpest form of the same defect (wongk review): with every folded
    // value non-finite, the old code saw no number and no explicit `null`, fell
    // through to the "every key simply absent" branch, and plotted a confident
    // `0` — a measurement of "these models cost nothing" invented out of
    // malformed input.
    const series = seriesOf(["a", "b", "c"]);
    const points = [
      pointOf("2026-07-01", {
        a: 100,
        b: Number.NaN,
        c: Number.POSITIVE_INFINITY,
      }),
    ];

    const folded = foldTimeSeriesToMaxSeries({ maxSeries: 1, points, series });

    const value = folded.points[0].values[CHART_OTHER_SERIES_KEY];
    expect(value).toBeNull();
    expect(value).not.toBe(0);
  });

  it("still sums a fully-known bucket, including keys that are merely absent", () => {
    // The other side of the rule: unknown propagates, but absence does not. A
    // key the dataset never mentions is a documented 0, so a bucket made only of
    // numbers and absences is fully known and must still produce a number —
    // otherwise "be honest about unknowns" would blank most real charts.
    const series = seriesOf(["a", "b", "c", "d"]);
    const points = [pointOf("2026-07-01", { a: 100, b: 5, c: 4 })];

    const folded = foldTimeSeriesToMaxSeries({ maxSeries: 1, points, series });

    // b + c + (d absent -> 0)
    expect(folded.points[0].values[CHART_OTHER_SERIES_KEY]).toBe(9);
  });
});

describe("foldTimeSeriesToMaxSeries selection", () => {
  it("ranks on absolute magnitude so a negative-swinging series is not folded as if empty", () => {
    // `b` nets to zero but moved more than `c` ever did. Ranking on the raw sum
    // would drop the busiest series and keep the quietest.
    const series = seriesOf(["a", "b", "c", "d"]);
    const points = [
      pointOf("2026-07-01", { a: 100, b: 80, c: 5, d: 4 }),
      pointOf("2026-07-02", { a: 100, b: -80, c: 5, d: 4 }),
    ];

    const folded = foldTimeSeriesToMaxSeries({ maxSeries: 2, points, series });

    // Aggregate leads, so it stacks on the baseline rather than capping the
    // silhouette; `a` and `b` keep their identities.
    expect(folded.series.map((entry) => entry.key)).toEqual([
      CHART_OTHER_SERIES_KEY,
      "a",
      "b",
    ]);
  });

  it("breaks ties on the caller's original order, so the same data folds the same way", () => {
    const series = seriesOf(["a", "b", "c", "d"]);
    const points = [pointOf("2026-07-01", { a: 10, b: 10, c: 10, d: 10 })];

    const folded = foldTimeSeriesToMaxSeries({ maxSeries: 2, points, series });

    expect(folded.series.map((entry) => entry.key)).toEqual([
      CHART_OTHER_SERIES_KEY,
      "a",
      "b",
    ]);
  });

  it("keeps the reserved aggregate key clear of a caller that already owns it", () => {
    // A collision would overwrite a real series' values with the aggregate sum
    // and hand two bands one legend identity.
    const series = seriesOf([CHART_OTHER_SERIES_KEY, "b", "c", "d"]);
    const points = [
      pointOf("2026-07-01", {
        [CHART_OTHER_SERIES_KEY]: 100,
        b: 50,
        c: 2,
        d: 1,
      }),
    ];

    const folded = foldTimeSeriesToMaxSeries({ maxSeries: 2, points, series });

    expect(folded.aggregateKey).not.toBe(CHART_OTHER_SERIES_KEY);
    // The caller's own series keeps its value untouched.
    expect(folded.points[0].values[CHART_OTHER_SERIES_KEY]).toBe(100);
    expect(folded.points[0].values[folded.aggregateKey as string]).toBe(3);
  });

  it("emits kept series in the caller's original order, not ranked order", () => {
    // Palette assignment is positional, so ranked output would repaint every
    // surviving series whenever the ranking moved.
    const series = seriesOf(["small", "big"]);
    const points = [pointOf("2026-07-01", { small: 1, big: 100 })];

    const folded = foldTimeSeriesToMaxSeries({ maxSeries: 2, points, series });

    expect(folded.series.map((entry) => entry.key)).toEqual(["small", "big"]);
    expect(folded.foldedCount).toBe(0);
  });
});

describe("chartOtherSeriesLabel", () => {
  it("always states how many series the band stands for", () => {
    expect(chartOtherSeriesLabel(7, "Other models")).toBe("Other models (7)");
  });

  it("falls back to a generic noun when the caller has none to give", () => {
    expect(chartOtherSeriesLabel(3)).toBe("Other (3)");
  });
});
