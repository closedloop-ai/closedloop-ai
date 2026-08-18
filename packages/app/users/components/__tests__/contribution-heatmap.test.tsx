import type { ContributionDay } from "@repo/api/src/types/user";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ContributionHeatmap } from "../contribution-heatmap";

// Three consecutive days spanning a Sunday boundary: Sat 2026-03-07 (dow 6),
// Sun 2026-03-08 (dow 0, starts a new week column), Mon 2026-03-09.
const data: ContributionDay[] = [
  { date: "2026-03-07", count: 0 },
  { date: "2026-03-08", count: 1 },
  { date: "2026-03-09", count: 12 },
];

describe("ContributionHeatmap", () => {
  it("names the grid per instance and exposes one gridcell per day", () => {
    render(<ContributionHeatmap data={data} />);

    const grid = screen.getByRole("grid", { name: "Contributions by day" });
    const cells = within(grid).getAllByRole("gridcell");
    expect(cells).toHaveLength(data.length);
  });

  it("labels each cell with a human date and count, not color alone", () => {
    render(<ContributionHeatmap data={data} />);

    // Singular vs. plural, and the value is in the accessible name (and a
    // tooltip) so SR/keyboard/mouse users can read activity that sighted users
    // get from the color ramp. Dates read as "Mar 8, 2026", not the ISO string
    // a screen reader spells out as digits and dashes.
    expect(
      screen.getByRole("gridcell", { name: "Mar 8, 2026: 1 contribution" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("gridcell", { name: "Mar 9, 2026: 12 contributions" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("gridcell", { name: "Mar 7, 2026: 0 contributions" })
    ).toBeInTheDocument();
  });

  it("uses a roving tabindex: exactly one cell is in the tab order", () => {
    render(<ContributionHeatmap data={data} />);

    const cells = screen.getAllByRole("gridcell");
    const tabbable = cells.filter(
      (cell) => cell.getAttribute("tabindex") === "0"
    );
    expect(tabbable).toHaveLength(1);
    for (const cell of cells) {
      // Every cell is at least programmatically focusable (0 or -1), never
      // untabbable/undefined.
      expect(["0", "-1"]).toContain(cell.getAttribute("tabindex"));
    }
  });

  it("exposes weekday rows, not week-column rows", () => {
    render(<ContributionHeatmap data={data} />);

    // The grid is transposed: 7 weekday rows (Sun..Sat), each holding the weeks
    // as gridcells, so a year reads as 7 rows not ~53. Sat/Sun/Mon land in three
    // different weekday rows.
    const rows = screen.getAllByRole("row");
    expect(rows).toHaveLength(7);
    const populatedRows = rows.filter(
      (row) => within(row).queryAllByRole("gridcell").length > 0
    );
    expect(populatedRows).toHaveLength(3);
  });

  it("renders a terse empty state when there are no contributions", () => {
    render(
      <ContributionHeatmap
        data={[
          { date: "2026-03-07", count: 0 },
          { date: "2026-03-08", count: 0 },
        ]}
      />
    );

    expect(screen.getByText("No contributions yet")).toBeInTheDocument();
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
  });
});
