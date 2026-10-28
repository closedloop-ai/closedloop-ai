/**
 * ISS-9555 — `preferredActiveCellKey`, the caller's resume target for the roving
 * tab stop.
 *
 * The subject is the ORDER the three candidates resolve in, so every case here
 * renders the same fixture and changes only which candidates exist: the cell the
 * reader last focused, then the caller's key, then the grid's own entry cell.
 * A case that asserted only "the preferred key wins" would pass equally against
 * a seam that had simply replaced the staleness guard.
 *
 * Assertions read the rendered `tabIndex`, because that IS the roving tab stop —
 * the one thing a keyboard user can reach the grid through.
 */

import { GridTableV2 } from "@closedloop-ai/design-system/components/ui/grid-table-v2";
import { focusCellFromRowClick } from "@closedloop-ai/design-system/lib/grid-table-navigation";
import {
  buildCellKey,
  LEAD_CELL_COLUMN_KEY,
} from "@closedloop-ai/design-system/lib/grid-table-v2-rows";
import {
  rovingTabStop,
  rowIdOfTabStop,
} from "@closedloop-ai/design-system/test/grid-roving-tab-stop";
import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

type Row = { id: string; name: string };

const ROWS: Row[] = [
  { id: "row-0", name: "Alpha" },
  { id: "row-1", name: "Bravo" },
];

const COLUMNS = [{ id: "status", label: "Status" }];

function renderGrid(preferredActiveCellKey?: string) {
  return render(
    <GridTableV2<Row>
      columns={COLUMNS}
      getRowId={(row) => row.id}
      gridTemplateColumns="200px 120px"
      items={ROWS}
      leadingLabel="Name"
      preferredActiveCellKey={preferredActiveCellKey}
      renderCell={(_columnId, row) => <span>{`Status ${row.name}`}</span>}
      renderLead={(row) => <span>{row.name}</span>}
    />
  );
}

function cellIn(rowId: string, index: number): HTMLElement {
  const cells = document.querySelectorAll<HTMLElement>(
    `[data-grid-row-id="${rowId}"] [data-grid-cell]`
  );
  const cell = cells[index];
  if (!cell) {
    throw new Error(`row ${rowId} painted no cell at ${index}`);
  }
  return cell;
}

describe("GridTableV2 preferredActiveCellKey", () => {
  it("enters at the first rendered cell when no key is offered", () => {
    renderGrid();

    expect(rowIdOfTabStop()).toBe("row-0");
  });

  it("resumes on the offered cell instead of the entry cell", () => {
    renderGrid(buildCellKey("row-1", LEAD_CELL_COLUMN_KEY));

    expect(rovingTabStop()).toBe(cellIn("row-1", 0));
  });

  it("keeps the cell the reader focused rather than the offered one", () => {
    const { rerender } = render(
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
    const focused = cellIn("row-1", 1);
    fireEvent.focus(focused);

    rerender(
      <GridTableV2<Row>
        columns={COLUMNS}
        getRowId={(row) => row.id}
        gridTemplateColumns="200px 120px"
        items={ROWS}
        leadingLabel="Name"
        preferredActiveCellKey={buildCellKey("row-0", LEAD_CELL_COLUMN_KEY)}
        renderCell={(_columnId, row) => <span>{`Status ${row.name}`}</span>}
        renderLead={(row) => <span>{row.name}</span>}
      />
    );

    // The offer is the THIRD candidate, never the first: a caller cannot move
    // the tab stop out from under a reader who is already in the grid.
    expect(rovingTabStop()).toBe(focused);
  });

  it("falls through to the entry cell when the offered row is not painted", () => {
    renderGrid(buildCellKey("row-gone", LEAD_CELL_COLUMN_KEY));

    // The staleness guard still governs. Without the membership test the grid
    // would settle on a key no cell answers to and leave the tab order empty.
    expect(rowIdOfTabStop()).toBe("row-0");
  });

  it("resumes on the offered lead cell in the compact narrow list", () => {
    render(
      <GridTableV2<Row>
        columns={COLUMNS}
        getRowId={(row) => row.id}
        gridTemplateColumns="200px 120px"
        items={ROWS}
        leadingLabel="Name"
        mode="compact"
        preferredActiveCellKey={buildCellKey("row-1", LEAD_CELL_COLUMN_KEY)}
        renderCell={(_columnId, row) => <span>{`Status ${row.name}`}</span>}
        renderLead={(row) => <span>{row.name}</span>}
      />
    );

    expect(rovingTabStop()).toBe(cellIn("row-1", 0));
    expect(document.querySelectorAll("[data-grid-cell]")).toHaveLength(
      ROWS.length
    );
  });
});

describe("focusCellFromRowClick", () => {
  it("focuses without preventScroll, so a restore brings its cell into view", () => {
    renderGrid();
    const cell = cellIn("row-1", 1);
    const focus = vi.spyOn(cell, "focus");

    act(() => {
      focusCellFromRowClick(cell);
    });

    // PINNED AS INTENDED (PLN-1950 slice 6). Passing `{ preventScroll: true }`
    // here would leave a restored cell focused off-screen; changing it is a
    // behaviour change to click handling, not a tidy-up.
    expect(focus).toHaveBeenCalledWith();
    focus.mockRestore();
  });
});
