/**
 * ISS-8930 — the column-header row and the group-section headers as rows of
 * `GridTableV2`'s roving focus model.
 *
 * Every case asserts the flag-OFF arm on the SAME fixture as the flag-ON arm.
 * The gate is the whole subject here, so a case that would also pass with it
 * closed would prove nothing about it, and the closed arm is a real contract in
 * its own right: it is what every v2 consumer that has not opted in still gets.
 *
 * The arrow-key cases assert the CELL THAT ENDS UP FOCUSED after a real
 * `keydown` through the production handler, not that a helper returned a node —
 * the transition across a chrome/data row boundary is the behavior the ticket
 * asked for, and only focus shows it actually happened.
 */

import { GridTableV2 } from "@closedloop-ai/design-system/components/ui/grid-table-v2";
import type { GridNavigationKey } from "@closedloop-ai/design-system/lib/grid-table-navigation";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

type Row = { id: string; name: string };

const ROWS: Row[] = [
  { id: "row-0", name: "Alpha" },
  { id: "row-1", name: "Bravo" },
];

const COLUMNS = [{ id: "status", label: "Status" }];

const GROUPS = [
  { key: "open", label: "Open", items: [ROWS[0] as Row] },
  { key: "done", label: "Done", items: [ROWS[1] as Row] },
];

function renderUngrouped(navigableHeaderCells: boolean) {
  return render(
    <GridTableV2<Row>
      columns={COLUMNS}
      getRowId={(row) => row.id}
      gridTemplateColumns="200px 120px"
      items={ROWS}
      leadingLabel="Name"
      navigableHeaderCells={navigableHeaderCells}
      renderCell={(_columnId, row) => <span>{`Status ${row.name}`}</span>}
      renderLead={(row) => <span>{row.name}</span>}
    />
  );
}

function renderGrouped(navigableHeaderCells: boolean) {
  return render(
    <GridTableV2<Row>
      columns={COLUMNS}
      getRowId={(row) => row.id}
      gridTemplateColumns="200px 120px"
      groups={GROUPS}
      items={[]}
      leadingLabel="Name"
      navigableHeaderCells={navigableHeaderCells}
      renderCell={(_columnId, row) => <span>{`Status ${row.name}`}</span>}
      renderLead={(row) => <span>{row.name}</span>}
    />
  );
}

/**
 * A grid whose caller took the trailing-header seam — the Add-field slot on the
 * Sessions grid — spreading the wiring onto the element it already gives
 * `role="columnheader"`, exactly as the production host does.
 */
function renderWithTrailingHeader({
  navigableHeaderCells,
  suppressCellTabStops = false,
}: {
  navigableHeaderCells: boolean;
  suppressCellTabStops?: boolean;
}) {
  return render(
    <GridTableV2<Row>
      columns={COLUMNS}
      getRowId={(row) => row.id}
      gridTemplateColumns="200px 120px 40px"
      items={ROWS}
      leadingLabel="Name"
      navigableHeaderCells={navigableHeaderCells}
      renderCell={(_columnId, row) => <span>{`Status ${row.name}`}</span>}
      renderLead={(row) => <span>{row.name}</span>}
      suppressCellTabStops={suppressCellTabStops}
      trailingHeader={(cellProps) => (
        // biome-ignore lint/a11y/useSemanticElements: an ARIA grid's trailing header cannot be a native th outside table markup — the same reason the production host carries this ignore.
        <div aria-colindex={3} role="columnheader" tabIndex={-1} {...cellProps}>
          <button type="button">Add field</button>
        </div>
      )}
    />
  );
}

/** Every cell in the roving model, in visible order. */
function navigableCells(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-grid-cell]"));
}

/** The one cell holding the grid's single tab stop. */
function tabStopCells(): HTMLElement[] {
  return navigableCells().filter(
    (cell) => cell.getAttribute("tabindex") === "0"
  );
}

function columnHeader(name: string): HTMLElement {
  return screen.getByRole("columnheader", { name });
}

/** The data cell of `rowName` in the identity column. */
function leadCellOf(rowName: string): HTMLElement {
  const row = screen
    .getByText(rowName)
    .closest<HTMLElement>("[data-grid-cell]");
  if (!row) {
    throw new Error(`no grid cell around ${rowName}`);
  }
  return row;
}

/** The band header cell carrying `label`'s collapse toggle. */
function groupHeaderCell(label: string): HTMLElement {
  const cell = screen
    .getByRole("button", { name: new RegExp(label) })
    .closest<HTMLElement>("[role='gridcell']");
  if (!cell) {
    throw new Error(`no gridcell around the ${label} band header`);
  }
  return cell;
}

function arrow(cell: HTMLElement, key: GridNavigationKey) {
  cell.focus();
  fireEvent.keyDown(cell, { key });
}

describe("GridTableV2 chrome rows in the roving model (ISS-8930)", () => {
  it("makes the header cells navigable only when the flag is open", () => {
    const closed = renderUngrouped(false);
    expect(columnHeader("Name")).not.toHaveAttribute("data-grid-cell");
    expect(columnHeader("Status")).not.toHaveAttribute("data-grid-cell");
    expect(
      document.querySelector("[data-grid-row] [role='columnheader']")
    ).toBeNull();
    closed.unmount();

    renderUngrouped(true);
    expect(columnHeader("Name")).toHaveAttribute("data-grid-cell", "");
    expect(columnHeader("Status")).toHaveAttribute("data-grid-cell", "");
    // The row itself has to join the walk too, or the cells are navigable
    // from nowhere.
    expect(columnHeader("Name").closest("[data-grid-row]")).not.toBeNull();
  });

  it("stays closed for a caller that passes no flag at all", () => {
    // Not the same assertion as the explicit-`false` arm above: that one pins
    // the closed BRANCH, this one pins the DEFAULT. A gate that shipped open
    // would satisfy every `false` case in this file and still change every v2
    // consumer that never opted in.
    render(
      <GridTableV2<Row>
        columns={COLUMNS}
        getRowId={(row) => row.id}
        gridTemplateColumns="200px 120px"
        items={ROWS}
        leadingLabel="Name"
        renderCell={(_columnId, row) => <span>{`Status ${row.name}`}</span>}
        renderLead={(row) => <span>{row.name}</span>}
      />
    );
    expect(columnHeader("Name")).not.toHaveAttribute("data-grid-cell");
    expect(navigableCells()).toHaveLength(4);
  });

  it("keeps exactly one tab stop once the header joins, and counts the header cells in", () => {
    const closed = renderUngrouped(false);
    // Two data rows x two cells. The header contributes none while closed,
    // which is the three-tab-stop shape ISS-8726 left behind.
    expect(navigableCells()).toHaveLength(4);
    expect(tabStopCells()).toHaveLength(1);
    closed.unmount();

    renderUngrouped(true);
    // The same four, plus the header's two.
    expect(navigableCells()).toHaveLength(6);
    expect(tabStopCells()).toHaveLength(1);
  });

  it("moves focus from the first data row up into the header, and back down (ungrouped)", () => {
    const closed = renderUngrouped(false);
    const closedLead = leadCellOf("Alpha");
    arrow(closedLead, "ArrowUp");
    // Nothing above the first data row while the flag is closed: the key is
    // left alone and focus stays put.
    expect(document.activeElement).toBe(closedLead);
    closed.unmount();

    renderUngrouped(true);
    arrow(leadCellOf("Alpha"), "ArrowUp");
    expect(document.activeElement).toBe(columnHeader("Name"));

    arrow(columnHeader("Name"), "ArrowDown");
    expect(document.activeElement).toBe(leadCellOf("Alpha"));
  });

  it("keeps the column when moving between the header and a data row", () => {
    renderUngrouped(true);
    const statusCell = screen
      .getByText("Status Alpha")
      .closest<HTMLElement>("[data-grid-cell]") as HTMLElement;

    arrow(statusCell, "ArrowUp");
    // The SECOND column's header, not the first — a row-wise move preserves
    // the track rather than landing on whichever cell comes first.
    expect(document.activeElement).toBe(columnHeader("Status"));
  });

  it("steps header -> group header -> data row and back (grouped)", () => {
    const closed = renderGrouped(false);
    expect(groupHeaderCell("Open")).not.toHaveAttribute("data-grid-cell");
    const closedLead = leadCellOf("Alpha");
    arrow(closedLead, "ArrowUp");
    expect(document.activeElement).toBe(closedLead);
    closed.unmount();

    renderGrouped(true);
    expect(groupHeaderCell("Open")).toHaveAttribute("data-grid-cell", "");

    // Up out of the band's first row reaches that band's own header, not the
    // column headers past it.
    arrow(leadCellOf("Alpha"), "ArrowUp");
    expect(document.activeElement).toBe(groupHeaderCell("Open"));

    // And one more Up leaves the band for the column headers.
    arrow(groupHeaderCell("Open"), "ArrowUp");
    expect(document.activeElement).toBe(columnHeader("Name"));

    // Down retraces the same three rows.
    arrow(columnHeader("Name"), "ArrowDown");
    expect(document.activeElement).toBe(groupHeaderCell("Open"));
    arrow(groupHeaderCell("Open"), "ArrowDown");
    expect(document.activeElement).toBe(leadCellOf("Alpha"));
  });

  it("crosses a band boundary from one group's last row into the next band's header", () => {
    renderGrouped(true);
    arrow(leadCellOf("Bravo"), "ArrowUp");
    expect(document.activeElement).toBe(groupHeaderCell("Done"));
    arrow(groupHeaderCell("Done"), "ArrowUp");
    // The previous BAND's row, not its header — document order is the walk.
    expect(document.activeElement).toBe(leadCellOf("Alpha"));
  });

  it("still enters a header cell's control with Enter, so sorting keeps a keyboard route", () => {
    render(
      <GridTableV2<Row>
        columns={[{ id: "status", label: "Status", sortable: true }]}
        getRowId={(row) => row.id}
        gridTemplateColumns="200px 120px"
        items={ROWS}
        leadingLabel="Name"
        navigableHeaderCells
        onSort={() => undefined}
        renderCell={(_columnId, row) => <span>{`Status ${row.name}`}</span>}
        renderLead={(row) => <span>{row.name}</span>}
        sortBy={null}
      />
    );
    const header = columnHeader("Status");
    const sortControl = within(header).getByRole("button");
    header.focus();
    fireEvent.keyDown(header, { key: "Enter" });
    // The whole point of Option A: the control inside the header is reachable
    // from the cell, so suppressing its own tab stop strands nothing.
    expect(document.activeElement).toBe(sortControl);
  });

  it("puts the header's first cell in the tab order when the body paints no rows", () => {
    const closed = render(
      <GridTableV2<Row>
        columns={COLUMNS}
        getRowId={(row) => row.id}
        gridTemplateColumns="200px 120px"
        items={[]}
        leadingLabel="Name"
        navigableHeaderCells={false}
        renderCell={() => null}
        renderLead={(row) => <span>{row.name}</span>}
      />
    );
    // Closed, an empty grid has no navigable cell at all — survivable only
    // because the header's own controls still hold their native tab stops.
    expect(tabStopCells()).toHaveLength(0);
    closed.unmount();

    render(
      <GridTableV2<Row>
        columns={COLUMNS}
        getRowId={(row) => row.id}
        gridTemplateColumns="200px 120px"
        items={[]}
        leadingLabel="Name"
        navigableHeaderCells
        renderCell={() => null}
        renderLead={(row) => <span>{row.name}</span>}
      />
    );
    // Open, the header cells ARE the grid's cells, so one of them has to carry
    // the tab stop or an empty grid would be a keyboard dead end.
    expect(tabStopCells()).toEqual([columnHeader("Name")]);
  });

  it("brings the trailing header slot into the header's arrow walk", () => {
    const closed = renderWithTrailingHeader({ navigableHeaderCells: false });
    // Closed, the slot is what it always was: a `columnheader` outside the
    // roving model whose button keeps its own native tab stop.
    expect(columnHeader("Add field")).not.toHaveAttribute("data-grid-cell");
    closed.unmount();

    renderWithTrailingHeader({ navigableHeaderCells: true });
    const trailing = columnHeader("Add field");

    // FOCUS FIRST, and deliberately: the markup assertion below would fail on
    // the same mutation and mask which contract broke. The slot was excluded
    // from the header's cell walk, so before this the arrows simply stopped at
    // the last data column and Add field was reachable only by Tab — a second
    // tab stop the single-tab-stop model claimed did not exist (whitlockk review).
    arrow(columnHeader("Status"), "ArrowRight");
    expect(trailing).toHaveFocus();

    // And back, so the seam is a two-way move rather than a one-way trap.
    arrow(trailing, "ArrowLeft");
    expect(columnHeader("Status")).toHaveFocus();

    expect(trailing).toHaveAttribute("data-grid-cell", "");
  });

  it("lets tab-stop suppression reach the control inside the trailing slot", () => {
    const closed = renderWithTrailingHeader({
      navigableHeaderCells: false,
      suppressCellTabStops: true,
    });
    // The sweep walks up to the nearest `[data-grid-cell]` and gives up when
    // there is none, so with the slot outside the model its button keeps a
    // native tab stop even with suppression on. This is the second stop.
    expect(
      screen.getByRole("button", { name: "Add field" })
    ).not.toHaveAttribute("tabindex", "-1");
    closed.unmount();

    renderWithTrailingHeader({
      navigableHeaderCells: true,
      suppressCellTabStops: true,
    });
    expect(screen.getByRole("button", { name: "Add field" })).toHaveAttribute(
      "tabindex",
      "-1"
    );
  });
});
