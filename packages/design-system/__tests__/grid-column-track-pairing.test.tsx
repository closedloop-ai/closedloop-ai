import {
  GridTable,
  type GridTableColumn,
} from "@closedloop-ai/design-system/components/ui/grid-table";
import { GridTableV2 } from "@closedloop-ai/design-system/components/ui/grid-table-v2";
import type { GridTableV2Column } from "@closedloop-ai/design-system/lib/grid-table-v2-types";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

/**
 * ISS-9564 — one resolved answer about a grid's leading tracks drives the
 * header's numbering and the body's.
 *
 * WHAT NOTHING ELSE COVERS: a CSS-grid table has no implicit column
 * relationships, so a screen reader pairs a body cell with its column header
 * purely by `aria-colindex`. The header and the body used to answer "is there a
 * leading utility track" from DIFFERENT props — the body from
 * `renderLeadingUtility`, the header from the utility cell NODE it was handed —
 * so a caller supplying one without the other made the two runs number the same
 * grid from different bases. Every body cell then resolved against the column
 * header one track to its left, silently.
 *
 * Two things this file is careful about, both of which produced a green test
 * that proved nothing on the first pass:
 *
 *  - **Body locators are scoped to a body row.** `data-column-id` is emitted by
 *    the header cell AND the body cell, and the header renders first, so a bare
 *    `document.querySelector` returns the HEADER — making every "body"
 *    assertion a second reading of the header.
 *  - **Expectations are pinned literals**, never read back from the resolver
 *    these tests police, which would keep them green for any self-consistent
 *    numbering including a wrong one.
 *
 * KNOWN RESIDUAL, deliberately not asserted: in the two mixed shapes below the
 * run that was not given its half paints one fewer cell than the template
 * declares tracks, so its cells are laid out one track from the index they
 * publish. That is a pre-existing layout gap in a shape no caller in the repo
 * uses, and closing it needs a placeholder cell — new rendered output this
 * ticket has no mandate for. What is fixed here is the `aria-colindex` pairing,
 * which is what assistive technology actually reads.
 */

type Row = { id: string; name: string };

/**
 * The row value is deliberately unlike every column label, so the helper that
 * finds the identity cell by its rendered text cannot match a header instead.
 */
const ROWS: Row[] = [{ id: "row-1", name: "Row One" }];

/** Declaration order, deliberately NOT the order the reorder case renders. */
const COLUMNS: GridTableColumn[] = [
  { id: "alpha", label: "Alpha" },
  { id: "beta", label: "Beta" },
];

/**
 * A utility track, the lead track, then one track per data column. The utility
 * track is deliberately NOT 36px: that is the width
 * `resolveLeadingUtilityPinOffset` falls back to, so an anchor asserted against
 * 36px would also be satisfied by a regression that stopped reading the
 * caller's template at all.
 */
const TEMPLATE_WITH_UTILITY = "52px 200px 120px 120px";

/**
 * The tracks a utility-track grid numbers: the utility cell at 1, the identity
 * cell at 2, and the two data columns after it. Written out rather than
 * derived, so a change to the numbering has to be restated here deliberately.
 */
const LEAD_COLUMN_INDEX = "2";
const DATA_COLUMN_INDEXES = ["3", "4"];

function ariaColIndex(element: Element): string | null {
  return element.getAttribute("aria-colindex");
}

/** The first BODY row. `data-grid-row` is on body rows only, never the header. */
function bodyRow(): HTMLElement {
  const row = document.querySelector<HTMLElement>("[data-grid-row]");
  if (!row) {
    throw new Error("no body row rendered");
  }
  return row;
}

/** The body cell for `columnId`, scoped to its row so it cannot be a header. */
function bodyCellFor(columnId: string): HTMLElement {
  const cell = bodyRow().querySelector<HTMLElement>(
    `[data-column-id="${columnId}"]`
  );
  if (!cell) {
    throw new Error(`no body cell rendered for column "${columnId}"`);
  }
  return cell;
}

/** Every data column's `aria-colindex`, read off the body row. */
function bodyDataColumnIndexes(
  columnIds: readonly string[]
): (string | null)[] {
  return columnIds.map((columnId) => ariaColIndex(bodyCellFor(columnId)));
}

/** The identity cell, found through the value it renders rather than by index. */
function leadBodyCell(): HTMLElement {
  const cell = screen
    .getByText(ROWS[0].name)
    .closest('[role="cell"], [role="gridcell"]');
  if (!(cell instanceof HTMLElement)) {
    throw new Error("lead value is not inside a table cell");
  }
  return cell;
}

function headerFor(name: string): HTMLElement {
  return screen.getByRole("columnheader", { name });
}

describe("GridTable header/body track pairing", () => {
  it("numbers a body-only utility track on both runs", () => {
    render(
      <GridTable<Row>
        columns={COLUMNS}
        getRowId={(row) => row.id}
        gridTemplateColumns={TEMPLATE_WITH_UTILITY}
        items={ROWS}
        leadingLabel="Name"
        renderCell={(columnId) => columnId}
        renderLead={(row) => <span>{row.name}</span>}
        // The divergent shape: the body paints the utility track and no header
        // node is supplied for it.
        renderLeadingUtility={() => <span>star</span>}
      />
    );

    // The BODY run first, read off the row itself.
    expect(ariaColIndex(leadBodyCell())).toBe(LEAD_COLUMN_INDEX);
    expect(bodyDataColumnIndexes(["alpha", "beta"])).toEqual(
      DATA_COLUMN_INDEXES
    );

    // Then the HEADER run, which must publish the same indices for the same
    // columns or every body cell resolves against the wrong header.
    expect(ariaColIndex(headerFor("Name"))).toBe(LEAD_COLUMN_INDEX);
    expect([headerFor("Alpha"), headerFor("Beta")].map(ariaColIndex)).toEqual(
      DATA_COLUMN_INDEXES
    );
  });

  it("numbers a header-only utility track on both runs", () => {
    render(
      <GridTable<Row>
        columns={COLUMNS}
        getRowId={(row) => row.id}
        gridTemplateColumns={TEMPLATE_WITH_UTILITY}
        items={ROWS}
        leadingLabel="Name"
        // The mirror-image shape: the header owns the utility track and the
        // body paints nothing into it. The track still exists, so both runs
        // must still count it.
        leadingUtilityHeader={<span>All</span>}
        renderCell={(columnId) => columnId}
        renderLead={(row) => <span>{row.name}</span>}
      />
    );

    expect(ariaColIndex(headerFor("Name"))).toBe(LEAD_COLUMN_INDEX);
    expect([headerFor("Alpha"), headerFor("Beta")].map(ariaColIndex)).toEqual(
      DATA_COLUMN_INDEXES
    );

    expect(ariaColIndex(leadBodyCell())).toBe(LEAD_COLUMN_INDEX);
    expect(bodyDataColumnIndexes(["alpha", "beta"])).toEqual(
      DATA_COLUMN_INDEXES
    );
  });

  it("numbers a reordered column identically in the header and the body", () => {
    render(
      <GridTable<Row>
        // Conflicts with the declaration order above, so precedence is what is
        // under test: an implementation that numbered by declaration order
        // would answer alpha=3 / beta=4 here.
        columnOrder={["beta", "alpha"]}
        columns={COLUMNS}
        getRowId={(row) => row.id}
        gridTemplateColumns={TEMPLATE_WITH_UTILITY}
        items={ROWS}
        leadingLabel="Name"
        renderCell={(columnId) => columnId}
        renderLead={(row) => <span>{row.name}</span>}
        renderLeadingUtility={() => <span>star</span>}
      />
    );

    // `beta` moved to the first data track, so it takes 3 and `alpha` takes 4 —
    // in the body and in the header alike.
    expect(bodyDataColumnIndexes(["beta", "alpha"])).toEqual(["3", "4"]);
    expect([headerFor("Beta"), headerFor("Alpha")].map(ariaColIndex)).toEqual([
      "3",
      "4",
    ]);

    // Painted order too, on BOTH runs: the numbering must not agree while the
    // tracks the caller sized are painted in the other order.
    expect(
      Array.from(bodyRow().querySelectorAll("[data-column-id]")).map((cell) =>
        cell.getAttribute("data-column-id")
      )
    ).toEqual(["beta", "alpha"]);
    expect(
      screen.getAllByRole("columnheader").map((header) => header.textContent)
    ).toEqual(["Utility", "Name", "Beta", "Alpha"]);
  });
});

describe("GridTableV2 pinned lead anchor", () => {
  const V2_COLUMNS: GridTableV2Column[] = [
    { id: "alpha", label: "Alpha" },
    { id: "beta", label: "Beta" },
  ];

  it("numbers a body-only utility track on both V2 runs", () => {
    render(
      <GridTableV2<Row>
        columns={V2_COLUMNS}
        getRowId={(row) => row.id}
        gridTemplateColumns={TEMPLATE_WITH_UTILITY}
        items={ROWS}
        leadingLabel="Name"
        renderCell={(columnId) => columnId}
        renderLead={(row) => <span>{row.name}</span>}
        renderLeadingUtility={() => <span>star</span>}
      />
    );

    expect(screen.getAllByRole("columnheader").map(ariaColIndex)).toEqual([
      "1",
      "2",
      "3",
      "4",
    ]);
    expect(
      Array.from(bodyRow().children).map((cell) => ariaColIndex(cell))
    ).toEqual(["1", "2", "3", "4"]);
  });

  it("numbers a header-only utility track on both V2 runs", () => {
    render(
      <GridTableV2<Row>
        columns={V2_COLUMNS}
        getRowId={(row) => row.id}
        gridTemplateColumns={TEMPLATE_WITH_UTILITY}
        items={ROWS}
        leadingLabel="Name"
        leadingUtilityHeader={<span>All</span>}
        renderCell={(columnId) => columnId}
        renderLead={(row) => <span>{row.name}</span>}
      />
    );

    expect(screen.getAllByRole("columnheader").map(ariaColIndex)).toEqual([
      "1",
      "2",
      "3",
      "4",
    ]);
    expect(
      Array.from(bodyRow().children).map((cell) => ariaColIndex(cell))
    ).toEqual(["1", "2", "3", "4"]);
  });

  // A regression guard on behavior this change deliberately preserves, not a
  // proof of it: the anchor keys off what the body PAINTS, because the offset
  // exists to clear a cell that is actually holding the row's left edge.
  it("anchors the header and the body to one utility-track offset", () => {
    render(
      <GridTableV2<Row>
        columns={V2_COLUMNS}
        getRowId={(row) => row.id}
        gridTemplateColumns={TEMPLATE_WITH_UTILITY}
        items={ROWS}
        leadingLabel="Name"
        pinLeadColumn
        renderCell={(columnId) => columnId}
        renderLead={(row) => <span>{row.name}</span>}
        renderLeadingUtility={() => <span>star</span>}
      />
    );

    const leadHeader = headerFor("Name");

    // Both runs read the offset off the caller's own declared track, so the
    // label and the values under it park on one anchor. 52px also proves the
    // template was read rather than the 36px fallback returned.
    expect(leadBodyCell().style.left).toBe("52px");
    expect(leadHeader.style.left).toBe("52px");

    // The inline offset must be the SOLE anchor: `left-0` alongside it is the
    // drift `PINNED_LEAD_AFTER_UTILITY_CELL_CLASS` exists to prevent, and it
    // renders correctly today only because inline style beats a class.
    expect(leadBodyCell()).not.toHaveClass("left-0");
    expect(leadHeader).not.toHaveClass("left-0");

    // Paired positively, so "nothing is sticky anywhere" cannot be what passes.
    expect(leadBodyCell()).toHaveClass("sticky");
    expect(leadHeader).toHaveClass("sticky");
  });
});
