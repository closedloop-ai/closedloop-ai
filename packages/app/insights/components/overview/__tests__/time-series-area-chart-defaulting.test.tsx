import type {
  TimeSeriesPointDatum,
  TimeSeriesSeriesDef,
} from "@repo/design-system/components/ui/time-series-area-chart";
import { TimeSeriesAreaChart } from "@repo/design-system/components/ui/time-series-area-chart";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

// Companion to the ModelUsageChart contract tests: those mock the chart, so
// they cannot verify what happens to a declared-but-missing per-bucket key.
// The real defaulting lives here — `isEmptyTimeSeries` (and the row/comparison
// math) reads `point.values[entry.key] ?? 0`, so a missing key is treated as 0,
// never NaN/undefined. This exercises the UNMOCKED component directly.
//
// We assert through the empty-state early return (a plain <div>, no Recharts
// paint) to keep the test robust in jsdom: if a missing key defaults to 0, an
// otherwise all-zero range is "empty" and renders `emptyMessage`. Were the key
// instead read as `undefined` (no `?? 0`), the `=== 0` check would fail, the
// series would count as non-empty, and the empty copy would NOT render.
describe("TimeSeriesAreaChart missing-per-bucket-key defaulting", () => {
  const series: TimeSeriesSeriesDef[] = [
    { key: "claude-opus-4-8", label: "claude-opus-4-8" },
    // Declared as a series but absent from every bucket below.
    { key: "gpt-5", label: "gpt-5" },
  ];

  it("treats a declared key missing from the bucket as 0 (all-zero range → empty-state)", () => {
    const points: TimeSeriesPointDatum[] = [
      // gpt-5 missing; claude present as 0. If gpt-5 defaults to 0 the whole
      // range is zero → empty-state copy renders.
      { date: "2026-07-01", values: { "claude-opus-4-8": 0 } },
    ];

    render(
      <TimeSeriesAreaChart
        emptyMessage="Token usage wasn't recorded for this range"
        points={points}
        series={series}
      />
    );

    expect(
      screen.getByText("Token usage wasn't recorded for this range")
    ).toBeInTheDocument();
  });

  it("keeps a bucket non-empty when a present key is non-zero even though a sibling key is missing", () => {
    const points: TimeSeriesPointDatum[] = [
      // gpt-5 missing (→ 0), but claude is non-zero, so the range is NOT empty
      // and the chart does not fall through to the empty-state copy.
      { date: "2026-07-01", values: { "claude-opus-4-8": 10 } },
    ];

    render(
      <TimeSeriesAreaChart
        emptyMessage="Token usage wasn't recorded for this range"
        points={points}
        series={series}
      />
    );

    expect(
      screen.queryByText("Token usage wasn't recorded for this range")
    ).not.toBeInTheDocument();
  });
});
