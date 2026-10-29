import {
  GridTable,
  type GridTableColumn,
} from "@closedloop-ai/design-system/components/ui/grid-table";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

/**
 * ISS-6631: the first test this package has ever been able to run in its OWN
 * lane. `GridTable` is the shared table behind Sessions and Branches on both
 * surfaces and the highest fix-density file here.
 *
 * It is not the component's only coverage, and this is not the place to add a
 * fourth copy of what exists. `packages/app/shared/lib/__tests__/` owns its ARIA
 * semantics, reorder, and resize; `apps/storybook/stories/grid-table.stories.tsx`
 * is executed by `apps/storybook/__tests__/story-sweep.test.tsx`, and its
 * `playColumnOrderAlignment` helper already pins header/body column alignment by
 * `data-column-id`. What had no home was the plainest thing of all — that the
 * rows and cells a caller passes come out as the text a reader sees — because
 * this package had no runner at all. That is what this covers.
 *
 * The assertion is the whole rendered text MATRIX, not a spot check for a string
 * somewhere in the DOM: a `getByText("Alpha")` would still pass with a row
 * dropped, a column dropped, the two data columns swapped, or `renderCell`
 * ignoring its `columnId` and painting one value into every track. Reading each
 * cell through its own row pins all four.
 */

type Row = { id: string; name: string; owner: string; status: string };

const ROWS: Row[] = [
  { id: "1", name: "Alpha", owner: "ada", status: "Active" },
  { id: "2", name: "Beta", owner: "linus", status: "Done" },
  { id: "3", name: "Gamma", owner: "grace", status: "Blocked" },
];

const COLUMNS: GridTableColumn[] = [
  { id: "owner", label: "Owner" },
  { id: "status", label: "Status" },
];

// One CSS grid track per rendered column (lead + each data column), so a cell
// cannot wrap onto an implicit grid row and quietly change what the row reads.
const GRID_TEMPLATE = "minmax(200px, 1fr) 120px 120px";

const HEADER_ROW_COUNT = 1;

// Lead column + the two data columns above.
const EXPECTED_HEADERS = ["Name", "Owner", "Status"];

const EXPECTED_CELLS = [
  ["Alpha", "ada", "Active"],
  ["Beta", "linus", "Done"],
  ["Gamma", "grace", "Blocked"],
];

function renderGridTable() {
  return render(
    <GridTable<Row>
      columns={COLUMNS}
      getRowId={(row) => row.id}
      gridTemplateColumns={GRID_TEMPLATE}
      items={ROWS}
      leadingLabel="Name"
      renderCell={(columnId, row) =>
        columnId === "owner" ? row.owner : row.status
      }
      renderLead={(row) => <span>{row.name}</span>}
    />
  );
}

describe("GridTable", () => {
  it("renders one row per item with each column's own value in its own cell", () => {
    renderGridTable();

    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(HEADER_ROW_COUNT + ROWS.length);

    const [headerRow, ...bodyRows] = rows;
    expect(
      within(headerRow)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent)
    ).toEqual(EXPECTED_HEADERS);

    expect(
      bodyRows.map((row) =>
        within(row)
          .getAllByRole("cell")
          .map((cell) => cell.textContent)
      )
    ).toEqual(EXPECTED_CELLS);
  });
});
