import { DonutChart } from "@closedloop-ai/design-system/components/ui/donut-chart";
import type {
  TimeSeriesPointDatum,
  TimeSeriesSeriesDef,
} from "@closedloop-ai/design-system/components/ui/time-series-area-chart";
import { TimeSeriesAreaChart } from "@closedloop-ai/design-system/components/ui/time-series-area-chart";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Recharts' ResponsiveContainer measures its parent via ResizeObserver, which
// jsdom does not implement. The renderer vitest config has no global setup file
// (unlike @repo/app), so without a shim the container resolves to 0×0 and never
// paints the legend. Report a fixed non-zero size so the chart renders its
// legend buttons under the desktop runtime; restored after this suite.
const CHART_TEST_WIDTH = 800;
const CHART_TEST_HEIGHT = 600;
let previousResizeObserver: typeof globalThis.ResizeObserver | undefined;

class ResizeObserverShim {
  private readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element) {
    this.callback(
      [
        {
          target,
          contentRect: { width: CHART_TEST_WIDTH, height: CHART_TEST_HEIGHT },
          borderBoxSize: [
            { inlineSize: CHART_TEST_WIDTH, blockSize: CHART_TEST_HEIGHT },
          ],
        } as unknown as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver
    );
  }
  unobserve() {
    // no-op
  }
  disconnect() {
    // no-op
  }
}

beforeAll(() => {
  previousResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver =
    ResizeObserverShim as unknown as typeof ResizeObserver;
});

afterAll(() => {
  if (previousResizeObserver) {
    globalThis.ResizeObserver = previousResizeObserver;
  } else {
    Reflect.deleteProperty(globalThis, "ResizeObserver");
  }
});

// FEA-4264 (cross-surface parity): the interactive chart legend lives in the
// shared @closedloop-ai/design-system primitive consumed by BOTH apps/app (web) and this
// Electron renderer. The web adapter has its own coverage; this is the DESKTOP
// renderer adapter's coverage of the same shared component, exercised under the
// renderer's own vitest/jsdom runtime (vitest.renderer.config.ts). JSDOM cannot
// lay out Recharts or compute CSS visibility, so we assert on the accessible
// toggle contract — role + aria-pressed + the rendered legend buttons — not on
// painted pixels. Desktop renderer tests use fireEvent (no @testing-library/
// user-event dep here), matching the sibling renderer suites.
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
  return screen.getByRole("button", { name });
}

// The renderer vitest config loads no jest-dom setup, so assert on the native
// DOM (getAttribute / classList) rather than toHaveAttribute / toHaveClass.
function ariaPressed(name: string): string | null {
  return legendButton(name).getAttribute("aria-pressed");
}

describe("TimeSeriesAreaChart interactive legend (desktop renderer adapter)", () => {
  it("renders each series legend key as an aria-pressed toggle button", () => {
    renderChart();

    expect(ariaPressed("claude-opus-4-8")).toBe("true");
    expect(ariaPressed("gpt-5")).toBe("true");
  });

  it("hides a series on click and restores it on a second click", () => {
    renderChart();

    fireEvent.click(legendButton("claude-opus-4-8"));

    expect(ariaPressed("claude-opus-4-8")).toBe("false");
    // The sibling stays visible — toggling is independent per series.
    expect(ariaPressed("gpt-5")).toBe("true");

    fireEvent.click(legendButton("claude-opus-4-8"));
    expect(ariaPressed("claude-opus-4-8")).toBe("true");
  });

  it("can isolate a single series by hiding its sibling", () => {
    renderChart();

    fireEvent.click(legendButton("gpt-5"));

    expect(ariaPressed("gpt-5")).toBe("false");
    expect(ariaPressed("claude-opus-4-8")).toBe("true");
    // The hidden entry stays in the legend (clickable to restore) and its label
    // stays legible — the off state is carried by aria-pressed + the hollow
    // swatch, not by striking through or dimming the label text (threads #4, #5).
    const label = within(legendButton("gpt-5")).getByText("gpt-5");
    expect(label.classList.contains("line-through")).toBe(false);
    expect(legendButton("gpt-5").classList.contains("opacity-40")).toBe(false);
  });

  it("refuses to hide the last visible series so the chart never empties", () => {
    renderChart();

    fireEvent.click(legendButton("gpt-5"));
    expect(ariaPressed("gpt-5")).toBe("false");

    // Clicking the last visible series is a no-op — the chart must not empty
    // (thread #2).
    fireEvent.click(legendButton("claude-opus-4-8"));
    expect(ariaPressed("claude-opus-4-8")).toBe("true");
  });

  it("reveals a Show all reset once a series is hidden and restores every series", () => {
    renderChart();

    expect(screen.queryByRole("button", { name: "Show all" })).toBeNull();

    fireEvent.click(legendButton("gpt-5"));

    fireEvent.click(screen.getByRole("button", { name: "Show all" }));

    expect(ariaPressed("gpt-5")).toBe("true");
    expect(ariaPressed("claude-opus-4-8")).toBe("true");
    expect(screen.queryByRole("button", { name: "Show all" })).toBeNull();
  });

  it("isolates a series on double-click and restores all on a second double-click", () => {
    renderChart();

    fireEvent.doubleClick(legendButton("claude-opus-4-8"));
    expect(ariaPressed("claude-opus-4-8")).toBe("true");
    expect(ariaPressed("gpt-5")).toBe("false");

    fireEvent.doubleClick(legendButton("claude-opus-4-8"));
    expect(ariaPressed("gpt-5")).toBe("true");
  });

  it("drops the plotted area when its series is hidden, not just the button", () => {
    const { container } = renderChart();

    // Recharts draws one `.recharts-area` per visible <Area>; both to start.
    expect(container.querySelectorAll(".recharts-area")).toHaveLength(2);

    fireEvent.click(legendButton("gpt-5"));

    // The hidden series' area is gone — the plot tracked the hide flag, not just
    // the aria-pressed toggle (wongk review). Restore brings it back.
    expect(container.querySelectorAll(".recharts-area")).toHaveLength(1);

    fireEvent.click(legendButton("gpt-5"));
    expect(container.querySelectorAll(".recharts-area")).toHaveLength(2);
  });

  it("hides the comparison trend line from the plot when toggled off", () => {
    const { container } = render(
      <TimeSeriesAreaChart
        comparison={{ points, series }}
        comparisonLabel="Prev period"
        points={points}
        series={series}
      />
    );

    expect(container.querySelectorAll(".recharts-line")).toHaveLength(1);

    fireEvent.click(legendButton("Prev period"));

    expect(ariaPressed("Prev period")).toBe("false");
    expect(container.querySelectorAll(".recharts-line")).toHaveLength(0);
  });

  it("clears hidden series when resetKey changes without a remount", () => {
    const { rerender } = render(
      <TimeSeriesAreaChart
        points={points}
        resetKey="metric-a"
        series={series}
      />
    );

    fireEvent.click(legendButton("gpt-5"));
    expect(ariaPressed("gpt-5")).toBe("false");

    rerender(
      <TimeSeriesAreaChart
        points={points}
        resetKey="metric-b"
        series={series}
      />
    );

    // Data identity changed → toggle state resets (wongk review).
    expect(ariaPressed("gpt-5")).toBe("true");
  });
});

// FEA-4264 (wongk review): the donut opts OUT of the interactive legend, so
// this is the DESKTOP renderer adapter's coverage that DonutChart mounts under
// the renderer runtime and renders a STATIC legend — an entry per slice, none
// of them toggle buttons.
const donutData = [
  { key: "agent", label: "Agent", value: 60 },
  { key: "human", label: "Human", value: 40 },
];

describe("DonutChart static legend (desktop renderer adapter)", () => {
  it("renders a legend entry per slice with no toggle buttons", () => {
    render(<DonutChart data={donutData} />);

    expect(screen.getByText("Agent")).toBeTruthy();
    expect(screen.getByText("Human")).toBeTruthy();

    // Static legend: no toggle buttons, no "Show all" reset.
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Show all" })).toBeNull();
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

    expect(screen.getByText("No usage yet")).toBeTruthy();
  });
});
