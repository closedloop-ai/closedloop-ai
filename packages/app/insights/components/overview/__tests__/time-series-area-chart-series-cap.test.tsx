import {
  CHART_COLOR_TOKENS,
  CHART_OTHER_SERIES_COLOR,
  CHART_SERIES_COLOR_LIMIT,
  CHART_SERIES_TOKEN_INDEXES,
  chartSeriesColor,
} from "@repo/design-system/components/ui/chart-colors";
import type {
  TimeSeriesPointDatum,
  TimeSeriesSeriesDef,
} from "@repo/design-system/components/ui/time-series-area-chart";
import { TimeSeriesAreaChart } from "@repo/design-system/components/ui/time-series-area-chart";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

// ISS-5523: the agent-detail "Usage over time" chart drew 17 model series
// through a 10-color categorical palette, so `chartColor`'s modulo wrapped and
// unrelated models rendered in the SAME fill — colour was the only thing
// distinguishing series, so the legend could not resolve which band was which.
//
// These assert at the population size that actually collides (17). A pass at
// five series would prove nothing: five never reaches the wrap.
//
// JSDOM cannot lay out Recharts (0x0 ResponsiveContainer), but Recharts still
// emits one `.recharts-area` per drawn <Area> carrying the fill we bound, so the
// rendered fills are readable from the DOM without a real paint.

const COLLIDING_SERIES_COUNT = 17;

// Anchored at the start so they match the aggregate band's own name and never a
// series that merely contains the word.
const AGGREGATE_BAND_PATTERN = /^Other models \(/;
const ANY_AGGREGATE_BAND_PATTERN = /^Other/;

const series: TimeSeriesSeriesDef[] = Array.from(
  { length: COLLIDING_SERIES_COUNT },
  (_unused, index) => ({ key: `model-${index}`, label: `model-${index}` })
);

// Descending values, so the fold's magnitude ranking is unambiguous: model-0 is
// the largest and model-16 the smallest, and the tail that folds is exactly the
// series past the cap.
const points: TimeSeriesPointDatum[] = [
  {
    date: "2026-07-01",
    values: Object.fromEntries(
      series.map((entry, index) => [
        entry.key,
        (COLLIDING_SERIES_COUNT - index) * 100,
      ])
    ),
  },
  {
    date: "2026-07-02",
    values: Object.fromEntries(
      series.map((entry, index) => [
        entry.key,
        (COLLIDING_SERIES_COUNT - index) * 50,
      ])
    ),
  },
];

function renderedFills(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll(".recharts-area")).map(
    (area) => area.querySelector("path")?.getAttribute("fill") ?? ""
  );
}

describe("TimeSeriesAreaChart series cap (ISS-5523)", () => {
  it("draws no two series in the same fill at the count that collides today", () => {
    const { container } = render(
      <TimeSeriesAreaChart
        maxSeries={CHART_SERIES_COLOR_LIMIT}
        otherSeriesLabel="Other models"
        points={points}
        series={series}
      />
    );

    const fills = renderedFills(container).filter(Boolean);
    expect(fills.length).toBeGreaterThan(0);
    expect(new Set(fills).size).toBe(fills.length);
  });

  it("names the aggregate band with how many series it stands for", () => {
    render(
      <TimeSeriesAreaChart
        maxSeries={CHART_SERIES_COLOR_LIMIT}
        otherSeriesLabel="Other models"
        points={points}
        series={series}
      />
    );

    // 17 series, 10 keep their own colour, so the band holds the other 7 — and
    // says so, rather than presenting itself as one more model.
    expect(
      screen.getByRole("button", { name: "Other models (7)" })
    ).toBeInTheDocument();
  });

  it("keeps the highest-magnitude series and folds only the tail", () => {
    render(
      <TimeSeriesAreaChart
        maxSeries={CHART_SERIES_COLOR_LIMIT}
        otherSeriesLabel="Other models"
        points={points}
        series={series}
      />
    );

    // Largest survives with its own identity; smallest is inside the aggregate.
    expect(screen.getByRole("button", { name: "model-0" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "model-16" })
    ).not.toBeInTheDocument();
  });

  it("leaves a population that already fits completely untouched", () => {
    const fitting = series.slice(0, CHART_SERIES_COLOR_LIMIT);
    render(
      <TimeSeriesAreaChart
        maxSeries={CHART_SERIES_COLOR_LIMIT}
        otherSeriesLabel="Other models"
        points={points}
        series={fitting}
      />
    );

    for (const entry of fitting) {
      expect(
        screen.getByRole("button", { name: entry.label })
      ).toBeInTheDocument();
    }
    // No aggregate band invented for a population that never overflowed.
    expect(screen.queryByText(AGGREGATE_BAND_PATTERN)).not.toBeInTheDocument();
  });

  it("still draws every series, palette wrap and all, while the gate is closed", () => {
    // The flag-off path is the pre-ISS-5523 behavior and must be preserved
    // exactly: no cap, no aggregate band, one Area per source series.
    const { container } = render(
      <TimeSeriesAreaChart points={points} series={series} />
    );

    expect(renderedFills(container)).toHaveLength(COLLIDING_SERIES_COUNT);
    expect(
      screen.queryByText(ANY_AGGREGATE_BAND_PATTERN)
    ).not.toBeInTheDocument();
  });
});

describe("series cap collision guards (ISS-5523 review)", () => {
  it("never paints a real series the aggregate band's neutral, whatever cap is asked for", () => {
    // A cap above the palette's size would push every overflow series past the
    // last slot and onto the neutral — several bands sharing one fill, the
    // exact defect the cap exists to remove. The chart clamps instead.
    const { container } = render(
      <TimeSeriesAreaChart
        maxSeries={CHART_SERIES_COLOR_LIMIT + 5}
        otherSeriesLabel="Other models"
        points={points}
        series={series}
      />
    );

    const fills = renderedFills(container).filter(Boolean);
    expect(new Set(fills).size).toBe(fills.length);
  });

  it("keeps a colorOffset from pushing the last series onto the aggregate's colour", () => {
    // `colorOffset` shifts the uncapped sequence's start. Applied to the capped
    // sequence — which cannot wrap — it would run the tail off the end.
    const { container } = render(
      <TimeSeriesAreaChart
        colorOffset={1}
        maxSeries={CHART_SERIES_COLOR_LIMIT}
        otherSeriesLabel="Other models"
        points={points}
        series={series}
      />
    );

    const fills = renderedFills(container).filter(Boolean);
    expect(new Set(fills).size).toBe(fills.length);
  });
});

describe("series cap boundary at exactly one series past the cap (wongk review)", () => {
  // The population the fold threshold got wrong, and the one size none of the
  // suites above touch: they test 17 (well over) and 10 (exactly at). At
  // CAP + 1 the old `series.length <= cap + 1` guard skipped the fold, numbered
  // slots 0..10, and handed the eleventh `chartSeriesColor(10)` — the overflow
  // branch, which returns the RESERVED aggregate neutral.
  //
  // Read this carefully, because it is why the obvious assertion is worthless
  // here: with 11 series and no fold there is no aggregate band, so the neutral
  // is worn exactly once and `new Set(fills).size === fills.length` PASSES on
  // the broken code. Distinctness cannot detect this defect at this size. What
  // is actually wrong is that a NAMED MODEL wears the colour reserved for "these
  // could not be told apart" — so that is what these assert.
  const BOUNDARY_COUNT = CHART_SERIES_COLOR_LIMIT + 1;
  const boundarySeries = series.slice(0, BOUNDARY_COUNT);

  function renderBoundary() {
    return render(
      <TimeSeriesAreaChart
        maxSeries={CHART_SERIES_COLOR_LIMIT}
        otherSeriesLabel="Other models"
        points={points}
        series={boundarySeries}
      />
    );
  }

  it("folds the overflow series instead of drawing one past the last palette slot", () => {
    renderBoundary();

    // One series over the cap folds into a band that says so.
    expect(
      screen.getByRole("button", { name: "Other models (1)" })
    ).toBeInTheDocument();
    // The smallest series is what folded; the largest kept its identity.
    expect(screen.getByRole("button", { name: "model-0" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: `model-${BOUNDARY_COUNT - 1}` })
    ).not.toBeInTheDocument();
  });

  it("lets only the aggregate band wear the reserved neutral", () => {
    const { container } = renderBoundary();

    const fills = renderedFills(container).filter(Boolean);
    const neutralCount = fills.filter(
      (fill) => fill === CHART_OTHER_SERIES_COLOR
    ).length;

    // Exactly one band is neutral, and it is the aggregate — not a real model
    // that ran off the end of the palette. Tying the count to the presence of
    // the aggregate legend entry is what makes this fail on the old threshold,
    // where the neutral was also worn once but by `model-10`.
    expect(neutralCount).toBe(1);
    expect(
      screen.getByRole("button", { name: "Other models (1)" })
    ).toBeInTheDocument();
    // Every drawn band still has its own fill.
    expect(new Set(fills).size).toBe(fills.length);
  });

  it("never lets a real series reach the palette's overflow colour, across the boundary", () => {
    // Swept rather than probed at one size: the defect was an off-by-one, so the
    // neighbourhood is the interesting part. At every population, the number of
    // neutral bands must equal the number of aggregate bands (0 or 1) — never
    // more, which is what "a real series wearing the neutral" looks like.
    for (const count of [
      CHART_SERIES_COLOR_LIMIT - 1,
      CHART_SERIES_COLOR_LIMIT,
      CHART_SERIES_COLOR_LIMIT + 1,
      CHART_SERIES_COLOR_LIMIT + 2,
    ]) {
      const { container, unmount } = render(
        <TimeSeriesAreaChart
          maxSeries={CHART_SERIES_COLOR_LIMIT}
          otherSeriesLabel="Other models"
          points={points}
          series={series.slice(0, count)}
        />
      );

      const fills = renderedFills(container).filter(Boolean);
      const neutralCount = fills.filter(
        (fill) => fill === CHART_OTHER_SERIES_COLOR
      ).length;
      const aggregateBands = screen.queryAllByRole("button", {
        name: AGGREGATE_BAND_PATTERN,
      }).length;

      expect(neutralCount).toBe(aggregateBands);
      expect(new Set(fills).size).toBe(fills.length);
      unmount();
    }
  });
});

describe("aggregate band under the interactive legend (FEA-4264 x ISS-5523)", () => {
  it("hides and restores the aggregate band like any other series", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <TimeSeriesAreaChart
        maxSeries={CHART_SERIES_COLOR_LIMIT}
        otherSeriesLabel="Other models"
        points={points}
        series={series}
      />
    );

    const band = screen.getByRole("button", { name: "Other models (7)" });
    const withBand = renderedFills(container).length;

    // The aggregate is a real, toggleable band — not a decoration pinned to the
    // stack. Hiding it must drop its area, or the legend would claim a control
    // the plot does not honour.
    await user.click(band);
    expect(renderedFills(container)).toHaveLength(withBand - 1);
    expect(band).toHaveAttribute("aria-pressed", "false");

    await user.click(band);
    expect(renderedFills(container)).toHaveLength(withBand);
  });
});

describe("chartSeriesColor (ISS-5523)", () => {
  it("gives every slot within the limit a distinct token", () => {
    const colors = Array.from({ length: CHART_SERIES_COLOR_LIMIT }, (_u, i) =>
      chartSeriesColor(i)
    );
    expect(new Set(colors).size).toBe(CHART_SERIES_COLOR_LIMIT);
  });

  it("seats every palette token exactly once", () => {
    // The order is a PERMUTATION, chosen so adjacent series clear the colour-
    // vision separation thresholds. A typo that repeated or dropped an index
    // would silently hand two series the same token again, or waste a slot —
    // both invisible without this.
    expect([...CHART_SERIES_TOKEN_INDEXES].sort((a, b) => a - b)).toEqual(
      CHART_COLOR_TOKENS.map((_unused, index) => index)
    );
  });

  it("does not wrap past the limit — the overflow colour is not slot 0's", () => {
    // Wrapping is the defect. Past the last slot the sequence must NOT restart,
    // because a restarted hue claims an identity the palette cannot back up.
    expect(chartSeriesColor(CHART_SERIES_COLOR_LIMIT)).not.toBe(
      chartSeriesColor(0)
    );
  });
});
