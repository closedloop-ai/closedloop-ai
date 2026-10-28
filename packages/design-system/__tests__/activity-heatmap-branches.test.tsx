import { ActivityHeatmap } from "@closedloop-ai/design-system/components/ui/primitives/activity-heatmap";
import type { AnalyticsHeatmapWeek } from "@closedloop-ai/design-system/components/ui/types";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

afterEach(cleanup);

function days(dates: string[]): AnalyticsHeatmapWeek {
  return dates.map((date) => ({ date, count: 1 }));
}

// Column 0: Wed-Sat (2026-01-07 is a Wednesday) -> days 3..6.
// Column 1: Sun-Wed -> days 0..3.
// Column 2: Sun-Thu -> days 0..4.
const NAV_WEEKS: AnalyticsHeatmapWeek[] = [
  days(["2026-01-07", "2026-01-08", "2026-01-09", "2026-01-10"]),
  days(["2026-01-11", "2026-01-12", "2026-01-13", "2026-01-14"]),
  days(["2026-01-18", "2026-01-19", "2026-01-20", "2026-01-21", "2026-01-22"]),
];

function cellAt(container: HTMLElement, col: number, day: number) {
  const cell = container.querySelector<HTMLElement>(
    `[data-col="${col}"][data-day="${day}"]`
  );
  if (!cell) {
    throw new Error(`no cell at ${col}:${day}`);
  }
  return cell;
}

function press(container: HTMLElement, from: [number, number], key: string) {
  const start = cellAt(container, from[0], from[1]);
  act(() => start.focus());
  const notPrevented = fireEvent.keyDown(start, { key });
  return { notPrevented, active: document.activeElement };
}

describe("ActivityHeatmap keyboard navigation", () => {
  it.each([
    ["ArrowRight", [0, 3], [1, 3]],
    ["ArrowLeft", [1, 3], [0, 3]],
    ["ArrowDown", [0, 3], [0, 4]],
    ["ArrowDown", [0, 5], [0, 6]],
    ["ArrowUp", [1, 1], [1, 0]],
  ] as const)(
    "%s moves focus from %j to %j and prevents default",
    (key, from, to) => {
      const { container } = render(<ActivityHeatmap weeks={NAV_WEEKS} />);
      const { notPrevented, active } = press(
        container,
        [from[0], from[1]],
        key
      );
      expect(active).toBe(cellAt(container, to[0], to[1]));
      expect(notPrevented).toBe(false);
    }
  );

  it("skips empty padding positions to land on the next real day", () => {
    const { container } = render(<ActivityHeatmap weeks={NAV_WEEKS} />);
    // (1,4) is empty padding; (2,4) is Thu 2026-01-22.
    const { active } = press(container, [0, 4], "ArrowRight");
    expect(active).toBe(cellAt(container, 2, 4));
  });

  it.each([
    ["ArrowUp", [0, 3]],
    ["ArrowLeft", [1, 0]],
    ["ArrowRight", [2, 0]],
    ["ArrowDown", [0, 6]],
  ] as const)(
    "%s at the edge from %j keeps focus and does not prevent default",
    (key, from) => {
      const { container } = render(<ActivityHeatmap weeks={NAV_WEEKS} />);
      const { notPrevented, active } = press(
        container,
        [from[0], from[1]],
        key
      );
      expect(active).toBe(cellAt(container, from[0], from[1]));
      expect(notPrevented).toBe(true);
    }
  );

  it("ignores non-arrow keys", () => {
    const { container } = render(<ActivityHeatmap weeks={NAV_WEEKS} />);
    const { notPrevented, active } = press(container, [0, 3], "Enter");
    expect(active).toBe(cellAt(container, 0, 3));
    expect(notPrevented).toBe(true);
  });

  it("ignores arrow keys when focus is not on a cell", () => {
    const { container } = render(<ActivityHeatmap weeks={NAV_WEEKS} />);
    const grid = screen.getByRole("grid");
    const notPrevented = fireEvent.keyDown(grid, { key: "ArrowRight" });
    expect(notPrevented).toBe(true);
    expect(document.activeElement).toBe(document.body);
    expect(container.querySelector('[tabindex="0"]')).toBe(
      cellAt(container, 0, 3)
    );
  });
});

describe("ActivityHeatmap grid layout edge cases", () => {
  it("skips an empty week without opening a column", () => {
    const { container } = render(
      <ActivityHeatmap weeks={[[], days(["2026-01-04"])]} />
    );
    expect(screen.getAllByRole("gridcell")).toHaveLength(1);
    expect(cellAt(container, 0, 0).getAttribute("aria-label")).toBe(
      "Jan 4, 2026: 1 events"
    );
  });

  it("opens a new column when a week's cells wrap past Saturday", () => {
    // 2026-01-09 is a Friday; the third cell wraps to Sunday.
    const { container } = render(
      <ActivityHeatmap
        weeks={[days(["2026-01-09", "2026-01-10", "2026-01-11"])]}
      />
    );
    expect(cellAt(container, 0, 5).getAttribute("aria-label")).toBe(
      "Jan 9, 2026: 1 events"
    );
    expect(cellAt(container, 1, 0).getAttribute("aria-label")).toBe(
      "Jan 11, 2026: 1 events"
    );
    // Two columns total: the wrap opened column 1 and nothing else was added.
    expect(
      screen.getAllByRole("row")[0]?.querySelectorAll(":scope > *")
    ).toHaveLength(2);
  });
});
