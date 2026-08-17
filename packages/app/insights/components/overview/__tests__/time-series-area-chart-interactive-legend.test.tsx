import { DonutChart } from "@repo/design-system/components/ui/donut-chart";
import type {
  TimeSeriesPointDatum,
  TimeSeriesSeriesDef,
} from "@repo/design-system/components/ui/time-series-area-chart";
import { TimeSeriesAreaChart } from "@repo/design-system/components/ui/time-series-area-chart";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

// FEA-4264: the shared TimeSeriesAreaChart legend is interactive — each key is a
// toggle button that hides/shows its series. This is the WEB (apps/app via
// @repo/app) adapter's coverage of the shared primitive: a click flips the
// series' visibility and updates aria-pressed. JSDOM cannot lay out Recharts
// (0×0 ResponsiveContainer) or compute CSS visibility, but Recharts still emits
// one `.recharts-area` per drawn <Area> into the DOM, so beyond the accessible
// toggle contract (role + aria-pressed) we assert the PLOT itself changed —
// hiding a series drops its rendered area path — so a lost `hide` binding can't
// leave these suites green while the chart never moves (wongk review).
//
// The two series below both carry non-zero values so the range is non-empty and
// the chart renders its legend (a multi-series chart draws <ChartLegend>).
const series: TimeSeriesSeriesDef[] = [
  { key: "claude-opus-4-8", label: "claude-opus-4-8" },
  { key: "gpt-5", label: "gpt-5" },
];

const points: TimeSeriesPointDatum[] = [
  { date: "2026-07-01", values: { "claude-opus-4-8": 100, "gpt-5": 40 } },
  { date: "2026-07-02", values: { "claude-opus-4-8": 60, "gpt-5": 80 } },
];

function renderChart() {
  return render(<TimeSeriesAreaChart points={points} series={series} />);
}

function legendButton(name: string): HTMLElement {
  // Each legend entry is a <button> whose accessible name is the series label.
  return screen.getByRole("button", { name });
}

// Recharts renders one path per drawn <Area>. Counting them proves the plot
// tracks the hide flag, not just the legend button.
function drawnAreaCount(container: HTMLElement): number {
  return container.querySelectorAll(".recharts-area").length;
}

describe("TimeSeriesAreaChart interactive legend (web adapter)", () => {
  it("renders each series legend key as an aria-pressed toggle button", () => {
    renderChart();

    const claude = legendButton("claude-opus-4-8");
    const gpt = legendButton("gpt-5");

    // Both start visible → pressed.
    expect(claude).toHaveAttribute("aria-pressed", "true");
    expect(gpt).toHaveAttribute("aria-pressed", "true");
  });

  it("toggles a single series off and back on independently on click", async () => {
    const user = userEvent.setup();
    renderChart();

    await user.click(legendButton("claude-opus-4-8"));

    // The clicked series is now hidden; its sibling stays visible.
    expect(legendButton("claude-opus-4-8")).toHaveAttribute(
      "aria-pressed",
      "false"
    );
    expect(legendButton("gpt-5")).toHaveAttribute("aria-pressed", "true");

    // Clicking again restores it — the toggle is independent per series.
    await user.click(legendButton("claude-opus-4-8"));
    expect(legendButton("claude-opus-4-8")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });

  it("can hide every-but-one series, isolating a single series", async () => {
    const user = userEvent.setup();
    renderChart();

    // Hide gpt-5 → only claude remains selected (down to a single visible
    // series, the minimum-bar "isolate" behavior).
    await user.click(legendButton("gpt-5"));

    expect(legendButton("gpt-5")).toHaveAttribute("aria-pressed", "false");
    expect(legendButton("claude-opus-4-8")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });

  it("keeps the hidden entry in the legend and readable, not struck-through or removed", async () => {
    const user = userEvent.setup();
    renderChart();

    await user.click(legendButton("gpt-5"));

    // The hidden entry stays in the legend (still clickable to restore) and its
    // label stays legible — the off state is carried by aria-pressed + the
    // hollow swatch, NOT by striking through or dimming the one bit of text a
    // user reads to find the series to bring back (review threads #4, #5).
    const gpt = legendButton("gpt-5");
    expect(gpt).toBeInTheDocument();
    const label = within(gpt).getByText("gpt-5");
    expect(label).not.toHaveClass("line-through");
    expect(gpt).not.toHaveClass("opacity-40");
  });

  it("refuses to hide the last visible series so the chart never empties", async () => {
    const user = userEvent.setup();
    renderChart();

    // Hide one of the two series, leaving a single series visible.
    await user.click(legendButton("gpt-5"));
    expect(legendButton("gpt-5")).toHaveAttribute("aria-pressed", "false");

    // Clicking the last visible series is a no-op — the chart must not go empty
    // (review thread #2). It stays pressed/visible.
    await user.click(legendButton("claude-opus-4-8"));
    expect(legendButton("claude-opus-4-8")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });

  it("reveals a Show all reset once a series is hidden and restores every series", async () => {
    const user = userEvent.setup();
    renderChart();

    // No reset while everything is visible.
    expect(
      screen.queryByRole("button", { name: "Show all" })
    ).not.toBeInTheDocument();

    await user.click(legendButton("gpt-5"));

    const showAll = screen.getByRole("button", { name: "Show all" });
    await user.click(showAll);

    // Every series is visible again and the reset disappears (review thread #6).
    expect(legendButton("gpt-5")).toHaveAttribute("aria-pressed", "true");
    expect(legendButton("claude-opus-4-8")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(
      screen.queryByRole("button", { name: "Show all" })
    ).not.toBeInTheDocument();
  });

  it("isolates a series on double-click and restores all on a second double-click", async () => {
    const user = userEvent.setup();
    renderChart();

    // Double-click claude → only claude visible, gpt-5 hidden (review thread #6
    // "isolate"). userEvent.dblClick fires the dblclick that drives isolate.
    await user.dblClick(legendButton("claude-opus-4-8"));
    expect(legendButton("claude-opus-4-8")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(legendButton("gpt-5")).toHaveAttribute("aria-pressed", "false");

    // Double-clicking the isolated series again restores every series.
    await user.dblClick(legendButton("claude-opus-4-8"));
    expect(legendButton("gpt-5")).toHaveAttribute("aria-pressed", "true");
  });

  it("drops the plotted area when its series is hidden, not just the button", async () => {
    const user = userEvent.setup();
    const { container } = renderChart();

    // Both series draw an area to start.
    expect(drawnAreaCount(container)).toBe(2);

    await user.click(legendButton("gpt-5"));

    // The <Area> for the hidden series is gone from the plot — proving the
    // legend's hide flag reached Recharts, not only the aria-pressed toggle
    // (wongk review). Restore and the area comes back.
    expect(drawnAreaCount(container)).toBe(1);

    await user.click(legendButton("gpt-5"));
    expect(drawnAreaCount(container)).toBe(2);
  });

  it("clears hidden series when its data identity (resetKey) changes without a remount", async () => {
    const user = userEvent.setup();
    // Same component instance across the rerender (no key change) — only the
    // resetKey moves, standing in for a metric-picker preview swapping which
    // metric it draws (wongk review). Without the reset, a series hidden under
    // one identity would carry into the next and hide an unrelated same-named
    // bucket.
    const { rerender } = render(
      <TimeSeriesAreaChart
        points={points}
        resetKey="metric-a"
        series={series}
      />
    );

    await user.click(legendButton("gpt-5"));
    expect(legendButton("gpt-5")).toHaveAttribute("aria-pressed", "false");

    rerender(
      <TimeSeriesAreaChart
        points={points}
        resetKey="metric-b"
        series={series}
      />
    );

    // The identity changed, so the toggle state resets — gpt-5 is visible again.
    expect(legendButton("gpt-5")).toHaveAttribute("aria-pressed", "true");
  });

  it("hides the comparison trend line from the plot when its legend entry is toggled off", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <TimeSeriesAreaChart
        comparison={{ points, series }}
        comparisonLabel="Prev period"
        points={points}
        series={series}
      />
    );

    // The comparison overlay renders one <Line> in addition to the areas.
    expect(container.querySelectorAll(".recharts-line")).toHaveLength(1);

    await user.click(legendButton("Prev period"));

    // Toggling the comparison entry off drops the line from the plot too, so the
    // comparison series honors the same hide contract as the areas (wongk).
    expect(legendButton("Prev period")).toHaveAttribute(
      "aria-pressed",
      "false"
    );
    expect(container.querySelectorAll(".recharts-line")).toHaveLength(0);
  });
});

// FEA-4264 (wongk review): the donut opts OUT of the interactive legend — a
// part-to-whole ring has no on-screen denominator, so hiding a slice would
// silently misread the survivors. This is the WEB adapter's coverage that the
// shared DonutChart mounts and renders a STATIC (non-toggle) legend: an entry
// per slice, none of them buttons. JSDOM cannot lay out the pie's arcs, so we
// assert the legend contract (labels present, no toggle affordance) rather than
// the drawn ring.
const donutData = [
  { key: "agent", label: "Agent", value: 60 },
  { key: "human", label: "Human", value: 40 },
];

describe("DonutChart static legend (web adapter)", () => {
  it("renders a legend entry per slice with no toggle buttons", () => {
    render(<DonutChart data={donutData} />);

    // Both slice labels are present in the legend...
    expect(screen.getByText("Agent")).toBeInTheDocument();
    expect(screen.getByText("Human")).toBeInTheDocument();

    // ...but the donut legend is static: there are no toggle buttons and no
    // "Show all" reset (which only the interactive legend renders).
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(
      screen.queryByRole("button", { name: "Show all" })
    ).not.toBeInTheDocument();
  });

  it("renders its empty state instead of a ring when every slice is zero", () => {
    render(
      <DonutChart
        data={[
          { key: "agent", label: "Agent", value: 0 },
          { key: "human", label: "Human", value: 0 },
        ]}
        emptyMessage="No usage yet"
      />
    );

    expect(screen.getByText("No usage yet")).toBeInTheDocument();
  });
});
