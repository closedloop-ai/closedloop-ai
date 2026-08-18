import {
  buildGridTableCardFields,
  GridTable,
  type GridTableColumn,
  type GridTableGroup,
  ROW_ACTIONS_COLUMN,
} from "@repo/design-system/components/ui/grid-table";
import {
  AriaSort,
  type SortDirection,
} from "@repo/design-system/components/ui/sortable-column-header";
import { TableGridHeader } from "@repo/design-system/components/ui/table-grid-header";
import { render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it } from "vitest";

/**
 * ISS-4672: the design-system `GridTable` primitive has no test runner of its
 * own, so its ARIA table semantics are exercised here (its `@repo/app`
 * consumer), alongside the reorder and resize tests. `GridTable` renders `div`s
 * with CSS `grid`, so nothing a native `<table>` gives for free exists
 * implicitly — the assertions below pin the STRUCTURE (which element owns which)
 * rather than the mere presence of a role somewhere in the DOM, because a role
 * that is present but not owned by its required parent announces nothing.
 */

type Row = { id: string; name: string; owner: string; status: string };

const ROWS: Row[] = [
  { id: "1", name: "Alpha", owner: "ada", status: "Active" },
  { id: "2", name: "Beta", owner: "linus", status: "Done" },
];

const COLUMNS: GridTableColumn[] = [
  { id: "owner", label: "Owner", sortable: true },
  { id: "status", label: "Status" },
];

// The trailing row-actions column every dense table ships: no visible label, but
// a real grid track, so it must still name itself to assistive tech. Asserted
// through the shared design-system spec the four production tables spread, so a
// change to its name or id is caught here rather than per table.
const ACTIONS_COLUMN: GridTableColumn = ROW_ACTIONS_COLUMN;

const GRID_TEMPLATE = "minmax(200px, 1fr) 120px 120px";

// Leading (Name) column + the two data columns above.
const COLUMN_COUNT = 3;
const HEADER_ROW_COUNT = 1;

const GROUPS: GridTableGroup<Row>[] = [
  { key: "active", label: "Active", items: [ROWS[0]] },
  { key: "done", label: "Done", items: [ROWS[1]] },
];

/**
 * The axe rules that decide whether a div-based grid is a real table to a screen
 * reader: the role hierarchy itself (a `cell` must be owned by a `row`, a `row`
 * by a `table`/`rowgroup`) plus the validity of the index/span attributes that
 * pair a cell to its column header. Scoped deliberately — this test owns table
 * semantics, not the whole WCAG surface.
 *
 * axe traverses through role-less wrapper `div`s the way a browser's
 * accessibility tree does, so it will NOT catch a row that has drifted under an
 * intermediate container. That case is pinned by the explicit `parentElement`
 * assertions below; axe covers the complementary half (disallowed children,
 * orphaned roles, invalid index/span attributes).
 */
const ARIA_STRUCTURE_RULES = [
  "aria-allowed-attr",
  "aria-allowed-role",
  "aria-required-children",
  "aria-required-parent",
  "aria-valid-attr-value",
];
// Deliberately NOT in the list: axe's best-practice `empty-table-header`, which
// keys on VISIBLE text rather than the accessible name, so it flags the
// row-actions column even once `ariaLabel` names it. Naming that column is
// asserted directly below (by accessible name) instead — and the failing side of
// that contract (a blank column with NO name) has its own regression case below.

function noop() {
  // Sorting is asserted through `aria-sort`, never by invoking the callback.
}

// One CSS grid track per rendered column (lead + each data column), so a test
// that adds a fourth column gets a fourth track instead of the fourth cell
// wrapping onto an implicit grid row. `aria-colindex`/`aria-colcount` derive from
// the column COUNT, not the template, but a matching track count keeps the DOM
// the assertions read honest.
function gridTemplateFor(columns: readonly GridTableColumn[]): string {
  return ["minmax(200px, 1fr)", ...columns.map(() => "120px")].join(" ");
}

function renderGridTable(
  options: {
    columns?: GridTableColumn[];
    groups?: GridTableGroup<Row>[];
    sortBy?: string;
    sortDir?: SortDirection;
  } = {}
) {
  const columns = options.columns ?? COLUMNS;
  return render(
    <GridTable<Row>
      columns={columns}
      getRowId={(row) => row.id}
      gridTemplateColumns={gridTemplateFor(columns)}
      groups={options.groups}
      items={ROWS}
      leadingLabel="Name"
      leadingSortKey="name"
      onSort={noop}
      renderCell={(columnId, row) =>
        columnId === "owner" ? row.owner : row.status
      }
      renderLead={(row) => <span>{row.name}</span>}
      sortBy={options.sortBy ?? null}
      sortDir={options.sortDir ?? "asc"}
    />
  );
}

async function getAriaStructureViolations(container: Element) {
  const results = await axe.run(container, {
    resultTypes: ["violations"],
    runOnly: { type: "rule", values: ARIA_STRUCTURE_RULES },
  });
  return results.violations.map((violation) => ({
    id: violation.id,
    targets: violation.nodes.map((node) => node.target.join(" ")),
  }));
}

describe("GridTable ARIA table semantics", () => {
  it("owns every row from the table and every cell from its row", () => {
    renderGridTable();

    const table = screen.getByRole("table");
    expect(table).toHaveAttribute("aria-colcount", String(COLUMN_COUNT));

    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(HEADER_ROW_COUNT + ROWS.length);
    // Ownership, not mere presence: a row nested under some intermediate div
    // would still be found by `getAllByRole` but would not be owned by the
    // table, so it would announce as a loose group of text.
    for (const row of rows) {
      expect(row.parentElement).toBe(table);
    }

    const [headerRow, firstBodyRow] = rows;
    const bodyCells = within(firstBodyRow).getAllByRole("cell");
    expect(bodyCells).toHaveLength(COLUMN_COUNT);
    for (const cell of bodyCells) {
      expect(cell.parentElement).toBe(firstBodyRow);
    }
    // The header row must expose column headers, never generic cells.
    expect(within(headerRow).queryAllByRole("cell")).toHaveLength(0);
  });

  it("pairs each body cell with the column header in the same track", () => {
    renderGridTable();

    const rows = within(screen.getByRole("table")).getAllByRole("row");
    const headerCells = within(rows[0]).getAllByRole("columnheader");
    const bodyCells = within(rows[1]).getAllByRole("cell");

    expect(
      headerCells.map((cell) => cell.getAttribute("aria-colindex"))
    ).toEqual(["1", "2", "3"]);
    expect(bodyCells.map((cell) => cell.getAttribute("aria-colindex"))).toEqual(
      ["1", "2", "3"]
    );

    // The pairing itself: resolving each body cell through its `aria-colindex`
    // must land on the header a screen reader would announce with it — the
    // "Status, Active" association the plain divs could not express.
    const headerByColIndex = new Map(
      headerCells.map((cell) => [cell.getAttribute("aria-colindex"), cell])
    );
    expect(
      bodyCells.map((cell) => [
        headerByColIndex.get(cell.getAttribute("aria-colindex"))?.textContent,
        cell.textContent,
      ])
    ).toEqual([
      ["Name", "Alpha"],
      ["Owner", "ada"],
      ["Status", "Active"],
    ]);
  });

  it("names a visually label-less column instead of exposing a blank header", () => {
    // Four columns (Name lead + Owner + Status + Actions) and a matching
    // four-track template, so the action cell is a real fourth grid cell rather
    // than one wrapped onto an implicit row where the count/index drift this test
    // claims to cover would go unnoticed.
    renderGridTable({ columns: [...COLUMNS, ACTIONS_COLUMN] });

    const gridTable = screen.getByRole("table");
    // aria-colcount counts every track including the label-less one.
    expect(gridTable).toHaveAttribute("aria-colcount", "4");

    const rows = within(gridTable).getAllByRole("row");
    const headerCells = within(rows[0]).getAllByRole("columnheader");
    const bodyCells = within(rows[1]).getAllByRole("cell");
    // The full 1-through-4 sequence on BOTH the header and the body, so a
    // dropped/duplicated track shifts one side and fails here.
    expect(
      headerCells.map((cell) => cell.getAttribute("aria-colindex"))
    ).toEqual(["1", "2", "3", "4"]);
    expect(bodyCells.map((cell) => cell.getAttribute("aria-colindex"))).toEqual(
      ["1", "2", "3", "4"]
    );

    const actionsHeader = within(rows[0]).getByRole("columnheader", {
      name: ACTIONS_COLUMN.ariaLabel,
    });
    // Named for assistive tech, still blank on screen.
    expect(actionsHeader).toHaveTextContent("");
    // And it is the header the trailing body cell resolves against, so those
    // cells are announced under "Actions" rather than an empty column.
    expect(bodyCells.at(-1)).toHaveAttribute(
      "aria-colindex",
      actionsHeader.getAttribute("aria-colindex")
    );
  });

  it("leaves a labeled column's visible text as its accessible name", () => {
    renderGridTable({
      columns: [{ id: "status", label: "Status", ariaLabel: "Ignored" }],
    });

    const rows = within(screen.getByRole("table")).getAllByRole("row");
    // `ariaLabel` must never override a visible label — the two would disagree.
    expect(
      within(rows[0]).getByRole("columnheader", { name: "Status" })
    ).not.toHaveAttribute("aria-label");
  });

  it("announces sort state only on the columns that can be sorted", () => {
    renderGridTable({ sortBy: "owner", sortDir: "desc" });

    const rows = within(screen.getByRole("table")).getAllByRole("row");
    const [leadHeader, ownerHeader, statusHeader] = within(
      rows[0]
    ).getAllByRole("columnheader");

    expect(ownerHeader).toHaveAttribute("aria-sort", AriaSort.Descending);
    // Sortable but not the active sort — must read as sortable-and-unsorted.
    expect(leadHeader).toHaveAttribute("aria-sort", AriaSort.None);
    // Status has no sort key, so it must not advertise a sort control at all.
    expect(statusHeader).not.toHaveAttribute("aria-sort");
  });

  it("leaves a blank-label column without an ariaLabel with no accessible name", () => {
    // The label-less-column contract, pinned from the failing side: a blank
    // `label` with NO `ariaLabel` produces a `columnheader` with no accessible
    // name at all — the exact hole this PR closes. This is what the two prototype
    // callers used to ship (`installed` / `actions`); it is asserted here so a
    // regression that reintroduces a blank-label column without a name is caught,
    // rather than relying on every caller to remember the rule.
    const unnamedColumn: GridTableColumn = { id: "actions", label: "" };
    renderGridTable({ columns: [...COLUMNS, unnamedColumn] });

    const headerCells = within(screen.getByRole("table")).getAllByRole(
      "row"
    )[0];
    const trailingHeader = within(headerCells)
      .getAllByRole("columnheader")
      .at(-1);
    // No visible text AND no `aria-label`, so the `columnheader` has an empty
    // accessible name — nothing for a screen reader to announce the column by.
    expect(trailingHeader).toHaveTextContent("");
    expect(trailingHeader).not.toHaveAttribute("aria-label");
  });

  it("keeps a collapsible group header inside the table's reading order", () => {
    renderGridTable({ groups: GROUPS });

    const table = screen.getByRole("table");
    const rowGroups = within(table).getAllByRole("rowgroup");
    expect(rowGroups).toHaveLength(GROUPS.length);
    // Direct ownership is the safeguard axe cannot provide (it walks THROUGH
    // role-less wrappers): each rowgroup must be a direct child of the table, or
    // the group and its rows drift out of the table's reading order silently.
    for (const rowGroup of rowGroups) {
      expect(rowGroup.parentElement).toBe(table);
    }

    const firstGroupRows = within(rowGroups[0]).getAllByRole("row");
    expect(firstGroupRows).toHaveLength(
      HEADER_ROW_COUNT + GROUPS[0].items.length
    );
    // And each row in the group is owned directly by the rowgroup, not nested
    // under an intermediate container the accessibility tree would flatten away.
    for (const row of firstGroupRows) {
      expect(row.parentElement).toBe(rowGroups[0]);
    }

    const groupHeaderCell = within(firstGroupRows[0]).getByRole("cell");
    expect(groupHeaderCell.parentElement).toBe(firstGroupRows[0]);
    expect(groupHeaderCell).toHaveAttribute(
      "aria-colspan",
      String(COLUMN_COUNT)
    );
    // The disclosure is still a real disclosure inside that cell.
    expect(within(groupHeaderCell).getByRole("button")).toHaveAttribute(
      "aria-expanded",
      "true"
    );
  });

  it("passes the axe ARIA-structure rules flat and grouped", async () => {
    // Both renders carry the label-less row-actions column, so `empty-table-header`
    // is actually exercised rather than vacuously clean.
    const columns = [...COLUMNS, ACTIONS_COLUMN];

    const flat = renderGridTable({ columns });
    const flatViolations = await getAriaStructureViolations(flat.container);
    flat.unmount();

    const grouped = renderGridTable({ columns, groups: GROUPS });
    const groupedViolations = await getAriaStructureViolations(
      grouped.container
    );

    expect(flatViolations).toEqual([]);
    expect(groupedViolations).toEqual([]);
  });

  it("emits no orphan row/columnheader when the header is rendered standalone", () => {
    // The Documents tree renders `TableGridHeader` outside any `role="table"`
    // wrapper. Emitting roles there would create an `aria-required-parent`
    // violation, so the semantics stay opt-in via `insideAriaTable`.
    render(
      <TableGridHeader
        columns={COLUMNS}
        gridTemplateColumns={GRID_TEMPLATE}
        onSort={noop}
        sortBy={null}
        sortDir="asc"
      />
    );

    expect(screen.queryByRole("row")).toBeNull();
    expect(screen.queryAllByRole("columnheader")).toHaveLength(0);
    // The labels still render — only the roles are withheld.
    expect(screen.getByText("Status")).toBeInTheDocument();
  });
});

describe("buildGridTableCardFields card term", () => {
  const CARD_COLUMNS: GridTableColumn[] = [
    { id: "owner", label: "Owner" },
    // A label-less column carrying an accessible name for the grid track — the
    // shape `ROW_ACTIONS_COLUMN` ships. It must NOT lend that aria name to the
    // card body as a visible `dt` term (ISS-4672).
    { id: "actions", label: "", ariaLabel: "Actions" },
    // A label-less column the caller opts into the card body with a real,
    // human-visible term via `cardLabel`.
    { id: "installed", label: "", cardLabel: "Installed" },
  ];
  const renderCell = (columnId: string) => `cell:${columnId}`;

  it("does not borrow a column's ariaLabel as its card dt term", () => {
    // `ariaLabel` names the grid track for assistive tech; on the narrow card
    // (no header row) it is not a value worth a visible label, so it must not
    // become the `dt` term — the term stays blank instead.
    const [, actionsField] = buildGridTableCardFields(
      CARD_COLUMNS,
      new Set<string>(),
      renderCell,
      {}
    );

    expect(actionsField.key).toBe("actions");
    expect(actionsField.label).toBe("");
  });

  it("uses cardLabel as the visible dt term for a label-less column", () => {
    const [, , installedField] = buildGridTableCardFields(
      CARD_COLUMNS,
      new Set<string>(),
      renderCell,
      {}
    );

    expect(installedField.key).toBe("installed");
    expect(installedField.label).toBe("Installed");
  });

  it("keeps a visible label as the dt term and ignores cardLabel", () => {
    // A column with a real `label` already reads on the card; `cardLabel` is a
    // fallback for the label-less case only and must never override it.
    const [ownerField] = buildGridTableCardFields(
      [{ id: "owner", label: "Owner", cardLabel: "Ignored" }],
      new Set<string>(),
      renderCell,
      {}
    );

    expect(ownerField.label).toBe("Owner");
  });

  it("drops excluded columns from the card body entirely", () => {
    // The four production tables promote actions into the card header and
    // exclude the column, so the aria-name fallback was never reached in
    // practice — an excluded column contributes no field at all.
    const fields = buildGridTableCardFields(
      CARD_COLUMNS,
      new Set(["actions"]),
      renderCell,
      {}
    );

    expect(fields.map((field) => field.key)).toEqual(["owner", "installed"]);
  });
});
