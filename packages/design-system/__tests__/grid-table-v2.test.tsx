import {
  GridTableV2,
  type GridTableV2Column,
  type GridTableV2Group,
} from "@closedloop-ai/design-system/components/ui/grid-table-v2";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * whitlockk review on PR #4984. The v2 candidate was copied from the
 * `generic-artifact` prototype, and in doing so re-shipped four defects the
 * production `GridTable` had already retired:
 *
 *  1. every cell was `tabIndex={0}` — hundreds of tab stops on a real table —
 *     instead of the WAI-ARIA grid pattern's single roving tab stop;
 *  2. the grid/row/cell roles and `aria-colindex` pairing were dropped, so a
 *     screen reader could not resolve a cell against its column header;
 *  3. ArrowUp/Down scoped its row query to the pressed row's `parentElement`,
 *     so it could not cross a group boundary;
 *  4. row lookups for keyboard navigation and group drops resolved against
 *     `items`, which the props contract documents as IGNORED when `groups` is
 *     supplied — so a caller passing `items={[]}` lost both.
 *
 * Each test below pins one of those. They render `GridTableV2` directly rather
 * than asserting on the shared `grid-table-navigation` helpers, because the
 * regression was never in those helpers — it was that this component did not
 * use them.
 */

type Row = { id: string; name: string; owner: string; status: string };

const COLUMNS: GridTableV2Column[] = [
  { id: "owner", label: "Owner" },
  { id: "status", label: "Status" },
];

// One CSS grid track per rendered column (lead + each data column).
const GRID_TEMPLATE = "minmax(200px, 1fr) 120px 120px";

const UNGROUPED_ROWS: Row[] = [
  { id: "1", name: "Alpha", owner: "ada", status: "Active" },
  { id: "2", name: "Beta", owner: "linus", status: "Done" },
];

// Two groups of one row each: the ONLY shape that can tell a body-scoped row
// walk apart from a parent-scoped one, because the boundary sits between the
// first group's only row and the second group's only row.
const GROUPS: GridTableV2Group<Row>[] = [
  {
    key: "active",
    label: "Active",
    items: [{ id: "1", name: "Alpha", owner: "ada", status: "Active" }],
  },
  {
    key: "done",
    label: "Done",
    items: [{ id: "2", name: "Beta", owner: "linus", status: "Done" }],
  },
];

function renderTable(
  props: Partial<React.ComponentProps<typeof GridTableV2<Row>>>
) {
  return render(
    <GridTableV2<Row>
      columns={COLUMNS}
      getRowId={(row) => row.id}
      gridTemplateColumns={GRID_TEMPLATE}
      items={UNGROUPED_ROWS}
      leadingLabel="Name"
      renderCell={(columnId, row) =>
        columnId === "owner" ? row.owner : row.status
      }
      renderLead={(row) => <span>{row.name}</span>}
      {...props}
    />
  );
}

/** Every focusable cell the grid painted, in visible DOM order. */
function getNavigableCells(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-grid-cell]"));
}

/**
 * Every attribute an element actually carries, sorted. Names only: the point is
 * which attributes EXIST, so a leaked `aria-level` fails whatever its value.
 */
function attributeNames(element: HTMLElement): string[] {
  return Array.from(element.attributes, (attribute) => attribute.name).sort();
}

describe("GridTableV2 accessibility semantics", () => {
  it("declares grid/row/cell roles with paired column indexes", () => {
    renderTable({});

    const grid = screen.getByRole("grid");
    // Lead column + the two data columns.
    expect(grid).toHaveAttribute("aria-colcount", "3");

    const [headerRow, ...bodyRows] = within(grid).getAllByRole("row");
    expect(
      within(headerRow)
        .getAllByRole("columnheader")
        .map((cell) => cell.getAttribute("aria-colindex"))
    ).toEqual(["1", "2", "3"]);

    // The header's and the body's numbering must agree track-for-track — that
    // pairing is the entire reason a screen reader can announce a cell as
    // "Status, Active" rather than a loose "Active".
    for (const row of bodyRows) {
      expect(
        within(row)
          .getAllByRole("gridcell")
          .map((cell) => cell.getAttribute("aria-colindex"))
      ).toEqual(["1", "2", "3"]);
    }
  });

  it("keeps exactly one cell in the tab order (roving tabindex)", () => {
    renderTable({});

    const cells = getNavigableCells();
    // 2 rows x 3 cells: every one was a tab stop before this fix.
    expect(cells).toHaveLength(6);
    expect(cells.filter((cell) => cell.tabIndex === 0)).toHaveLength(1);
    // Before the grid is entered, the entry point is the first row's lead cell.
    expect(cells[0]?.tabIndex).toBe(0);
  });

  it("does not report missing keys for fixed cells beside mapped cells", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    try {
      renderTable({});

      expect(
        consoleError.mock.calls.some((call) =>
          call.some(
            (argument) =>
              typeof argument === "string" &&
              argument.includes('unique "key" prop')
          )
        )
      ).toBe(false);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("moves the single tab stop with focus", () => {
    renderTable({});

    const cells = getNavigableCells();
    const secondCell = cells[1];
    if (!secondCell) {
      throw new Error("expected a second navigable cell");
    }
    fireEvent.focus(secondCell);

    expect(secondCell.tabIndex).toBe(0);
    expect(cells.filter((cell) => cell.tabIndex === 0)).toHaveLength(1);
  });

  // whitlockk review on PR #6005. The selection props (ISS-8067) let a host hold
  // several rows at once, and `aria-multiselectable` is the only thing that
  // tells assistive tech so — its default is false, which announces every
  // newly `aria-selected` row as having replaced the previous one.
  //
  // Three cases, one contract: the attribute must appear EXACTLY when a
  // selection callback is wired. Both arms are driven because either prop alone
  // makes the grid multi-selectable, so a test of one would stay green if the
  // other stopped counting; the case below them is what stops "always true"
  // from passing.
  it.each([
    ["onRowSelectionToggle", { onRowSelectionToggle: vi.fn() }],
    ["onSelectAllRows", { onSelectAllRows: vi.fn() }],
  ] as const)(
    "declares itself multi-selectable once %s is wired",
    (_name, props) => {
      renderTable(props);

      expect(screen.getByRole("grid")).toHaveAttribute(
        "aria-multiselectable",
        "true"
      );
    }
  );

  it("leaves the attribute off a grid with no selection callbacks", () => {
    renderTable({});

    expect(screen.getByRole("grid")).not.toHaveAttribute(
      "aria-multiselectable"
    );
  });

  it("wraps each group in a rowgroup whose header row spans every column", () => {
    renderTable({ groups: GROUPS, items: [] });

    const rowGroups = screen.getAllByRole("rowgroup");
    expect(rowGroups).toHaveLength(GROUPS.length);

    const groupHeaderCell = within(rowGroups[0] as HTMLElement).getAllByRole(
      "gridcell"
    )[0];
    expect(groupHeaderCell).toHaveAttribute("aria-colspan", "3");
  });
});

describe("GridTableV2 keyboard navigation", () => {
  it("crosses a group boundary on ArrowDown", () => {
    const onRowKeyboardNavigate = vi.fn();
    // `items={[]}` is the documented grouped-mode contract: the rows come from
    // `groups`, and resolving the destination against `items` used to silently
    // drop the callback here.
    renderTable({
      groups: GROUPS,
      items: [],
      onRowKeyboardNavigate,
    });

    const cells = getNavigableCells();
    const firstLeadCell = cells[0];
    if (!firstLeadCell) {
      throw new Error("expected a lead cell in the first group");
    }
    fireEvent.keyDown(firstLeadCell, { key: "ArrowDown" });

    // Focus left the last (only) row of group "active" and landed on the first
    // row of group "done" — impossible with a `row.parentElement`-scoped query,
    // which sees only siblings inside the same group wrapper.
    expect(document.activeElement).toBe(cells[3]);
    expect(onRowKeyboardNavigate).toHaveBeenCalledTimes(1);
    expect(onRowKeyboardNavigate.mock.calls[0]?.[0]).toMatchObject({ id: "2" });
  });

  it("leaves the key alone at the last row so it keeps its native meaning", () => {
    const onRowKeyboardNavigate = vi.fn();
    renderTable({ groups: GROUPS, items: [], onRowKeyboardNavigate });

    const cells = getNavigableCells();
    const lastGroupLeadCell = cells[3];
    if (!lastGroupLeadCell) {
      throw new Error("expected a lead cell in the last group");
    }
    fireEvent.keyDown(lastGroupLeadCell, { key: "ArrowDown" });

    expect(onRowKeyboardNavigate).not.toHaveBeenCalled();
  });

  it("moves across cells within a row on ArrowRight", () => {
    renderTable({});

    const cells = getNavigableCells();
    const firstCell = cells[0];
    if (!firstCell) {
      throw new Error("expected a first cell");
    }
    fireEvent.keyDown(firstCell, { key: "ArrowRight" });

    expect(document.activeElement).toBe(cells[1]);
  });
});

/**
 * ISS-8921 inertness. Row lineage made this component a `treegrid` for callers
 * that opt in, and the whole safety property of that change is that a caller
 * which does NOT opt in is untouched — same roles, same attributes, same DOM.
 *
 * The expectations below are LITERALS, deliberately not derived from the
 * component's own output: a test that asked the render what it emitted and then
 * asserted it matched would stay green through every leak it exists to catch.
 * This block imports nothing from the lineage modules, so it runs verbatim
 * against the pre-ISS-8921 component — which is how it was verified to describe
 * the behavior that already shipped rather than the behavior that landed with
 * it.
 */
describe("GridTableV2 without a child accessor", () => {
  const GRID_ATTRIBUTES = ["aria-colcount", "class", "data-grid-body", "role"];
  const ROW_ATTRIBUTES = [
    "class",
    "data-grid-row",
    "data-grid-row-id",
    "draggable",
    "role",
    "style",
  ];
  // `data-grid-lead-cell` is the domain-free marker the grouped-row inset
  // targets (#9116 review); it carries no ARIA or tree semantics.
  const LEAD_CELL_ATTRIBUTES = [
    "aria-colindex",
    "class",
    "data-grid-cell",
    "data-grid-lead-cell",
    "role",
    "tabindex",
  ];

  it("declares the plain grid role, never treegrid", () => {
    renderTable({});

    expect(screen.getByRole("grid")).toBeInTheDocument();
    expect(screen.queryByRole("treegrid")).not.toBeInTheDocument();
  });

  it("emits exactly the grid attributes it emitted before", () => {
    renderTable({});

    expect(attributeNames(screen.getByRole("grid"))).toEqual(GRID_ATTRIBUTES);
  });

  it("emits exactly the row attributes it emitted before", () => {
    renderTable({});

    const [, firstBodyRow] = within(screen.getByRole("grid")).getAllByRole(
      "row"
    );
    expect(attributeNames(firstBodyRow as HTMLElement)).toEqual(ROW_ATTRIBUTES);
  });

  it("emits exactly the identity-cell attributes it emitted before", () => {
    renderTable({});

    expect(attributeNames(getNavigableCells()[0] as HTMLElement)).toEqual(
      LEAD_CELL_ATTRIBUTES
    );
  });

  it("puts no disclosure control in the identity cell", () => {
    renderTable({});

    expect(
      within(getNavigableCells()[0] as HTMLElement).queryByRole("button")
    ).toBeNull();
  });

  it("leaves ArrowLeft at the first cell its native meaning", () => {
    renderTable({});

    const [firstCell] = getNavigableCells();
    if (!firstCell) {
      throw new Error("expected a first cell");
    }
    act(() => firstCell.focus());
    fireEvent.keyDown(firstCell, { key: "ArrowLeft" });

    // The row edge: nothing to move to, and — with no lineage wired — nothing
    // to collapse either, so focus stays put and the key is not claimed.
    expect(document.activeElement).toBe(firstCell);
    expect(firstCell).not.toHaveAttribute("aria-expanded");
  });
});

describe("GridTableV2 row click", () => {
  it("skips onRowClick when the click lands on an interactive control", () => {
    const onRowClick = vi.fn();
    renderTable({
      onRowClick,
      renderCell: (columnId, row) =>
        columnId === "owner" ? (
          <button type="button">{row.owner}</button>
        ) : (
          row.status
        ),
    });

    fireEvent.click(screen.getByRole("button", { name: "ada" }));

    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("still selects the row for a click on inert cell content", () => {
    const onRowClick = vi.fn();
    renderTable({ onRowClick });

    fireEvent.click(screen.getByText("Alpha"));

    expect(onRowClick).toHaveBeenCalledTimes(1);
  });
});
