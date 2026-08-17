import {
  type ChartConfig,
  ChartContainer,
} from "@repo/design-system/components/ui/chart";
import { render } from "@testing-library/react";
import { Area, AreaChart } from "recharts";
import { describe, expect, it } from "vitest";

// FEA-3961: the shared design-system ChartContainer hosts every dashboard chart
// (Model cost over time, Autonomy Trend, the PR/model breakdowns) through a
// Recharts ResponsiveContainer. When the container's parent momentarily
// resolves to 0×0 (a `flex-1 min-h-0` chain, an expand modal, a grid cell before
// its track settles) Recharts logs `width(-1) and height(-1) ... should be
// greater than 0` and renders an invisible chart. The fix floors the height in
// two layers: a `min-h-40` on the ChartContainer BOX (so a shrinkable host grows
// to fit the chart instead of the chart overflowing the card) and a matching
// `minHeight` on the inner ResponsiveContainer (so it always has real pixels to
// measure mid-layout). These tests assert both floors are present and that
// neither pins a fixed height a taller parent couldn't override.

const CONFIG: ChartConfig = {
  spend: { label: "Spend", color: "var(--chart-1)" },
};

function renderChart() {
  return render(
    <ChartContainer config={CONFIG}>
      <AreaChart data={[{ date: "2026-01-01", spend: 3 }]}>
        <Area dataKey="spend" />
      </AreaChart>
    </ChartContainer>
  );
}

function parsePx(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  return Number.parseFloat(value.replace("px", ""));
}

describe("ChartContainer ResponsiveContainer sizing (FEA-3961)", () => {
  it("floors the ChartContainer box min-height so a shrinkable host grows to fit the chart", () => {
    const { container } = renderChart();
    const box = container.querySelector<HTMLElement>('[data-slot="chart"]');
    expect(box).toBeTruthy();
    // The layout box the parent measures carries the floor (min-h-40 = 160px), so
    // a `flex-1 min-h-0` host can't shrink it below the chart and force overflow.
    expect(box?.className).toContain("min-h-40");
  });

  it("floors the responsive container to a non-zero min-height so it never renders 0×0", () => {
    const { container } = renderChart();
    const responsive = container.querySelector<HTMLElement>(
      ".recharts-responsive-container"
    );
    expect(responsive).toBeTruthy();
    // A non-zero min-height means the container always has something to measure,
    // so it can never collapse to the 0×0 that triggers the width(-1)/height(-1)
    // Recharts warning and an invisible chart.
    expect(parsePx(responsive!.style.minHeight)).toBeGreaterThan(0);
  });

  it("does not pin a fixed height, so a height-owning parent still stretches the chart", () => {
    const { container } = renderChart();
    const responsive = container.querySelector<HTMLElement>(
      ".recharts-responsive-container"
    );
    expect(responsive).toBeTruthy();
    // Only a floor is set — the container keeps `height: 100%` so the dashboard
    // cards' explicit `h-[340px]`/`h-full` still drive the real rendered height.
    expect(responsive!.style.height).toBe("100%");
  });
});
