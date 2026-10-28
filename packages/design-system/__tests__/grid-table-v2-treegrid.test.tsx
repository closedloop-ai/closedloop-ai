/**
 * `GridTableV2` as a WAI-ARIA `treegrid` (ISS-8921) — the rendered half.
 *
 * The flat half lives in `grid-table-v2.test.tsx`'s "without a child accessor"
 * block, which asserts the exact attribute set an opted-out caller emits. That
 * block is deliberately over there rather than here: it imports nothing from the
 * lineage modules, so it runs unchanged against the pre-ISS-8921 component and
 * is how the inertness claim was verified rather than merely stated.
 *
 * Every attribute below is asserted on its own so each can fail independently —
 * a single `toMatchObject` over the row would let a wrong `aria-setsize` hide
 * behind a right `aria-level`.
 */

import {
  GridTableV2,
  type GridTableV2Column,
} from "@closedloop-ai/design-system/components/ui/grid-table-v2";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

type Row = {
  id: string;
  name: string;
  owner: string;
  status: string;
  children?: Row[];
};

const COLUMNS: GridTableV2Column[] = [
  { id: "owner", label: "Owner" },
  { id: "status", label: "Status" },
];

const GRID_TEMPLATE = "minmax(200px, 1fr) 120px 120px";

/**
 * Two roots; the first owns THREE children, one of which owns a grandchild.
 *
 * The asymmetry is load-bearing. A fixture whose levels held the same number of
 * rows could not tell `aria-setsize` ("how many siblings") from a count of every
 * row on screen, and without a grandchild there is no level 3 to catch a
 * depth-2-only implementation.
 */
const ROWS: Row[] = [
  {
    children: [
      { id: "1a", name: "Alpha child A", owner: "ada", status: "Active" },
      {
        children: [
          { id: "1b1", name: "Alpha grandchild", owner: "ada", status: "Done" },
        ],
        id: "1b",
        name: "Alpha child B",
        owner: "linus",
        status: "Active",
      },
      { id: "1c", name: "Alpha child C", owner: "ada", status: "Done" },
    ],
    id: "1",
    name: "Alpha",
    owner: "ada",
    status: "Active",
  },
  { id: "2", name: "Beta", owner: "linus", status: "Done" },
];

function renderTree(
  props: Partial<React.ComponentProps<typeof GridTableV2<Row>>> = {}
) {
  return render(
    <GridTableV2<Row>
      columns={COLUMNS}
      getChildren={(row) => row.children}
      getRowId={(row) => row.id}
      gridTemplateColumns={GRID_TEMPLATE}
      items={ROWS}
      leadingLabel="Name"
      renderCell={(columnId, row) =>
        columnId === "owner" ? row.owner : row.status
      }
      renderLead={(row) => <span>{row.name}</span>}
      {...props}
    />
  );
}

/** Body rows only, in visible order — the header row is not one of them. */
function getBodyRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-grid-row]"));
}

function getBodyRow(rowId: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(
    `[data-grid-row-id="${rowId}"]`
  );
  if (!row) {
    throw new Error(`expected a rendered row for ${rowId}`);
  }
  return row;
}

/** The identity cell of a row: the cell carrying the disclosure. */
function getIdentityCell(rowId: string): HTMLElement {
  const cell = getBodyRow(rowId).querySelector<HTMLElement>("[data-grid-cell]");
  if (!cell) {
    throw new Error(`expected an identity cell for ${rowId}`);
  }
  return cell;
}

function getDisclosure(rowId: string): HTMLElement {
  return within(getIdentityCell(rowId)).getByRole("button");
}

describe("GridTableV2 treegrid role", () => {
  it("becomes a treegrid once a child accessor is supplied", () => {
    renderTree();

    expect(screen.getByRole("treegrid")).toBeInTheDocument();
  });

  it("is no longer announced as a plain grid", () => {
    renderTree();

    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
  });
});

describe("GridTableV2 treegrid row semantics", () => {
  it("gives a root row aria-level 1", () => {
    renderTree();

    expect(getBodyRow("1")).toHaveAttribute("aria-level", "1");
  });

  it("gives a child row aria-level 2", () => {
    renderTree({ defaultExpandedRowIds: ["1"] });

    expect(getBodyRow("1a")).toHaveAttribute("aria-level", "2");
  });

  it("gives a grandchild row aria-level 3", () => {
    renderTree({ defaultExpandedRowIds: ["1", "1b"] });

    expect(getBodyRow("1b1")).toHaveAttribute("aria-level", "3");
  });

  it("numbers a root by its position among the roots", () => {
    renderTree();

    expect(getBodyRow("2")).toHaveAttribute("aria-posinset", "2");
  });

  it("sizes the root set to the roots alone", () => {
    renderTree({ defaultExpandedRowIds: ["1"] });

    // Five rows are on screen; the root set is still two. A `setSize` read off
    // the rendered rows would say 5 here.
    expect(getBodyRow("1")).toHaveAttribute("aria-setsize", "2");
  });

  it("numbers a child by its position among its own siblings", () => {
    renderTree({ defaultExpandedRowIds: ["1"] });

    expect(getBodyRow("1c")).toHaveAttribute("aria-posinset", "3");
  });

  it("sizes a child set to that parent's children", () => {
    renderTree({ defaultExpandedRowIds: ["1"] });

    expect(getBodyRow("1c")).toHaveAttribute("aria-setsize", "3");
  });

  it("declares aria-expanded on a row that owns children", () => {
    renderTree();

    expect(getBodyRow("1")).toHaveAttribute("aria-expanded", "false");
  });

  it("leaves aria-expanded off a leaf row", () => {
    // A leaf announcing a disclosure invites a keypress that does nothing
    // (WCAG 4.1.2 Name, Role, Value).
    renderTree();

    expect(getBodyRow("2")).not.toHaveAttribute("aria-expanded");
  });

  it("flips aria-expanded when the row is opened", () => {
    renderTree();

    fireEvent.click(getDisclosure("1"));

    expect(getBodyRow("1")).toHaveAttribute("aria-expanded", "true");
  });

  it("flips aria-expanded back when the row is closed", () => {
    renderTree({ defaultExpandedRowIds: ["1"] });

    fireEvent.click(getDisclosure("1"));

    expect(getBodyRow("1")).toHaveAttribute("aria-expanded", "false");
  });
});

describe("GridTableV2 treegrid disclosure control", () => {
  it("names the control by what pressing it does while closed", () => {
    renderTree();

    expect(getDisclosure("1")).toHaveAccessibleName("Expand row");
  });

  it("names it by what pressing it does while open", () => {
    renderTree({ defaultExpandedRowIds: ["1"] });

    expect(getDisclosure("1")).toHaveAccessibleName("Collapse row");
  });

  it("lets a caller supply its own closed-state name", () => {
    renderTree({ expandRowLabel: "Show sub-items" });

    expect(getDisclosure("1")).toHaveAccessibleName("Show sub-items");
  });

  it("lets a caller supply its own open-state name", () => {
    // Driven separately from the closed-state name, and with a string that is
    // NOT the default: asserting the default would pass just as well if the
    // prop were never wired through at all.
    renderTree({
      collapseRowLabel: "Hide sub-items",
      defaultExpandedRowIds: ["1"],
    });

    expect(getDisclosure("1")).toHaveAccessibleName("Hide sub-items");
  });

  it("leaves aria-expanded off the control itself in the grid", () => {
    // The treegrid `row` owns the state here; a button repeating it would state
    // one fact twice in the accessibility tree.
    renderTree();

    expect(getDisclosure("1")).not.toHaveAttribute("aria-expanded");
  });

  it("gives a leaf row no control at all", () => {
    renderTree();

    expect(within(getIdentityCell("2")).queryByRole("button")).toBeNull();
  });

  it("reports the toggle to the host with the row it acted on", () => {
    const onRowExpandedChange = vi.fn();
    renderTree({ onRowExpandedChange });

    fireEvent.click(getDisclosure("1"));

    expect(onRowExpandedChange).toHaveBeenCalledTimes(1);
    expect(onRowExpandedChange.mock.calls[0]?.[0]).toMatchObject({ id: "1" });
    expect(onRowExpandedChange.mock.calls[0]?.[1]).toBe(true);
  });

  it("reports a collapse as a collapse", () => {
    // The boolean is what a host PERSISTS. Reported as `true` both ways, a host
    // would write every close as an open and reopen the row on the next mount —
    // and a test that only ever expands cannot tell the difference.
    const onRowExpandedChange = vi.fn();
    renderTree({ defaultExpandedRowIds: ["1"], onRowExpandedChange });

    fireEvent.click(getDisclosure("1"));

    expect(onRowExpandedChange.mock.calls[0]?.[1]).toBe(false);
  });

  it("does not select the row when the disclosure is pressed", () => {
    const onRowClick = vi.fn();
    renderTree({ onRowClick });

    fireEvent.click(getDisclosure("1"));

    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("does not move a collapsed descendant selection to its parent", () => {
    const onRowClick = vi.fn();
    renderTree({
      defaultExpandedRowIds: ["1"],
      isRowSelected: (row) => row.id === "1a",
      onRowClick,
    });

    expect(getBodyRow("1a")).toHaveAttribute("aria-selected", "true");
    fireEvent.click(getDisclosure("1"));

    expect(onRowClick).not.toHaveBeenCalled();
    expect(getBodyRow("1")).toHaveAttribute("aria-selected", "false");
  });
});

describe("GridTableV2 treegrid painted rows", () => {
  it("paints only the roots while everything is closed", () => {
    renderTree();

    expect(getBodyRows().map((row) => row.dataset.gridRowId)).toEqual([
      "1",
      "2",
    ]);
  });

  it("paints a row's children directly beneath it when opened", () => {
    renderTree();

    fireEvent.click(getDisclosure("1"));

    expect(getBodyRows().map((row) => row.dataset.gridRowId)).toEqual([
      "1",
      "1a",
      "1b",
      "1c",
      "2",
    ]);
  });

  it("takes a whole subtree away again when closed", () => {
    renderTree({ defaultExpandedRowIds: ["1", "1b"] });

    fireEvent.click(getDisclosure("1"));

    expect(getBodyRows().map((row) => row.dataset.gridRowId)).toEqual([
      "1",
      "2",
    ]);
  });

  it("restores a grandchild's own open state when its parent reopens", () => {
    // The expansion bound must not prune an id merely because its row stopped
    // being painted, or reopening a parent would silently close everything in
    // it.
    renderTree({ defaultExpandedRowIds: ["1", "1b"] });

    fireEvent.click(getDisclosure("1"));
    fireEvent.click(getDisclosure("1"));

    expect(getBodyRows().map((row) => row.dataset.gridRowId)).toEqual([
      "1",
      "1a",
      "1b",
      "1b1",
      "1c",
      "2",
    ]);
  });

  it("hands a host every painted row on select-all, descendants included", () => {
    const onSelectAllRows = vi.fn();
    renderTree({ defaultExpandedRowIds: ["1"], onSelectAllRows });

    fireEvent.keyDown(getIdentityCell("1"), { ctrlKey: true, key: "a" });

    expect(
      onSelectAllRows.mock.calls[0]?.[0].map((row: Row) => row.id)
    ).toEqual(["1", "1a", "1b", "1c", "2"]);
  });
});

/** Compact mode keeps the treegrid contract while projecting one Name column. */
describe("[DT-08] GridTableV2 treegrid in the narrow list", () => {
  function renderNarrow(
    props: Partial<React.ComponentProps<typeof GridTableV2<Row>>> = {}
  ) {
    return renderTree({
      mode: "compact",
      ...props,
    });
  }

  function renderedRowIds(): (string | undefined)[] {
    return getBodyRows().map((row) => row.dataset.gridRowId);
  }

  it("gives a parent row a disclosure", () => {
    renderNarrow();

    expect(
      screen.getByRole("button", { name: "Expand row" })
    ).toBeInTheDocument();
  });

  it("gives a leaf row no disclosure", () => {
    renderNarrow();

    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("paints only the roots while everything is closed", () => {
    renderNarrow();

    expect(renderedRowIds()).toEqual(["1", "2"]);
  });

  it("paints a parent's children once it is opened", () => {
    renderNarrow();

    fireEvent.click(screen.getByRole("button", { name: "Expand row" }));

    expect(renderedRowIds()).toEqual(["1", "1a", "1b", "1c", "2"]);
  });

  it("publishes the collapsed state on the treegrid row", () => {
    renderNarrow();

    expect(getBodyRow("1")).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.getByRole("button", { name: "Expand row" })
    ).not.toHaveAttribute("aria-expanded");
  });

  it("publishes the expanded state on the treegrid row", () => {
    renderNarrow({ defaultExpandedRowIds: ["1"] });

    expect(getBodyRow("1")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("columnheader")).toHaveLength(1);
  });
});

/**
 * Grouping and lineage are two different hierarchies over the same rows, and
 * they compose: a band decides which ROOTS are visible, lineage then expands
 * each root's open descendants beneath it.
 *
 * The last test here is the one that pins where the expansion bound is
 * computed. Everywhere else, pruning against the RENDERED rows and pruning
 * against every band's roots give the same answer, because a rendered root
 * carries its whole subtree with it — a collapsed BAND is the only thing that
 * takes a root off screen entirely, and only then can the cheaper bound throw
 * away the open state of rows the user never touched.
 */
describe("GridTableV2 treegrid inside groups", () => {
  const GROUPS = [
    { items: [ROWS[0] as Row], key: "alpha", label: "Alpha band" },
    {
      items: [
        {
          children: [
            { id: "3a", name: "Gamma child", owner: "ada", status: "Done" },
          ],
          id: "3",
          name: "Gamma",
          owner: "ada",
          status: "Done",
        },
      ],
      key: "gamma",
      label: "Gamma band",
    },
  ];

  function renderGrouped() {
    return renderTree({
      defaultExpandedRowIds: ["1", "1b"],
      groups: GROUPS,
      items: [],
    });
  }

  function toggleBand(label: string) {
    fireEvent.click(screen.getByRole("button", { name: new RegExp(label) }));
  }

  it("expands a root inside its own band", () => {
    renderGrouped();

    expect(getBodyRows().map((row) => row.dataset.gridRowId)).toEqual([
      "1",
      "1a",
      "1b",
      "1b1",
      "1c",
      "3",
    ]);
  });

  it("keeps a band's own collapse independent of row lineage", () => {
    renderGrouped();

    toggleBand("Alpha band");

    expect(getBodyRows().map((row) => row.dataset.gridRowId)).toEqual(["3"]);
  });

  /**
   * whitlockk review: the same root listed in two bands.
   *
   * Grouping is a caller's own partition of its rows and nothing stops one row
   * from satisfying two bands' predicates, so this is reachable data rather than
   * a corrupt-lineage edge case — and the tree contract is that a repeated id
   * paints ONCE, at the first place it legitimately appeared. A cycle guard that
   * lived for one band could not see the repeat, so the row painted in both.
   */
  const GROUPS_WITH_REPEATED_ROOT = [
    GROUPS[0] as (typeof GROUPS)[number],
    {
      items: [ROWS[0] as Row, ...(GROUPS[1] as (typeof GROUPS)[number]).items],
      key: "gamma",
      label: "Gamma band",
    },
  ];

  function renderRepeatedRoot() {
    return renderTree({
      defaultExpandedRowIds: ["1", "1b"],
      groups: GROUPS_WITH_REPEATED_ROOT,
      items: [],
    });
  }

  it("paints a root repeated in a later band only once", () => {
    renderRepeatedRoot();

    expect(getBodyRows().map((row) => row.dataset.gridRowId)).toEqual([
      "1",
      "1a",
      "1b",
      "1b1",
      "1c",
      "3",
    ]);
  });

  it("keeps the later band's set arithmetic describing the rows it painted", () => {
    // The dropped repeat must not keep consuming an `aria-posinset`, or the band
    // would tell a screen-reader user there is a row 1 to find that no amount of
    // navigating will reach.
    renderRepeatedRoot();

    expect(getBodyRow("3")).toHaveAttribute("aria-posinset", "1");
    expect(getBodyRow("3")).toHaveAttribute("aria-setsize", "1");
  });

  it("leaves the grid one tab stop rather than two cells under one key", () => {
    // A cell key is composed from the row id, so two rows under one id compose
    // the same keys — and the roving tabindex puts EVERY cell holding the active
    // key at `tabIndex={0}`, breaking the single-tab-stop contract.
    renderRepeatedRoot();

    expect(
      document.querySelectorAll(
        '[data-grid-row] [data-grid-cell][tabindex="0"]'
      )
    ).toHaveLength(1);
  });

  it("keeps a collapsed band's lineage while another band is toggled", () => {
    // The bound is computed over every band's roots, not over the rows on
    // screen. Pruning to the rendered rows would drop "1" and "1b" the moment
    // their band was closed and another row was opened, so reopening the band
    // would show it flat — losing an expansion the user never touched.
    renderGrouped();

    toggleBand("Alpha band");
    fireEvent.click(getDisclosure("3"));
    toggleBand("Alpha band");

    expect(getBodyRows().map((row) => row.dataset.gridRowId)).toEqual([
      "1",
      "1a",
      "1b",
      "1b1",
      "1c",
      "3",
      "3a",
    ]);
  });
});

/**
 * The column lattice is the one this grid actually publishes: `aria-colindex`
 * on every cell against the table's `aria-colcount`, paired track-for-track with
 * the header. There is no `aria-rowindex` here and ISS-8921 deliberately did not
 * add one — every row a treegrid shows is in the DOM, and a collapsed subtree is
 * removed rather than hidden, so a declared row index would only be a second
 * source of truth to keep in step with the DOM across every expand and collapse.
 * These tests hold that line from both directions.
 */
describe("GridTableV2 treegrid index lattice across expand and collapse", () => {
  const COLUMN_RUN = ["1", "2", "3"];

  function readColumnRuns(): string[][] {
    return getBodyRows().map((row) =>
      within(row)
        .getAllByRole("gridcell")
        .map((cell) => cell.getAttribute("aria-colindex") ?? "")
    );
  }

  function readRowIndexes(): (string | null)[] {
    return getBodyRows().map((row) => row.getAttribute("aria-rowindex"));
  }

  it("pairs every closed-state row with the header's tracks", () => {
    renderTree();

    expect(readColumnRuns()).toEqual([COLUMN_RUN, COLUMN_RUN]);
  });

  it("keeps the column run intact on every row an expand adds", () => {
    renderTree();

    fireEvent.click(getDisclosure("1"));

    expect(readColumnRuns()).toEqual([
      COLUMN_RUN,
      COLUMN_RUN,
      COLUMN_RUN,
      COLUMN_RUN,
      COLUMN_RUN,
    ]);
  });

  it("keeps the column run intact after a collapse", () => {
    renderTree({ defaultExpandedRowIds: ["1", "1b"] });

    fireEvent.click(getDisclosure("1"));

    expect(readColumnRuns()).toEqual([COLUMN_RUN, COLUMN_RUN]);
  });

  it("keeps aria-colcount unchanged through an expand", () => {
    renderTree();

    fireEvent.click(getDisclosure("1"));

    expect(screen.getByRole("treegrid")).toHaveAttribute("aria-colcount", "3");
  });

  it("still pairs the header run with the deepest expanded body row", () => {
    renderTree({ defaultExpandedRowIds: ["1", "1b"] });

    const headerRun = within(screen.getByRole("treegrid"))
      .getAllByRole("columnheader")
      .map((cell) => cell.getAttribute("aria-colindex"));

    expect(headerRun).toEqual(COLUMN_RUN);
    expect(
      within(getBodyRow("1b1"))
        .getAllByRole("gridcell")
        .map((cell) => cell.getAttribute("aria-colindex"))
    ).toEqual(COLUMN_RUN);
  });

  it("declares no row index in any expansion state", () => {
    renderTree();
    expect(readRowIndexes()).toEqual([null, null]);

    fireEvent.click(getDisclosure("1"));
    expect(readRowIndexes()).toEqual([null, null, null, null, null]);

    fireEvent.click(getDisclosure("1"));
    expect(readRowIndexes()).toEqual([null, null]);
  });
});

describe("GridTableV2 treegrid keyboard", () => {
  it("expands a closed row on ArrowRight at the identity cell", () => {
    renderTree();

    fireEvent.keyDown(getIdentityCell("1"), { key: "ArrowRight" });

    expect(getBodyRow("1")).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps focus on the identity cell while expanding", () => {
    renderTree();
    const cell = getIdentityCell("1");
    act(() => cell.focus());

    fireEvent.keyDown(cell, { key: "ArrowRight" });

    expect(document.activeElement).toBe(getIdentityCell("1"));
  });

  it("moves right on the second ArrowRight instead of re-expanding", () => {
    // The APG treegrid contract: once a row is open, the key goes back to being
    // a column move, or the user can never leave the identity column.
    renderTree({ defaultExpandedRowIds: ["1"] });
    const cell = getIdentityCell("1");
    act(() => cell.focus());

    fireEvent.keyDown(cell, { key: "ArrowRight" });

    expect(document.activeElement).not.toBe(cell);
    expect(getBodyRow("1")).toHaveAttribute("aria-expanded", "true");
  });

  it("collapses an open row on ArrowLeft at the identity cell", () => {
    renderTree({ defaultExpandedRowIds: ["1"] });

    fireEvent.keyDown(getIdentityCell("1"), { key: "ArrowLeft" });

    expect(getBodyRow("1")).toHaveAttribute("aria-expanded", "false");
  });

  it("removes the collapsed subtree's rows on ArrowLeft", () => {
    renderTree({ defaultExpandedRowIds: ["1"] });

    fireEvent.keyDown(getIdentityCell("1"), { key: "ArrowLeft" });

    expect(getBodyRows().map((row) => row.dataset.gridRowId)).toEqual([
      "1",
      "2",
    ]);
  });

  it("leaves ArrowRight alone on a leaf row's identity cell", () => {
    renderTree();
    const cell = getIdentityCell("2");
    act(() => cell.focus());

    fireEvent.keyDown(cell, { key: "ArrowRight" });

    // A plain column move, exactly as in a flat grid.
    expect(document.activeElement).not.toBe(cell);
    expect(getBodyRow("2")).not.toHaveAttribute("aria-expanded");
  });

  it("does not expand from a data cell", () => {
    renderTree();
    const dataCell =
      getBodyRow("1").querySelectorAll<HTMLElement>("[data-grid-cell]")[1];
    if (!dataCell) {
      throw new Error("expected a data cell");
    }

    fireEvent.keyDown(dataCell, { key: "ArrowRight" });

    expect(getBodyRow("1")).toHaveAttribute("aria-expanded", "false");
  });

  it("leaves a modified ArrowRight to the browser", () => {
    renderTree();

    fireEvent.keyDown(getIdentityCell("1"), {
      key: "ArrowRight",
      shiftKey: true,
    });

    expect(getBodyRow("1")).toHaveAttribute("aria-expanded", "false");
  });

  it("still crosses into a child row on ArrowDown", () => {
    renderTree({ defaultExpandedRowIds: ["1"] });
    const cell = getIdentityCell("1");
    act(() => cell.focus());

    fireEvent.keyDown(cell, { key: "ArrowDown" });

    expect(document.activeElement).toBe(getIdentityCell("1a"));
  });

  it("moves End from a root to the first cell of the last visible row", () => {
    renderTree({ defaultExpandedRowIds: ["1", "1b"] });
    const cell = getIdentityCell("1");
    act(() => cell.focus());

    fireEvent.keyDown(cell, { key: "End" });

    expect(document.activeElement).toBe(getIdentityCell("2"));
  });

  it("still keeps exactly one cell in the tab order after an expand", () => {
    renderTree();

    fireEvent.click(getDisclosure("1"));

    const cells = Array.from(
      document.querySelectorAll<HTMLElement>("[data-grid-cell]")
    );
    expect(cells.filter((cell) => cell.tabIndex === 0)).toHaveLength(1);
  });

  it("still enters a cell's control on Enter", () => {
    renderTree({
      renderCell: (columnId, row) =>
        columnId === "owner" ? (
          <button type="button">{row.owner}</button>
        ) : (
          row.status
        ),
    });
    const dataCell =
      getBodyRow("2").querySelectorAll<HTMLElement>("[data-grid-cell]")[1];
    if (!dataCell) {
      throw new Error("expected a data cell");
    }
    act(() => dataCell.focus());

    fireEvent.keyDown(dataCell, { key: "Enter" });

    expect(document.activeElement).toBe(
      within(dataCell).getByRole("button", { name: "linus" })
    );
  });

  it("still leaves an entered cell on F2", () => {
    renderTree({
      renderCell: (columnId, row) =>
        columnId === "owner" ? (
          <button type="button">{row.owner}</button>
        ) : (
          row.status
        ),
    });
    const dataCell =
      getBodyRow("2").querySelectorAll<HTMLElement>("[data-grid-cell]")[1];
    if (!dataCell) {
      throw new Error("expected a data cell");
    }
    act(() => dataCell.focus());
    fireEvent.keyDown(dataCell, { key: "Enter" });

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "F2" });

    expect(document.activeElement).toBe(dataCell);
  });
});
