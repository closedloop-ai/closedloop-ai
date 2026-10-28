import { ActivityHeatmap } from "@closedloop-ai/design-system/components/ui/primitives/activity-heatmap";
import type { AnalyticsHeatmapWeek } from "@closedloop-ai/design-system/components/ui/types";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Pins current behavior of `ActivityHeatmap`: the grid/row/gridcell structure,
 * the accessible-name wiring (aria-labelledby -> sr-only label span), the
 * per-cell aria-label readout, and the empty-cell (`var(--muted)`) vs.
 * ramp-level (`color-mix(...)`) style branch. Read-only characterization —
 * never change `activity-heatmap.tsx` to make one of these pass.
 */

afterEach(cleanup);

// 2026-01-04 is a Sunday (getUTCDay() === 0), so this week's cells land on
// weekdays 0..6 in order with no leading-partial-week offset.
const SAMPLE_WEEKS: AnalyticsHeatmapWeek[] = [
  [
    { date: "2026-01-04", count: 5 },
    { date: "2026-01-05", count: 0 },
    { date: "2026-01-06", count: 12 },
    { date: "2026-01-07", count: 3 },
    { date: "2026-01-08", count: 0 },
    { date: "2026-01-09", count: 8 },
    { date: "2026-01-10", count: 1 },
  ],
];

// A single high-count day makes cellLevel's log-scaled ramp resolve to its
// top level (5) deterministically, since count === max.
const SINGLE_CELL_WEEKS: AnalyticsHeatmapWeek[] = [
  [{ date: "2026-01-04", count: 10 }],
];

function ariaLabeled(container: HTMLElement, label: string) {
  return container.querySelector(`[aria-label="${label}"]`);
}

describe("ActivityHeatmap", () => {
  it("renders no gridcells for an empty weeks array", () => {
    render(<ActivityHeatmap weeks={[]} />);
    expect(screen.queryAllByRole("gridcell")).toHaveLength(0);
  });

  it("renders the grid structure with role=grid and 7 weekday rows even when empty", () => {
    render(<ActivityHeatmap weeks={[]} />);
    expect(screen.getByRole("grid")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(7);
  });

  it("renders one gridcell per day for a single week, each with an aria-label readout", () => {
    const { container } = render(<ActivityHeatmap weeks={SAMPLE_WEEKS} />);
    expect(screen.getAllByRole("gridcell")).toHaveLength(7);
    expect(ariaLabeled(container, "Jan 4, 2026: 5 events")).toBeInTheDocument();
    expect(
      ariaLabeled(container, "Jan 6, 2026: 12 events")
    ).toBeInTheDocument();
    expect(ariaLabeled(container, "Jan 5, 2026: 0 events")).toBeInTheDocument();
  });

  it("uses a custom label as the grid's accessible name", () => {
    render(<ActivityHeatmap label="Contributions" weeks={SAMPLE_WEEKS} />);
    expect(
      screen.getByRole("grid", { name: "Contributions" })
    ).toBeInTheDocument();
  });

  it("defaults the grid's accessible name to 'Activity by day'", () => {
    render(<ActivityHeatmap weeks={SAMPLE_WEEKS} />);
    expect(
      screen.getByRole("grid", { name: "Activity by day" })
    ).toBeInTheDocument();
  });

  it("renders the 'Less' and 'More' density legend labels", () => {
    render(<ActivityHeatmap weeks={SAMPLE_WEEKS} />);
    expect(screen.getByText("Less")).toBeInTheDocument();
    expect(screen.getByText("More")).toBeInTheDocument();
  });

  it("renders the alternating weekday labels Mon, Wed, Fri", () => {
    render(<ActivityHeatmap weeks={SAMPLE_WEEKS} />);
    expect(screen.getByText("Mon")).toBeInTheDocument();
    expect(screen.getByText("Wed")).toBeInTheDocument();
    expect(screen.getByText("Fri")).toBeInTheDocument();
  });

  it("uses a custom valueFormatter to format each cell's aria-label readout", () => {
    const { container } = render(
      <ActivityHeatmap
        valueFormatter={(count) => `${count} pts`}
        weeks={SAMPLE_WEEKS}
      />
    );
    expect(ariaLabeled(container, "Jan 6, 2026: 12 pts")).toBeInTheDocument();
    expect(ariaLabeled(container, "Jan 5, 2026: 0 pts")).toBeInTheDocument();
  });

  it("gives a count=0 cell the empty-level background color, regardless of the ramp", () => {
    const { container } = render(<ActivityHeatmap weeks={SAMPLE_WEEKS} />);
    const zeroCell = ariaLabeled(container, "Jan 5, 2026: 0 events");
    expect(zeroCell?.getAttribute("style")).toContain("var(--muted)");
  });

  it("mixes the ramp color from the default --primary accent for an active cell", () => {
    const { container } = render(<ActivityHeatmap weeks={SINGLE_CELL_WEEKS} />);
    const cell = ariaLabeled(container, "Jan 4, 2026: 10 events");
    expect(cell?.getAttribute("style")).toContain(
      "color-mix(in oklch, var(--primary) 100%, transparent)"
    );
  });

  it("mixes the ramp color from a custom accentVar for an active cell", () => {
    const { container } = render(
      <ActivityHeatmap accentVar="--success" weeks={SINGLE_CELL_WEEKS} />
    );
    const cell = ariaLabeled(container, "Jan 4, 2026: 10 events");
    expect(cell?.getAttribute("style")).toContain(
      "color-mix(in oklch, var(--success) 100%, transparent)"
    );
  });

  it("only the initial focusable cell is in the tab order (roving tabindex)", () => {
    render(<ActivityHeatmap weeks={SAMPLE_WEEKS} />);
    const gridcells = screen.getAllByRole("gridcell");
    const tabbable = gridcells.filter(
      (cell) => cell.getAttribute("tabindex") === "0"
    );
    const notTabbable = gridcells.filter(
      (cell) => cell.getAttribute("tabindex") === "-1"
    );
    expect(tabbable).toHaveLength(1);
    expect(notTabbable).toHaveLength(gridcells.length - 1);
  });
});
