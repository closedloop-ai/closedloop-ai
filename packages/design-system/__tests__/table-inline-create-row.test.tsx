import {
  GridTableV2,
  type GridTableV2Column,
  type GridTableV2Group,
} from "@closedloop-ai/design-system/components/ui/grid-table-v2";
import { TableInlineCreateRow } from "@closedloop-ai/design-system/components/ui/table-inline-create-row";
import { AFTER_ROWS_ROW_ID } from "@closedloop-ai/design-system/lib/grid-table-v2-after-row";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { Fragment, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const GRID_TEMPLATE_COLUMNS = "36px minmax(260px, 1fr)";

describe("TableInlineCreateRow", () => {
  it("trims and commits a non-empty title with Enter", () => {
    const onCommit = vi.fn();
    render(
      <TableInlineCreateRow
        active
        gridTemplateColumns={GRID_TEMPLATE_COLUMNS}
        label="Add artifact"
        onActivate={vi.fn()}
        onCancel={vi.fn()}
        onCommit={onCommit}
      />
    );

    const input = screen.getByRole("textbox", { name: "Add artifact name" });
    fireEvent.change(input, { target: { value: "  Portable surface  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith("Portable surface");
  });

  it("cancels the editor with Escape", () => {
    const onCancel = vi.fn();
    render(
      <TableInlineCreateRow
        active
        gridTemplateColumns={GRID_TEMPLATE_COLUMNS}
        label="Add artifact"
        onActivate={vi.fn()}
        onCancel={onCancel}
        onCommit={vi.fn()}
      />
    );

    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "Add artifact name" }),
      { key: "Escape" }
    );
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  // The opposite state of the `role="row"` assertions in the grid suite below:
  // outside a grid nothing owns a row, so publishing one would recreate the
  // orphan in the accessibility tree that those roles exist to remove.
  it("publishes no row or gridcell role outside a grid", () => {
    render(
      <TableInlineCreateRow
        active={false}
        gridTemplateColumns={GRID_TEMPLATE_COLUMNS}
        label="Add artifact"
        onActivate={vi.fn()}
        onCancel={vi.fn()}
        onCommit={vi.fn()}
      />
    );

    expect(screen.queryAllByRole("row")).toHaveLength(0);
    expect(screen.queryAllByRole("gridcell")).toHaveLength(0);
    expect(
      screen.getByRole("button", { name: "Add artifact" })
    ).toBeInTheDocument();
  });
});

/**
 * ISS-8219. `renderAfterRows` / `renderAfterGroup` insert this row UNDER the
 * `role="grid"`, where a plain `<div>` is an orphan generic and assistive tech
 * never sees a row at all. The roles alone are not the fix: a `row` whose
 * `aria-colindex` run does not line up with the header's misreports the table's
 * shape rather than being ignored, which is why every assertion here pins the
 * index VALUES against literals rather than counting elements.
 */

type Row = { id: string; name: string; owner: string; status: string };

const COLUMNS: GridTableV2Column[] = [
  { id: "owner", label: "Owner" },
  { id: "status", label: "Status" },
];

// Utility track + identity track + one per data column + the trailing Add-field
// track: the shape the Sessions grid actually renders.
const GRID_TEMPLATE = "36px minmax(200px, 1fr) 120px 120px 40px";

/**
 * The tracks that grid EXPOSES, written out rather than derived. A fixture that
 * computed these from the same helper the component numbers its cells with
 * could not fail the mutation it exists to catch. The trailing Add-field track
 * is the fifth of `aria-colcount` but is `aria-hidden` in a body row and
 * unnamed in the header, so neither run reports it.
 */
const HEADER_COLUMN_INDEXES = ["1", "2", "3", "4"];
const DATA_ROW_COLUMN_INDEXES = ["1", "2", "3", "4"];
/**
 * One cell: the affordance, in the second track. The empty track before it is
 * presentational — the row leaves it to the grid exactly as a section-header
 * row leaves the tracks it does not fill.
 */
const CREATE_ROW_COLUMN_INDEXES = ["2"];

const ROWS: Row[] = [
  { id: "alpha", name: "Alpha", owner: "ada", status: "Active" },
  { id: "beta", name: "Beta", owner: "linus", status: "Done" },
];

// TWO groups, each with its own create row. A single-group fixture cannot tell
// a create row that joined its own group's section apart from one numbered or
// parented from the grid's start.
const GROUPS: GridTableV2Group<Row>[] = [
  { key: "active", label: "Active", items: [ROWS[0] as Row] },
  { key: "done", label: "Done", items: [ROWS[1] as Row] },
];

/** Matches every group's create-row affordance, whose label names its group. */
const GROUP_CREATE_LABEL = /^Add to /;

function createRow(label: string) {
  return (
    <TableInlineCreateRow
      active={false}
      gridTemplateColumns={GRID_TEMPLATE}
      label={label}
      onActivate={vi.fn()}
      onCancel={vi.fn()}
      onCommit={vi.fn()}
    />
  );
}

function renderGrid(
  props: Partial<React.ComponentProps<typeof GridTableV2<Row>>>
) {
  return render(
    <GridTableV2<Row>
      columns={COLUMNS}
      getRowId={(row) => row.id}
      gridTemplateColumns={GRID_TEMPLATE}
      items={ROWS}
      leadingLabel="Name"
      renderCell={(columnId, row) =>
        columnId === "owner" ? row.owner : row.status
      }
      renderLead={(row) => <span>{row.name}</span>}
      renderLeadingUtility={() => <span>star</span>}
      showGroupCounts={false}
      trailingHeader={<span>add field</span>}
      {...props}
    />
  );
}

/** What kind of row this is, so a whole body can be asserted in one list. */
function describeRow(row: HTMLElement): string {
  if (row.hasAttribute("data-inline-create-row")) {
    return "create";
  }
  if (within(row).queryAllByRole("columnheader").length > 0) {
    return "header";
  }
  const rowId = row.getAttribute("data-grid-row-id");
  return rowId ? `row:${rowId}` : `group:${row.textContent}`;
}

function columnIndexesOf(row: HTMLElement): (string | null)[] {
  return within(row)
    .getAllByRole("gridcell")
    .map((cell) => cell.getAttribute("aria-colindex"));
}

function navigableCells(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-grid-cell]"));
}

/** The create row's single navigable cell — its affordance. */
function createRowContentCell(): HTMLElement {
  const cells = document.querySelectorAll<HTMLElement>(
    "[data-inline-create-row] [data-grid-cell]"
  );
  if (cells.length !== 1) {
    throw new Error(`expected 1 create-row cell, got ${cells.length}`);
  }
  return cells[0] as HTMLElement;
}

describe("TableInlineCreateRow inside GridTableV2", () => {
  it("numbers the ungrouped create row's cells against the header's column run", () => {
    renderGrid({ renderAfterRows: createRow("Add artifact") });

    const grid = screen.getByRole("grid");
    expect(grid).toHaveAttribute("aria-colcount", "5");

    const rows = within(grid).getAllByRole("row");
    expect(rows.map(describeRow)).toEqual([
      "header",
      "row:alpha",
      "row:beta",
      "create",
    ]);

    const [headerRow, alpha, beta, create] = rows as HTMLElement[];
    expect(
      within(headerRow)
        .getAllByRole("columnheader")
        .map((cell) => cell.getAttribute("aria-colindex"))
    ).toEqual(HEADER_COLUMN_INDEXES);
    expect(columnIndexesOf(alpha)).toEqual(DATA_ROW_COLUMN_INDEXES);
    expect(columnIndexesOf(beta)).toEqual(DATA_ROW_COLUMN_INDEXES);
    expect(columnIndexesOf(create)).toEqual(CREATE_ROW_COLUMN_INDEXES);
    // No cell claims a span: each occupies exactly the one track it paints, so
    // what a screen reader reports is what is on screen. The data rows are the
    // same, which is what makes the two runs comparable at all.
    expect(
      [
        ...within(create).getAllByRole("gridcell"),
        ...within(alpha).getAllByRole("gridcell"),
      ].map((cell) => cell.getAttribute("aria-colspan"))
    ).toEqual([null, null, null, null, null]);
  });

  // A grid with no leading utility column still puts the affordance in the
  // SECOND track — the row has always painted an empty one first — so its cells
  // must be numbered from the track they occupy, not from the grid's identity
  // column, which here is track 1.
  it("numbers the same two tracks in a grid with no leading utility column", () => {
    renderGrid({
      renderAfterRows: createRow("Add artifact"),
      renderLeadingUtility: undefined,
    });

    const grid = screen.getByRole("grid");
    expect(grid).toHaveAttribute("aria-colcount", "4");
    const rows = within(grid).getAllByRole("row");
    expect(rows.map(describeRow)).toEqual([
      "header",
      "row:alpha",
      "row:beta",
      "create",
    ]);
    expect(columnIndexesOf(rows[3] as HTMLElement)).toEqual(
      CREATE_ROW_COLUMN_INDEXES
    );
  });

  it("closes each group's section with its own create row, numbered identically", () => {
    renderGrid({
      groups: GROUPS,
      items: [],
      renderAfterGroup: (group) => createRow(`Add to ${group.label}`),
    });

    const grid = screen.getByRole("grid");
    // The create row lands at the END of its OWN group's section — numbering or
    // parenting it from the grid's start would move it out of this order.
    expect(within(grid).getAllByRole("row").map(describeRow)).toEqual([
      "header",
      "group:Active",
      "row:alpha",
      "create",
      "group:Done",
      "row:beta",
      "create",
    ]);

    const sections = within(grid).getAllByRole("rowgroup");
    expect(sections).toHaveLength(2);
    for (const section of sections) {
      const create = within(section)
        .getAllByRole("row")
        .filter((row) => row.hasAttribute("data-inline-create-row"));
      expect(create).toHaveLength(1);
      expect(columnIndexesOf(create[0] as HTMLElement)).toEqual(
        CREATE_ROW_COLUMN_INDEXES
      );
    }

    // Distinct ids per group, which is what keeps the two create rows from
    // sharing one roving-tabindex key and stealing focus from each other.
    const ids = Array.from(
      document.querySelectorAll<HTMLElement>("[data-inline-create-row]")
    ).map((row) => row.getAttribute("data-grid-row-id"));
    expect(new Set(ids).size).toBe(2);
    expect(ids.filter((id) => id === null)).toEqual([]);
  });

  it("joins the roving tab stop from inside a group's section", () => {
    renderGrid({
      groups: GROUPS,
      items: [],
      renderAfterGroup: (group) => createRow(`Add to ${group.label}`),
    });

    const cells = navigableCells();
    const secondGroupsAffordance = cells.at(-1);
    if (!secondGroupsAffordance) {
      throw new Error("expected the last group's create-row cell");
    }
    fireEvent.focus(secondGroupsAffordance);

    expect(secondGroupsAffordance.tabIndex).toBe(0);
    expect(cells.filter((cell) => cell.tabIndex === 0)).toHaveLength(1);
  });

  it("drops a collapsed group's create row from the grid and its tab stops", () => {
    renderGrid({
      groups: GROUPS,
      items: [],
      renderAfterGroup: (group) => createRow(`Add to ${group.label}`),
    });

    const grid = screen.getByRole("grid");
    expect(
      within(grid).getAllByRole("button", { name: GROUP_CREATE_LABEL })
    ).toHaveLength(2);

    fireEvent.click(within(grid).getByRole("button", { name: "Active" }));

    expect(
      within(grid).getAllByRole("button", { name: GROUP_CREATE_LABEL })
    ).toHaveLength(1);
    // The collapsed group's cells leave the tab-stop keyset with its rows.
    expect(navigableCells()).toHaveLength(5);
    expect(navigableCells().filter((cell) => cell.tabIndex === 0)).toHaveLength(
      1
    );
  });

  it("numbers an after-item create row against the same column run", () => {
    renderGrid({
      renderAfterItem: (row) =>
        row.id === "alpha" ? createRow("Add after Alpha") : null,
    });

    const grid = screen.getByRole("grid");
    expect(within(grid).getAllByRole("row").map(describeRow)).toEqual([
      "header",
      "row:alpha",
      "create",
      "row:beta",
    ]);
    expect(
      columnIndexesOf(within(grid).getAllByRole("row")[2] as HTMLElement)
    ).toEqual(CREATE_ROW_COLUMN_INDEXES);
  });

  it("joins the grid's single roving tab stop", () => {
    renderGrid({ renderAfterRows: createRow("Add artifact") });

    const cells = navigableCells();
    // 2 data rows x 4 navigable cells, plus the create row's affordance. (The
    // trailing Add-field cell is inert in a body row.)
    expect(cells).toHaveLength(9);
    expect(cells.filter((cell) => cell.tabIndex === 0)).toHaveLength(1);
    expect(cells[0]?.tabIndex).toBe(0);

    const content = createRowContentCell();
    fireEvent.focus(content);
    expect(content.tabIndex).toBe(0);
    expect(cells.filter((cell) => cell.tabIndex === 0)).toHaveLength(1);
  });

  // A conditional slot stops painting while its cell holds the roving tab stop.
  // Registering a key per rendered ITEM rather than per PAINTED node left that
  // key live, so the remembered cell kept matching a cell nothing renders and
  // every cell in the grid fell to tabIndex -1 — the grid left the tab order.
  it("keeps a tab stop when a conditional after-item row stops painting", () => {
    const { rerender } = renderGrid({
      renderAfterItem: (row) =>
        row.id === "alpha" ? createRow("Add after Alpha") : null,
    });
    fireEvent.focus(createRowContentCell());
    expect(navigableCells().filter((cell) => cell.tabIndex === 0)).toHaveLength(
      1
    );

    rerender(
      <GridTableV2<Row>
        columns={COLUMNS}
        getRowId={(row) => row.id}
        gridTemplateColumns={GRID_TEMPLATE}
        items={ROWS}
        leadingLabel="Name"
        renderAfterItem={() => null}
        renderCell={(columnId, row) =>
          columnId === "owner" ? row.owner : row.status
        }
        renderLead={(row) => <span>{row.name}</span>}
        renderLeadingUtility={() => <span>star</span>}
        showGroupCounts={false}
        trailingHeader={<span>add field</span>}
      />
    );

    expect(document.querySelectorAll("[data-inline-create-row]")).toHaveLength(
      0
    );
    expect(navigableCells().filter((cell) => cell.tabIndex === 0)).toHaveLength(
      1
    );
  });

  it("is the tab stop when it is the body's only row", () => {
    renderGrid({ items: [], renderAfterRows: createRow("Add artifact") });

    const cells = navigableCells();
    expect(cells).toEqual([createRowContentCell()]);
    expect(cells.filter((cell) => cell.tabIndex === 0)).toHaveLength(1);
  });

  it("is reachable by ArrowDown from a data column it paints no cell for", () => {
    renderGrid({ renderAfterRows: createRow("Add artifact") });

    // The last data row's Status cell — track 4, past the create row's two.
    const status = navigableCells()[7];
    if (!status) {
      throw new Error("expected the second row's status cell");
    }
    fireEvent.keyDown(status, { key: "ArrowDown" });

    expect(document.activeElement).toBe(createRowContentCell());
  });

  // The reverse of the move above, and the one an index-wise resolution gets
  // wrong: the affordance is DOM cell 0 of its row but declares column 2, so
  // leaving by index lands on column 1 — the favorite/utility cell, a track to
  // the left of where the user was. A row-wise move keeps its column.
  it("returns to the column it declares when ArrowUp leaves the create row", () => {
    renderGrid({ renderAfterRows: createRow("Add artifact") });

    const content = createRowContentCell();
    fireEvent.focus(content);
    fireEvent.keyDown(content, { key: "ArrowUp" });

    const beta = within(screen.getByRole("grid")).getAllByRole("row")[2];
    if (!beta) {
      throw new Error("expected the second data row");
    }
    const [utility, lead] = within(beta).getAllByRole("gridcell");
    expect(document.activeElement).toBe(lead);
    expect(document.activeElement).not.toBe(utility);
    expect(lead).toHaveAttribute("aria-colindex", CREATE_ROW_COLUMN_INDEXES[0]);
    expect(within(lead as HTMLElement).getByText("Beta")).toBeInTheDocument();
  });

  // Closes the round trip: the column the create row is left by is the column it
  // is re-entered from, so a user walking up and back down stays in one track.
  it("is re-entered from the same column by ArrowDown", () => {
    renderGrid({ renderAfterRows: createRow("Add artifact") });

    const beta = within(screen.getByRole("grid")).getAllByRole("row")[2];
    if (!beta) {
      throw new Error("expected the second data row");
    }
    const lead = within(beta).getAllByRole("gridcell")[1];
    if (!lead) {
      throw new Error("expected the second data row's identity cell");
    }
    fireEvent.keyDown(lead, { key: "ArrowDown" });

    expect(document.activeElement).toBe(createRowContentCell());
  });

  // A slot may decline with more than `null`. React paints nothing for `true`,
  // for an empty array, or for a childless fragment either — and a key
  // registered for one of those stays live while no cell renders it, so the
  // remembered cell matches nothing, every real cell compares unequal, and the
  // whole grid drops to tabIndex -1 and leaves the tab order.
  it.each([
    ["a boolean", true],
    ["an empty array", []],
    ["an empty fragment", <Fragment key="empty" />],
  ])("keeps a tab stop when a create row degrades to %s", (_label, empty) => {
    const { rerender } = renderGrid({
      renderAfterItem: (row) =>
        row.id === "alpha" ? createRow("Add after Alpha") : null,
    });
    fireEvent.focus(createRowContentCell());

    rerender(
      <GridTableV2<Row>
        columns={COLUMNS}
        getRowId={(row) => row.id}
        gridTemplateColumns={GRID_TEMPLATE}
        items={ROWS}
        leadingLabel="Name"
        renderAfterItem={() => empty as ReactNode}
        renderCell={(columnId, row) =>
          columnId === "owner" ? row.owner : row.status
        }
        renderLead={(row) => <span>{row.name}</span>}
        renderLeadingUtility={() => <span>star</span>}
        showGroupCounts={false}
        trailingHeader={<span>add field</span>}
      />
    );

    expect(document.querySelectorAll("[data-inline-create-row]")).toHaveLength(
      0
    );
    expect(navigableCells().filter((cell) => cell.tabIndex === 0)).toHaveLength(
      1
    );
  });

  // Nothing reserves the after-row id namespace from `getRowId`, so a caller's
  // own row may carry the sentinel's exact id. The two rows must still be two
  // cells: sharing one roving-tabindex key puts BOTH at tabIndex 0, which is the
  // grid's single-tab-stop contract broken.
  it("keeps one tab stop when a data row id collides with the after-rows id", () => {
    renderGrid({
      items: [{ id: AFTER_ROWS_ROW_ID, name: "Collider", ...COLLIDER_FIELDS }],
      renderAfterRows: createRow("Add artifact"),
    });

    fireEvent.focus(createRowContentCell());

    expect(navigableCells().filter((cell) => cell.tabIndex === 0)).toEqual([
      createRowContentCell(),
    ]);
  });
});

/** The non-identity half of the colliding fixture row, which only needs to exist. */
const COLLIDER_FIELDS = { owner: "ada", status: "Active" } as const;
