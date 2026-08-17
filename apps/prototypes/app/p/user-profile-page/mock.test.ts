import { MetricPolarity } from "@repo/design-system/components/ui/primitives/metric-polarity";
import { describe, expect, it } from "vitest";
import {
  contributionHeatmap,
  DEFAULT_RANGE,
  type HeadlineMetric,
  HeadlineMetricKey,
  headlineMetricsFor,
  personalBests,
  publicProfile,
  RANGE_COPY,
  RangeDays,
  tokenBreakdownFor,
  totalTokensFor,
} from "./mock";

function metricByKey(
  metrics: HeadlineMetric[],
  key: HeadlineMetricKey
): HeadlineMetric {
  const metric = metrics.find((candidate) => candidate.key === key);
  if (!metric) {
    throw new Error(`missing metric ${key}`);
  }
  return metric;
}

function parseCurrency(value: string | number): number {
  return Number(String(value).replace(/[^0-9.]/g, ""));
}

describe("headlineMetricsFor", () => {
  it("gives every range its own PRs-shipped total, delta, and sparkline instead of relabeling one fixture (#4285 T29/T34)", () => {
    const month = metricByKey(
      headlineMetricsFor(RangeDays.Month),
      HeadlineMetricKey.PrsShipped
    );
    const quarter = metricByKey(
      headlineMetricsFor(RangeDays.Quarter),
      HeadlineMetricKey.PrsShipped
    );
    const year = metricByKey(
      headlineMetricsFor(RangeDays.Year),
      HeadlineMetricKey.PrsShipped
    );

    expect(month.value).not.toBe(quarter.value);
    expect(quarter.value).not.toBe(year.value);
    expect(month.delta).not.toBe(quarter.delta);
    expect(quarter.delta).not.toBe(year.delta);
    expect(month.sparkline).not.toEqual(quarter.sparkline);
    expect(quarter.sparkline).not.toEqual(year.sparkline);
  });

  it("does not scale the 90-day PRs-shipped total into a superhuman 1y figure (#4285 T30)", () => {
    const quarter = metricByKey(
      headlineMetricsFor(RangeDays.Quarter),
      HeadlineMetricKey.PrsShipped
    );
    const year = metricByKey(
      headlineMetricsFor(RangeDays.Year),
      HeadlineMetricKey.PrsShipped
    );
    // A straight day-count scale (365/90 ≈ 4.06x) is what produced the
    // original superhuman total; the hand-authored year figure must land
    // well under that.
    expect(Number(year.value)).toBeLessThan(Number(quarter.value) * 3);
  });

  it("derives the 90-day PRs-shipped total from the same grid the contribution graph renders (#4285 T27)", () => {
    const last13Weeks = contributionHeatmap.slice(-13);
    const expected = last13Weeks
      .flat()
      .reduce((sum, cell) => sum + cell.count, 0);
    const quarter = metricByKey(
      headlineMetricsFor(RangeDays.Quarter),
      HeadlineMetricKey.PrsShipped
    );
    expect(quarter.value).toBe(expected);
  });

  it("does not scale spend into a superhuman 1y total either (#4285 T30)", () => {
    const quarterTokens = totalTokensFor(RangeDays.Quarter);
    const yearTokens = totalTokensFor(RangeDays.Year);
    expect(yearTokens).toBeLessThan(quarterTokens * 3.5);

    const quarterSpend = metricByKey(
      headlineMetricsFor(RangeDays.Quarter),
      HeadlineMetricKey.Spend
    );
    const yearSpend = metricByKey(
      headlineMetricsFor(RangeDays.Year),
      HeadlineMetricKey.Spend
    );
    expect(parseCurrency(yearSpend.value)).toBeLessThan(
      parseCurrency(quarterSpend.value) * 3.5
    );
  });

  it("assigns a polarity per metric instead of one HigherIsBetter for all six (#4285 T25)", () => {
    const metrics = headlineMetricsFor(DEFAULT_RANGE);
    const polarityByKey = new Map(
      metrics.map((metric) => [metric.key, metric.polarity])
    );

    expect(polarityByKey.get(HeadlineMetricKey.Spend)).toBe(
      MetricPolarity.LowerIsBetter
    );
    expect(polarityByKey.get(HeadlineMetricKey.TokensTotal)).toBe(
      MetricPolarity.Neutral
    );
    expect(polarityByKey.get(HeadlineMetricKey.PrsShipped)).toBe(
      MetricPolarity.HigherIsBetter
    );
    // Not every metric shares the same polarity — that sameness was the bug.
    expect(new Set(polarityByKey.values()).size).toBeGreaterThan(1);
  });
});

describe("tokenBreakdownFor", () => {
  it("stays consistent with the headline Tokens-used total for every range", () => {
    for (const range of Object.values(RangeDays)) {
      const breakdownTotal = tokenBreakdownFor(range).reduce(
        (sum, slice) => sum + slice.value,
        0
      );
      expect(breakdownTotal).toBe(totalTokensFor(range));
    }
  });
});

describe("personalBests", () => {
  it("keeps the heatmap's actual busiest week as the record, not a stale hand-typed number (#4285 T27)", () => {
    const weekTotals = contributionHeatmap.map((week) =>
      week.reduce((sum, cell) => sum + cell.count, 0)
    );
    const best = Math.max(...weekTotals);
    const personalBest = personalBests.find(
      (entry) => entry.key === "prs-week"
    );
    expect(personalBest?.value).toBe(String(best));
  });
});

describe("RANGE_COPY", () => {
  it("uses the same word for the 1-year window as the (always-on) contribution graph title (#4285 T32)", () => {
    expect(RANGE_COPY[RangeDays.Year].window).toBe("last year");
  });
});

describe("publicProfile", () => {
  it("states the snapshot window instead of reading as a lifetime figure (#4285 T26)", () => {
    expect(publicProfile.windowLabel.toLowerCase()).toContain("90 days");
    expect(publicProfile.og.subtitle).toContain(publicProfile.windowLabel);
  });
});
