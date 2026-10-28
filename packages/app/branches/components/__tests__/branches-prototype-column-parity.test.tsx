import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import type { BranchRow } from "../../lib/branch-row";
import { BRANCH_SAMPLE_ROWS } from "../../lib/branch-sample-data";
import { APPROVED_BRANCH_COLUMN_SPECS } from "../approved-branches-grid-adapter";
import { BranchesTable } from "../branches-table";

/** The source guard compares the actual prototype; this suite verifies rendering. */
const APPROVED_COLUMNS = APPROVED_BRANCH_COLUMN_SPECS;
/**
 * Widened deliberately: these are compared against the bare strings the DOM
 * hands back, not used as declaration keys.
 */
const APPROVED_COLUMN_IDS: string[] = APPROVED_COLUMNS.map(
  (column) => column.id
);

function sampleRow(): BranchRow {
  const base = BRANCH_SAMPLE_ROWS[0];
  if (!base) {
    throw new Error("BRANCH_SAMPLE_ROWS is empty");
  }
  return base;
}

function renderApprovedTable() {
  const row = sampleRow();
  return render(
    <AppCoreStoryProviders>
      <BranchesTable
        allRows={[row]}
        approved
        columnOrder={[]}
        columnWidths={{}}
        // The web host, which ships this table, opts in (ISS-10332).
        includePriorityColumn
        items={[row]}
        onColumnOrderChange={() => undefined}
        onColumnWidthChange={() => undefined}
        onSort={() => undefined}
        sortBy="lastActivity"
        sortDir="desc"
        visibleColumns={new Set(APPROVED_COLUMN_IDS)}
      />
    </AppCoreStoryProviders>
  );
}

describe("Branches approved column rendering (ISS-10265)", () => {
  it("renders those columns, in that order, on the shipped approved table", () => {
    // The arm that makes this a claim about the screen rather than the array:
    // the declaration could be reordered and the renderer could still paint its
    // own order, which no assertion over the constant can witness.
    renderApprovedTable();
    const rendered = screen
      .getAllByRole("columnheader")
      .map((header) => header.getAttribute("data-column-id"))
      .filter((id): id is string => id !== null);
    // The lead Name column is always shown and is not a toggleable data column,
    // so compare only the data columns the oracle covers.
    expect(rendered.filter((id) => APPROVED_COLUMN_IDS.includes(id))).toEqual(
      APPROVED_COLUMN_IDS
    );
  });

  it("paints the declared label for each of those headers", () => {
    renderApprovedTable();
    for (const column of APPROVED_COLUMNS) {
      expect(
        screen.getByRole("columnheader", { name: new RegExp(column.label) })
      ).toBeDefined();
    }
  });
});
