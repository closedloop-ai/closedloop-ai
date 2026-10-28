import { Priority } from "@repo/api/src/types/common";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ProjectSummaryRow } from "../../lib/project-summary-row";
import {
  buildProjectGroups,
  NO_PRIORITY_GROUP_KEY,
  UNOWNED_GROUP_KEY,
} from "../../lib/project-summary-view";
import { ProjectsTable } from "../projects-table";

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));

/**
 * ISS-10478: `ProjectsTable` computes a SECOND grouping dimension and hands it to
 * `GridTable` as nested bands. Before the adapter landed, list mode rendered each
 * primary band's rows and dropped the nesting entirely — so the secondary
 * grouping the toolbar offers had no effect in this view while the board honored
 * it. This is the two-level LIST group the ticket requires be covered.
 *
 * Rows are read through their own band, in order, rather than spot-checked for a
 * label somewhere in the DOM: a nested band dropped, the two levels rendered as
 * peers, or the primary band's pre-split rows painted instead would all survive a
 * `getByText`.
 */

function row(
  overrides: Partial<ProjectSummaryRow> & Pick<ProjectSummaryRow, "id" | "name">
): ProjectSummaryRow {
  return {
    childTaskCount: null,
    code: null,
    completionPercentage: null,
    dueDateLabel: null,
    dueDateMs: null,
    owner: null,
    priority: null,
    updatedAtMs: 0,
    updatedLabel: "just now",
    ...overrides,
  };
}

const ADA = { initials: "AL", name: "Ada Lovelace" };
const GRACE = { initials: "GH", name: "Grace Hopper" };

const ROWS: ProjectSummaryRow[] = [
  row({ id: "1", name: "Apollo", owner: ADA, priority: Priority.High }),
  row({ id: "2", name: "Borealis", owner: GRACE, priority: Priority.High }),
  row({ id: "3", name: "Cassini", owner: ADA, priority: Priority.Low }),
];

function renderGroupedTable(showEmptySubgroups: boolean) {
  const groups = buildProjectGroups({
    groupBy: "priority",
    groupOrder: "custom",
    rows: ROWS,
    secondaryGroupBy: "owner",
    secondaryGroupOrder: "custom",
    showEmptyGroups: false,
    showEmptySubgroups,
  });
  render(<ProjectsTable groups={groups} rows={ROWS} />);
  return groups;
}

function renderOwnerGroupedTable(showEmptySubgroups: boolean) {
  const groups = buildProjectGroups({
    groupBy: "owner",
    groupOrder: "custom",
    rows: ROWS,
    secondaryGroupBy: "priority",
    secondaryGroupOrder: "custom",
    showEmptyGroups: false,
    showEmptySubgroups,
  });
  render(<ProjectsTable groups={groups} rows={ROWS} />);
}

/** The band header button whose label this is — primary or nested alike. */
function bandHeader(label: string): HTMLElement {
  const header = screen
    .getAllByRole("button")
    .find((button) => button.textContent?.startsWith(label));
  if (!header) {
    throw new Error(`no band header for ${label}`);
  }
  return header;
}

/**
 * Every band header and data row the table painted, in document order: a header
 * as `band:<label>` and a data row as its project name. Pinning the SEQUENCE is
 * what proves nesting rather than two flat levels.
 *
 * The champion grid's data cells are `gridcell`s (it is an ARIA grid widget,
 * not a static table) while a band header is one spanning `cell`, so the two
 * are told apart by their own role rather than by a count.
 */
const CELL_SELECTOR = '[role="gridcell"]';
/** A band header is one cell spanning every track; a data row's cells span one. */
const SPANNING_CELL_SELECTOR = '[role="gridcell"][aria-colspan]';

function paintedOutline(): string[] {
  return screen.getAllByRole("row").flatMap((element) => {
    const spanning = element.querySelector(SPANNING_CELL_SELECTOR);
    if (spanning) {
      const button = spanning.querySelector("button");
      return button ? [`band:${button.textContent ?? ""}`] : [];
    }
    const firstCell = element.querySelector(CELL_SELECTOR);
    return firstCell ? [firstCell.textContent ?? ""] : [];
  });
}

describe("ProjectsTable secondary grouping in list mode", () => {
  it("renders each nested owner band under its priority band, with that band's rows", () => {
    renderGroupedTable(false);

    const outline = paintedOutline();
    const highIndex = outline.indexOf("band:High2");
    const adaIndex = outline.indexOf("band:Ada Lovelace1");

    expect(highIndex).toBeGreaterThanOrEqual(0);
    expect(adaIndex).toBe(highIndex + 1);
    expect(outline[adaIndex + 1]).toContain("Apollo");
  });

  it("paints every project exactly once across the two levels", () => {
    renderGroupedTable(false);

    const projectRows = paintedOutline().filter(
      (entry) => !entry.startsWith("band:")
    );

    expect(projectRows).toHaveLength(ROWS.length);
    for (const project of ROWS) {
      expect(
        projectRows.filter((entry) => entry.includes(project.name))
      ).toHaveLength(1);
    }
  });

  it("keeps an empty nested band when the host asks to show empty subgroups", () => {
    // Priority as the SECOND dimension has a fixed vocabulary, so a band with no
    // project at that priority is a real empty subgroup. Showing it is the
    // behavior the flattening dropped — a reader could not see the dimension was
    // complete — and hiding it must still drop it.
    renderOwnerGroupedTable(true);

    expect(paintedOutline()).toContain("band:Urgent0");
  });

  it("drops that empty nested band when the host asks to hide empty subgroups", () => {
    renderOwnerGroupedTable(false);

    expect(paintedOutline()).not.toContain("band:Urgent0");
    // The sibling that DOES hold a row is still there, so the case above is not
    // passing merely because nothing rendered.
    expect(paintedOutline()).toContain("band:High1");
  });

  it("names the unowned and no-priority bands rather than dropping those rows", () => {
    const groups = buildProjectGroups({
      groupBy: "priority",
      groupOrder: "custom",
      rows: [row({ id: "9", name: "Drifter" })],
      secondaryGroupBy: "owner",
      secondaryGroupOrder: "custom",
      showEmptyGroups: false,
      showEmptySubgroups: false,
    });
    render(
      <ProjectsTable
        groups={groups}
        rows={[row({ id: "9", name: "Drifter" })]}
      />
    );

    expect(bandHeader(UNOWNED_GROUP_KEY)).toBeTruthy();
    expect(groups?.some((group) => group.key === NO_PRIORITY_GROUP_KEY)).toBe(
      true
    );
    expect(paintedOutline().some((entry) => entry.includes("Drifter"))).toBe(
      true
    );
  });
});
