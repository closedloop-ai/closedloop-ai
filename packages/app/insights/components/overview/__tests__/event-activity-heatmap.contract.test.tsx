import type { ActivityHeatmap } from "@repo/api/src/types/insights";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import goldenFixture from "../../../__tests__/fixtures/golden-render-aggregates.json";
import { EventActivityHeatmap } from "../event-activity-heatmap";

const DAY_PREFIX_REGEX = /^(\d{4}-\d{2}-\d{2})\s/;
const TURN_COUNT_REGEX = /· (\d+) turns$/;

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));

function cellTitle(day: string, hour: number, value: number): string {
  return `${day} ${String(hour).padStart(2, "0")}:00 · ${value} turns`;
}

function findCellByTitle(title: string): HTMLElement {
  return screen.getByTitle(title);
}

describe("EventActivityHeatmap contract (FEA-2650)", () => {
  describe("mode semantics", () => {
    const fixture: ActivityHeatmap = {
      days: ["2026-06-01"],
      cells: [{ day: "2026-06-01", hour: 10, human: 2, agent: 3 }],
    };

    it("renders Both mode summing human + agent (cellValue 'both' contract)", () => {
      render(<EventActivityHeatmap heatmap={fixture} />);

      const cell = findCellByTitle(cellTitle("2026-06-01", 10, 5));
      expect(cell).toBeInTheDocument();
    });

    it("renders Human mode showing only human count", async () => {
      const user = userEvent.setup();
      render(<EventActivityHeatmap heatmap={fixture} />);

      await user.click(screen.getByRole("radio", { name: "Human" }));

      const cell = findCellByTitle(cellTitle("2026-06-01", 10, 2));
      expect(cell).toBeInTheDocument();
    });

    it("renders Agent mode showing only agent count", async () => {
      const user = userEvent.setup();
      render(<EventActivityHeatmap heatmap={fixture} />);

      await user.click(screen.getByRole("radio", { name: "Agent" }));

      const cell = findCellByTitle(cellTitle("2026-06-01", 10, 3));
      expect(cell).toBeInTheDocument();
    });
  });

  describe("zero-cell contract", () => {
    const fixture: ActivityHeatmap = {
      days: ["2026-06-01"],
      cells: [
        { day: "2026-06-01", hour: 5, human: 0, agent: 0 },
        { day: "2026-06-01", hour: 6, human: 4, agent: 8 },
      ],
    };

    it("renders zero-value cells with the level-0 palette color, distinct from nonzero cells", () => {
      render(<EventActivityHeatmap heatmap={fixture} />);

      const zeroCell = findCellByTitle(cellTitle("2026-06-01", 5, 0));
      const nonzeroCell = findCellByTitle(cellTitle("2026-06-01", 6, 12));

      const zeroBg = zeroCell.style.background;
      const nonzeroBg = nonzeroCell.style.background;

      expect(zeroBg).toBeTruthy();
      expect(nonzeroBg).toBeTruthy();
      expect(zeroBg).not.toBe(nonzeroBg);
    });

    it("renders absent cells identically to explicit zero cells", () => {
      render(<EventActivityHeatmap heatmap={fixture} />);

      const explicitZero = findCellByTitle(cellTitle("2026-06-01", 5, 0));
      const absentCell = findCellByTitle(cellTitle("2026-06-01", 0, 0));

      expect(explicitZero.style.background).toBe(absentCell.style.background);
    });
  });

  describe("empty contract", () => {
    it("renders empty message and no grid when days is empty", () => {
      const { container } = render(
        <EventActivityHeatmap heatmap={{ days: [], cells: [] }} />
      );

      expect(screen.getByText("No activity in range yet")).toBeInTheDocument();

      const gridCells = container.querySelectorAll("[title]");
      expect(gridCells).toHaveLength(0);
    });

    it("renders empty message when heatmap is undefined", () => {
      render(<EventActivityHeatmap heatmap={undefined} />);

      expect(screen.getByText("No activity in range yet")).toBeInTheDocument();
    });

    it("renders the empty state (not a blank grid) when the day axis is populated but cells is empty", () => {
      // The regression: the local insights engine derives the `days` axis
      // independently of the turn buckets (`eachDay(trendStart, end)`), so it is
      // fully populated whenever a window is selected — even when the windowed
      // `session_turn_bucket` scan produced zero cells (un-backfilled corpus, or
      // all activity outside the started_at window). Gating solely on
      // `days.length` painted a full 24×N lattice of empty level-0 cells here,
      // reading as a permanently blank Event Activity card while every sibling
      // KPI (backed by sessions/events/tokens, not the bucket table) still
      // showed data. With no cells there is nothing to plot, so the graceful
      // empty state must win over the grid.
      const axisOnly: ActivityHeatmap = {
        days: ["2026-06-01", "2026-06-02", "2026-06-03"],
        cells: [],
      };
      const { container } = render(<EventActivityHeatmap heatmap={axisOnly} />);

      expect(screen.getByText("No activity in range yet")).toBeInTheDocument();
      // No lattice cells were rendered — the deceptive blank grid is gone.
      expect(container.querySelectorAll("[title]")).toHaveLength(0);
    });
  });

  describe("golden fixture sanity", () => {
    const goldenHeatmap: ActivityHeatmap =
      goldenFixture.sections.utilization.charts.activityHeatmap;

    it("renders golden fixture without NaN or undefined in any cell title", () => {
      const { container } = render(
        <EventActivityHeatmap heatmap={goldenHeatmap} />
      );

      const cells = container.querySelectorAll("[title]");
      expect(cells.length).toBeGreaterThan(0);

      for (const cell of cells) {
        const title = cell.getAttribute("title") ?? "";
        expect(title).not.toContain("NaN");
        expect(title).not.toContain("undefined");
      }
    });

    it("ensures every rendered cell references a day present in the fixture days array", () => {
      const { container } = render(
        <EventActivityHeatmap heatmap={goldenHeatmap} />
      );

      const daySet = new Set(goldenHeatmap.days);
      const cells = container.querySelectorAll("[title]");

      for (const cell of cells) {
        const title = cell.getAttribute("title") ?? "";
        const dayMatch = title.match(DAY_PREFIX_REGEX);
        if (dayMatch) {
          expect(daySet.has(dayMatch[1])).toBe(true);
        }
      }
    });

    it("renders at least one nonzero-density cell from the golden corpus", () => {
      const { container } = render(
        <EventActivityHeatmap heatmap={goldenHeatmap} />
      );

      const cells = container.querySelectorAll("[title]");
      const nonzeroCells = Array.from(cells).filter((cell) => {
        const title = cell.getAttribute("title") ?? "";
        const turnMatch = title.match(TURN_COUNT_REGEX);
        return turnMatch && Number(turnMatch[1]) > 0;
      });

      expect(nonzeroCells.length).toBeGreaterThan(0);
    });

    it("toggles modes on the golden fixture without throwing", async () => {
      const user = userEvent.setup();
      render(<EventActivityHeatmap heatmap={goldenHeatmap} />);

      const humanRadio = screen.getByRole("radio", { name: "Human" });
      await user.click(humanRadio);
      expect(humanRadio).toHaveAttribute("data-state", "on");

      const agentRadio = screen.getByRole("radio", { name: "Agent" });
      await user.click(agentRadio);
      expect(agentRadio).toHaveAttribute("data-state", "on");

      const bothRadio = screen.getByRole("radio", { name: "Both" });
      await user.click(bothRadio);
      expect(bothRadio).toHaveAttribute("data-state", "on");
    });
  });

  describe("day-axis label legibility (FEA-3261)", () => {
    // FEA-2511 swapped the day-axis label class to `min-w-0 truncate`, which
    // clipped each ~weekly `MM-DD` tick to its ~10px `minmax(0,1fr)` grid column
    // and rendered it as an unreadable "0." on both surfaces. The label must
    // stay on one line and be allowed to overflow its column; the grid clips at
    // the card edge so a right-edge label can't widen the document.
    it("renders the day-axis label non-truncated (no `truncate`, wraps disabled)", () => {
      // index 0 gets a label (`index % 7 === 0`); 07-14 is its MM-DD form.
      const fixture: ActivityHeatmap = {
        days: ["2026-07-14"],
        cells: [{ day: "2026-07-14", hour: 9, human: 1, agent: 1 }],
      };

      render(<EventActivityHeatmap heatmap={fixture} />);

      const label = screen.getByText("07-14");
      expect(label.className).not.toContain("truncate");
      expect(label.className).toContain("whitespace-nowrap");
      expect(label.className).toContain("overflow-visible");
    });
  });

  describe("log-scale levels", () => {
    it("assigns different density levels to values 1 and 1000", () => {
      const fixture: ActivityHeatmap = {
        days: ["2026-06-01"],
        cells: [
          { day: "2026-06-01", hour: 0, human: 1, agent: 0 },
          { day: "2026-06-01", hour: 1, human: 1000, agent: 0 },
        ],
      };

      render(<EventActivityHeatmap heatmap={fixture} />);

      const lowCell = findCellByTitle(cellTitle("2026-06-01", 0, 1));
      const highCell = findCellByTitle(cellTitle("2026-06-01", 1, 1000));

      expect(lowCell.style.background).not.toBe(highCell.style.background);
    });
  });
});
