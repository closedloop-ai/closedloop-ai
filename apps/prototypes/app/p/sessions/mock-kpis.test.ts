import { describe, expect, it } from "vitest";
import { sessionRows, WINDOW_MINUTES } from "./mock";
import { computeSummaryKpis } from "./mock-kpis";

describe("computeSummaryKpis", () => {
  it.each([
    "7d",
    "30d",
    "90d",
  ] as const)("does not invent a %s comparison", (dateRange) => {
    const rows = sessionRows.filter(
      (row) => row.startedAgoMinutes <= WINDOW_MINUTES[dateRange]
    );

    const kpis = computeSummaryKpis(rows, dateRange, false);

    expect(kpis.map((kpi) => kpi.label)).toEqual([
      "Sessions",
      "Total tokens",
      "Cost",
      "PRs shipped",
      "LOC (merged) / $",
    ]);
    expect(kpis.every((kpi) => kpi.delta == null)).toBe(true);
    expect(kpis.every((kpi) => kpi.deltaLabel == null)).toBe(true);
  });

  it("shows 52 merged LOC per dollar for the default range", () => {
    const rows = sessionRows.filter(
      (row) => row.startedAgoMinutes <= WINDOW_MINUTES["30d"]
    );

    const efficiency = computeSummaryKpis(rows, "30d", false).find(
      (kpi) => kpi.key === "efficiency"
    );

    expect(efficiency).toMatchObject({
      detail: "merged LOC per dollar",
      label: "LOC (merged) / $",
      value: "52",
    });
  });

  it("shows no prior comparison for all time", () => {
    const kpis = computeSummaryKpis(sessionRows, "all", false);

    expect(kpis.every((kpi) => kpi.delta === undefined)).toBe(true);
    expect(kpis.every((kpi) => kpi.deltaLabel === undefined)).toBe(true);
  });

  it("suppresses illustrative comparisons when filters are active", () => {
    const kpis = computeSummaryKpis(sessionRows, "30d", true);

    expect(kpis.every((kpi) => kpi.delta === undefined)).toBe(true);
  });
});
