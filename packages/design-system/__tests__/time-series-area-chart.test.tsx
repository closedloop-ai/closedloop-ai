import type {
  TimeSeriesMarker,
  TimeSeriesPointDatum,
  TimeSeriesSeriesDef,
} from "@closedloop-ai/design-system/components/ui/time-series-area-chart";
import { TimeSeriesAreaChart } from "@closedloop-ai/design-system/components/ui/time-series-area-chart";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Recharts does not compute laid-out SVG geometry under jsdom, but it does
 * render legend labels, axis ticks and reference lines — so the populated
 * cases assert the output each prop actually adds (the comparison label, a
 * marker's reference line and label, the folded "Other (n)" band) rather than
 * that the shell mounted. Every case here pairs the prop with its absence,
 * because the chart mounts identically either way and a mount-only assertion
 * stays green with the wiring deleted.
 */

afterEach(cleanup);

const SERIES: TimeSeriesSeriesDef[] = [{ key: "tokens", label: "Tokens" }];
const POINTS: TimeSeriesPointDatum[] = [
  { date: "2026-01-01", values: { tokens: 100 } },
  { date: "2026-01-02", values: { tokens: 200 } },
];

describe("TimeSeriesAreaChart — empty branch", () => {
  it("renders the default empty message for zero points", () => {
    render(<TimeSeriesAreaChart points={[]} series={SERIES} />);

    expect(screen.getByText("No data")).toBeInTheDocument();
  });

  it("renders the default empty message for zero series", () => {
    render(<TimeSeriesAreaChart points={POINTS} series={[]} />);

    expect(screen.getByText("No data")).toBeInTheDocument();
  });

  it("renders the empty message when every bucket is all-zero", () => {
    render(
      <TimeSeriesAreaChart
        points={[
          { date: "2026-01-01", values: { tokens: 0 } },
          { date: "2026-01-02", values: { tokens: 0 } },
        ]}
        series={SERIES}
      />
    );

    expect(screen.getByText("No data")).toBeInTheDocument();
  });

  it("uses the caller's own empty message over the default", () => {
    render(
      <TimeSeriesAreaChart
        emptyMessage="Nothing to show yet"
        points={[]}
        series={SERIES}
      />
    );

    expect(screen.getByText("Nothing to show yet")).toBeInTheDocument();
    expect(screen.queryByText("No data")).not.toBeInTheDocument();
  });
});

describe("TimeSeriesAreaChart — populated branch", () => {
  it("does not render the empty message for real data", () => {
    const { container } = render(
      <TimeSeriesAreaChart points={POINTS} series={SERIES} />
    );

    expect(screen.queryByText("No data")).not.toBeInTheDocument();
    expect(container.querySelector('[data-slot="chart"]')).not.toBeNull();
  });

  it("labels the comparison band when comparison data is supplied", () => {
    render(
      <TimeSeriesAreaChart
        comparison={{ points: POINTS, series: SERIES }}
        points={POINTS}
        series={SERIES}
      />
    );

    // The comparison legend entry is what the prop actually adds; the chart
    // mounts identically without it.
    expect(screen.getByText("Comparison")).toBeInTheDocument();
  });

  it("adds no comparison label when the prop is absent", () => {
    render(<TimeSeriesAreaChart points={POINTS} series={SERIES} />);

    expect(screen.queryByText("Comparison")).not.toBeInTheDocument();
  });

  it("draws a reference line and its label for each marker", () => {
    const markers: TimeSeriesMarker[] = [
      { date: "2026-01-01", description: "Version 3 created", label: "v3" },
    ];

    const { container } = render(
      <TimeSeriesAreaChart markers={markers} points={POINTS} series={SERIES} />
    );

    expect(container.querySelectorAll(".recharts-reference-line")).toHaveLength(
      1
    );
    expect(screen.getByText("v3")).toBeInTheDocument();
    expect(screen.getByText("Version 3 created")).toBeInTheDocument();
  });

  it("draws no reference line when there are no markers", () => {
    const { container } = render(
      <TimeSeriesAreaChart points={POINTS} series={SERIES} />
    );

    expect(container.querySelectorAll(".recharts-reference-line")).toHaveLength(
      0
    );
  });

  it("folds the series past maxSeries into a single labelled Other band", () => {
    const multiSeries: TimeSeriesSeriesDef[] = [
      { key: "tokens", label: "Tokens" },
      { key: "cost", label: "Cost" },
      { key: "runs", label: "Runs" },
    ];
    const multiPoints: TimeSeriesPointDatum[] = [
      { date: "2026-01-01", values: { cost: 5, runs: 3, tokens: 100 } },
      { date: "2026-01-02", values: { cost: 10, runs: 4, tokens: 200 } },
    ];

    render(
      <TimeSeriesAreaChart
        maxSeries={2}
        points={multiPoints}
        series={multiSeries}
      />
    );

    // The lowest-ranked series is folded away and named by count, so the fold
    // is visible in the legend rather than only inside the helper.
    expect(screen.getByText("Other (1)")).toBeInTheDocument();
    expect(screen.queryByText("Runs")).not.toBeInTheDocument();
    expect(screen.getByText("Tokens")).toBeInTheDocument();

    cleanup();

    render(<TimeSeriesAreaChart points={multiPoints} series={multiSeries} />);

    expect(screen.queryByText("Other (1)")).not.toBeInTheDocument();
    expect(screen.getByText("Runs")).toBeInTheDocument();
  });
});
