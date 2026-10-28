/**
 * ISS-8038 — the WAI-ARIA APG grid pattern's navigation keys and its cell-entry
 * model, driven through a RENDERED `GridTableV2`.
 *
 * Before this, `ARROW_KEYS` in `grid-table-navigation` was the complete key set
 * and the guard early-returned for everything else, so `Home`, `End`,
 * `Ctrl+Home`, `Ctrl+End`, `PageUp` and `PageDown` did nothing at all, and a
 * control inside a cell had no defined keyboard route (WCAG 2.1.1).
 *
 * Two rules these cases are built to hold:
 *
 * 1. `APG_NAVIGATION_CASES` below is written out by hand from the APG grid
 *    pattern, NOT derived from `GridNavigationKey` or any other const in the
 *    code under test. A fixture built from the set it polices stays green when
 *    a member is deleted, and this repo has shipped that defect twice.
 * 2. Every case asserts WHICH cell holds focus, by identity, not that focus
 *    changed. Each destination below is distinct from every other one reachable
 *    from the same origin, so a key that resolves to the wrong neighbour is red
 *    rather than accidentally right.
 */

import { GridTableV2 } from "@closedloop-ai/design-system/components/ui/grid-table-v2";
import {
  TABLE_FAVORITE_FOCUS_FILL_CLASS,
  TableFavoriteCell,
} from "@closedloop-ai/design-system/components/ui/table-cell-primitives";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

type Row = { id: string; name: string };

/** Four data columns plus the lead cell: five cells per row, indexes 0-4. */
const COLUMNS = [
  { id: "alpha", label: "Alpha" },
  { id: "bravo", label: "Bravo" },
  { id: "charlie", label: "Charlie" },
  { id: "delta", label: "Delta" },
];
const CELLS_PER_ROW = COLUMNS.length + 1;
const LAST_CELL_INDEX = CELLS_PER_ROW - 1;

/**
 * 25 rows, so a page jump lands INSIDE the grid rather than on a clamped edge —
 * a 10-row fixture would let a page key that silently did nothing but clamp
 * still pass. `ORIGIN_ROW_INDEX` sits far enough from both ends for PageUp and
 * PageDown to each move a full page.
 */
const ROW_COUNT = 25;
const LAST_ROW_INDEX = ROW_COUNT - 1;
const ORIGIN_ROW_INDEX = 12;
const ORIGIN_CELL_INDEX = 2;
const EXPECTED_PAGE_ROWS = 10;

const ROWS: Row[] = Array.from({ length: ROW_COUNT }, (_, index) => ({
  id: `row-${index}`,
  name: `Row ${index}`,
}));

/**
 * The APG grid pattern's keyboard interaction, transcribed by hand:
 * Left/Right/Up/Down move one cell; Home/End go to the row's extremes;
 * Ctrl+Home/Ctrl+End go to the grid's extremes; PageUp/PageDown move an
 * author-determined number of rows.
 */
const APG_NAVIGATION_CASES = [
  {
    name: "ArrowLeft moves one cell left",
    key: "ArrowLeft",
    ctrlKey: false,
    row: ORIGIN_ROW_INDEX,
    cell: 1,
  },
  {
    name: "ArrowRight moves one cell right",
    key: "ArrowRight",
    ctrlKey: false,
    row: ORIGIN_ROW_INDEX,
    cell: 3,
  },
  {
    name: "ArrowUp moves one row up in the same column",
    key: "ArrowUp",
    ctrlKey: false,
    row: ORIGIN_ROW_INDEX - 1,
    cell: ORIGIN_CELL_INDEX,
  },
  {
    name: "ArrowDown moves one row down in the same column",
    key: "ArrowDown",
    ctrlKey: false,
    row: ORIGIN_ROW_INDEX + 1,
    cell: ORIGIN_CELL_INDEX,
  },
  {
    name: "Home moves to the first cell of the row",
    key: "Home",
    ctrlKey: false,
    row: ORIGIN_ROW_INDEX,
    cell: 0,
  },
  {
    name: "End moves to the last cell of the row",
    key: "End",
    ctrlKey: false,
    row: ORIGIN_ROW_INDEX,
    cell: LAST_CELL_INDEX,
  },
  {
    name: "Ctrl+Home moves to the first cell of the grid",
    key: "Home",
    ctrlKey: true,
    row: 0,
    cell: 0,
  },
  {
    name: "Ctrl+End moves to the last cell of the grid",
    key: "End",
    ctrlKey: true,
    row: LAST_ROW_INDEX,
    cell: LAST_CELL_INDEX,
  },
  {
    name: "PageUp moves a page of rows up in the same column",
    key: "PageUp",
    ctrlKey: false,
    row: ORIGIN_ROW_INDEX - EXPECTED_PAGE_ROWS,
    cell: ORIGIN_CELL_INDEX,
  },
  {
    name: "PageDown moves a page of rows down in the same column",
    key: "PageDown",
    ctrlKey: false,
    row: ORIGIN_ROW_INDEX + EXPECTED_PAGE_ROWS,
    cell: ORIGIN_CELL_INDEX,
  },
] as const;

function renderNavigationGrid() {
  render(
    <GridTableV2<Row>
      columns={COLUMNS}
      getRowId={(row) => row.id}
      gridTemplateColumns="200px 80px 80px 80px 80px"
      items={ROWS}
      leadingLabel="Name"
      renderCell={(columnId, row) => `${row.id}/${columnId}`}
      renderLead={(row) => <span>{row.name}</span>}
    />
  );
}

/** Every navigable cell of one row, in visible order. */
function rowCells(rowIndex: number): HTMLElement[] {
  const row = document.querySelector<HTMLElement>(
    `[data-grid-row-id="row-${rowIndex}"]`
  );
  if (!row) {
    throw new Error(`no row rendered for index ${rowIndex}`);
  }
  return Array.from(row.querySelectorAll<HTMLElement>("[data-grid-cell]"));
}

/** Rendered rows in visible order — `cellAt` keys by ID, this keys by position. */
function renderedRowIds(): (string | undefined)[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-grid-row]")
  ).map((row) => row.dataset.gridRowId);
}

function cellAt(rowIndex: number, cellIndex: number): HTMLElement {
  const cell = rowCells(rowIndex)[cellIndex];
  if (!cell) {
    throw new Error(`no cell ${cellIndex} in row ${rowIndex}`);
  }
  return cell;
}

/**
 * Real DOM focus, which is what every assertion here reads back through
 * `document.activeElement` — `fireEvent.focus` dispatches the event without
 * moving focus, so it cannot set up a navigation case. Wrapped in `act` because
 * the cell's own `onFocus` re-keys the roving tabindex.
 */
function focusCell(cell: HTMLElement): void {
  act(() => cell.focus());
}

describe("GridTableV2 APG navigation keys", () => {
  it.each(APG_NAVIGATION_CASES)("$name", ({ key, ctrlKey, row, cell }) => {
    renderNavigationGrid();
    const origin = cellAt(ORIGIN_ROW_INDEX, ORIGIN_CELL_INDEX);
    focusCell(origin);

    fireEvent.keyDown(origin, { key, ctrlKey });

    expect(document.activeElement).toBe(cellAt(row, cell));
  });

  it("clamps a page jump to the grid rather than running off it", () => {
    renderNavigationGrid();
    const nearTop = cellAt(1, ORIGIN_CELL_INDEX);
    focusCell(nearTop);
    fireEvent.keyDown(nearTop, { key: "PageUp" });
    expect(document.activeElement).toBe(cellAt(0, ORIGIN_CELL_INDEX));

    const nearBottom = cellAt(LAST_ROW_INDEX - 1, ORIGIN_CELL_INDEX);
    focusCell(nearBottom);
    fireEvent.keyDown(nearBottom, { key: "PageDown" });
    expect(document.activeElement).toBe(
      cellAt(LAST_ROW_INDEX, ORIGIN_CELL_INDEX)
    );
  });

  it("claims Home on a row's first cell instead of letting the host scroll", () => {
    renderNavigationGrid();
    const firstCell = cellAt(ORIGIN_ROW_INDEX, 0);
    focusCell(firstCell);

    // `fireEvent` returns false when a handler called `preventDefault`. The grid
    // has to claim the key even with nowhere to move, or the host scroll
    // container jumps to the top and takes the grid off screen.
    const notDefaultPrevented = fireEvent.keyDown(firstCell, { key: "Home" });

    expect(notDefaultPrevented).toBe(false);
    expect(document.activeElement).toBe(firstCell);
  });

  it("leaves a Ctrl chord the grid does not claim to the browser", () => {
    renderNavigationGrid();
    const origin = cellAt(ORIGIN_ROW_INDEX, ORIGIN_CELL_INDEX);
    focusCell(origin);

    // Ctrl+ArrowDown belongs to the OS/browser; only Ctrl+Home / Ctrl+End are
    // the grid's, which is what the two cases above already proved.
    fireEvent.keyDown(origin, { key: "ArrowDown", ctrlKey: true });
    expect(document.activeElement).toBe(origin);

    // Same fixture, unchorded: the key DOES move, so the case above is about
    // the chord and not about a grid that ignores ArrowDown entirely.
    fireEvent.keyDown(origin, { key: "ArrowDown" });
    expect(document.activeElement).toBe(
      cellAt(ORIGIN_ROW_INDEX + 1, ORIGIN_CELL_INDEX)
    );
  });
});

describe("GridTableV2 cell-entry model", () => {
  function renderEntryGrid() {
    render(
      <GridTableV2<Row>
        columns={[{ id: "alpha", label: "Alpha" }]}
        getRowId={(row) => row.id}
        gridTemplateColumns="200px 120px"
        items={ROWS.slice(0, 2)}
        leadingLabel="Name"
        renderCell={(_columnId, row) => (
          <button type="button">{`Edit ${row.name}`}</button>
        )}
        renderLead={(row) => <span>{row.name}</span>}
      />
    );
  }

  it.each(["Enter", "F2"])(
    "%s moves focus from the cell into its control",
    (key) => {
      renderEntryGrid();
      const cell = cellAt(0, 1);
      focusCell(cell);
      expect(document.activeElement).toBe(cell);

      fireEvent.keyDown(cell, { key });

      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Edit Row 0" })
      );
    }
  );

  it("Escape returns focus from the control to its cell", () => {
    renderEntryGrid();
    const cell = cellAt(0, 1);
    focusCell(cell);
    fireEvent.keyDown(cell, { key: "Enter" });
    const control = screen.getByRole("button", { name: "Edit Row 0" });
    expect(document.activeElement).toBe(control);

    // `fireEvent` returns false when a handler called `preventDefault`, so this
    // also pins that the grid CLAIMED the key rather than only happening to move
    // focus — a detached `preventDefault` reference throws instead of claiming.
    const notDefaultPrevented = fireEvent.keyDown(control, { key: "Escape" });

    expect(notDefaultPrevented).toBe(false);
    expect(document.activeElement).toBe(cell);
  });

  it("leaves Escape to a text field inside the cell", () => {
    render(
      <GridTableV2<Row>
        columns={[{ id: "alpha", label: "Alpha" }]}
        getRowId={(row) => row.id}
        gridTemplateColumns="200px 120px"
        items={ROWS.slice(0, 1)}
        leadingLabel="Name"
        renderCell={() => (
          <input aria-label="Rename row" defaultValue="draft" />
        )}
        renderLead={(row) => <span>{row.name}</span>}
      />
    );
    const cell = cellAt(0, 1);
    focusCell(cell);
    fireEvent.keyDown(cell, { key: "Enter" });
    const field = screen.getByRole("textbox", { name: "Rename row" });
    expect(document.activeElement).toBe(field);

    // A field reverts on its own Escape and its owner usually closes the editor
    // on the same key. Yanking focus to the cell here blurs it mid-revert, and a
    // blur-commits editor then saves the edit the user just discarded.
    fireEvent.keyDown(field, { key: "Escape" });

    expect(document.activeElement).toBe(field);
  });

  it("leaves the entry key alone for a cell holding no control", () => {
    renderEntryGrid();
    // The lead cell renders plain text, so there is nothing to enter and the
    // key keeps its native meaning instead of being swallowed.
    const leadCell = cellAt(0, 0);
    focusCell(leadCell);

    const notDefaultPrevented = fireEvent.keyDown(leadCell, { key: "Enter" });

    expect(notDefaultPrevented).toBe(true);
    expect(document.activeElement).toBe(leadCell);
  });
});

/**
 * AC5, and the reason the entry model is not just a `focus()` call: a cell's
 * content routinely replaces ITSELF while it holds focus (an inline editor
 * opening, saving, or cancelling). The browser drops focus on `<body>` when the
 * focused node is removed, and the user is then left with no cell focused and
 * no way back in except tabbing from the top of the document — a keyboard trap,
 * which is a worse WCAG outcome than the gap this ticket set out to close.
 */
describe("GridTableV2 cell entry does not strand focus", () => {
  function SelfReplacingControl() {
    const [replaced, setReplaced] = useState(false);
    if (replaced) {
      return <span>replaced</span>;
    }
    return (
      <button onClick={() => setReplaced(true)} type="button">
        Open editor
      </button>
    );
  }

  it("returns focus to the cell when the entered control unmounts", async () => {
    render(
      <GridTableV2<Row>
        columns={[{ id: "alpha", label: "Alpha" }]}
        getRowId={(row) => row.id}
        gridTemplateColumns="200px 120px"
        items={ROWS.slice(0, 1)}
        leadingLabel="Name"
        renderCell={() => <SelfReplacingControl />}
        renderLead={(row) => <span>{row.name}</span>}
      />
    );
    const cell = cellAt(0, 1);
    focusCell(cell);
    fireEvent.keyDown(cell, { key: "Enter" });
    const control = screen.getByRole("button", { name: "Open editor" });
    // Positive sibling for the assertion below: focus really was inside the
    // cell's content, so the restore is not passing on a cell that was never
    // entered.
    expect(document.activeElement).toBe(control);

    fireEvent.click(control);

    expect(screen.getByText("replaced")).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(cell));
    expect(document.activeElement).not.toBe(document.body);
  });

  /**
   * A real inline editor swaps its trigger for a FIELD and back, so the entered
   * content unmounts twice, and the replacement takes focus itself rather than
   * waiting for another `Enter`. A guard that disarms after its first restore is
   * therefore gone by the time the second unmount happens.
   */
  function InlineFieldEditor() {
    const [editing, setEditing] = useState(false);
    if (editing) {
      return (
        <input
          aria-label="Rename row"
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              setEditing(false);
            }
          }}
        />
      );
    }
    return (
      <button onClick={() => setEditing(true)} type="button">
        Open editor
      </button>
    );
  }

  it("stays armed for a second unmount after it restores focus once", async () => {
    render(
      <GridTableV2<Row>
        columns={[{ id: "alpha", label: "Alpha" }]}
        getRowId={(row) => row.id}
        gridTemplateColumns="200px 120px"
        items={ROWS.slice(0, 1)}
        leadingLabel="Name"
        renderCell={() => <InlineFieldEditor />}
        renderLead={(row) => <span>{row.name}</span>}
      />
    );
    const cell = cellAt(0, 1);
    focusCell(cell);
    fireEvent.keyDown(cell, { key: "Enter" });

    // First unmount: the trigger is replaced by the field.
    fireEvent.click(screen.getByRole("button", { name: "Open editor" }));
    await waitFor(() => expect(document.activeElement).toBe(cell));

    // The field takes focus itself, the way a real inline editor's mount effect
    // does. No fresh `Enter`, so nothing re-arms the guard here.
    const field = screen.getByRole("textbox", { name: "Rename row" });
    focusCell(field);

    // Second unmount, with the entry never re-entered.
    fireEvent.keyDown(field, { key: "Enter" });

    await waitFor(() => expect(document.activeElement).toBe(cell));
    expect(document.activeElement).not.toBe(document.body);
  });

  it("stops guarding once the user leaves the cell by another route", async () => {
    render(
      <>
        <button type="button">Elsewhere</button>
        <GridTableV2<Row>
          columns={[{ id: "alpha", label: "Alpha" }]}
          getRowId={(row) => row.id}
          gridTemplateColumns="200px 120px"
          items={ROWS.slice(0, 1)}
          leadingLabel="Name"
          renderCell={() => <SelfReplacingControl />}
          renderLead={(row) => <span>{row.name}</span>}
        />
      </>
    );
    const cell = cellAt(0, 1);
    focusCell(cell);
    fireEvent.keyDown(cell, { key: "Enter" });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Open editor" })
    );

    // The user tabs out of the grid, then clicks page background so nothing at
    // all holds focus, and only THEN does the cell's content churn — a data
    // refresh re-rendering the row. The guard must be gone by now: dragging
    // focus back into a grid the user already walked away from is its own
    // defect. The case above is the positive sibling — same guard, user still
    // inside the cell, focus restored.
    const outside = screen.getByRole("button", { name: "Elsewhere" });
    focusCell(outside);
    act(() => outside.blur());
    expect(document.activeElement).toBe(document.body);

    fireEvent.click(screen.getByRole("button", { name: "Open editor" }));

    await waitFor(() => expect(screen.getByText("replaced")).toBeVisible());
    expect(document.activeElement).toBe(document.body);
  });
});

/**
 * The exit route for a control that keeps its own `Escape`. `canExitOnEscape`
 * deliberately leaves Escape to a text field — blurring it mid-revert would let
 * a blur-commits editor save the draft the user just discarded — and the unmount
 * guard covers the editors that close on that key. A field that STAYS MOUNTED
 * falls between the two: nothing unmounts, so nothing restores focus, and the
 * navigation keys belong to the caret. `F2` is what keeps that from being a way
 * into the grid with no way back.
 */
describe("GridTableV2 cell entry can always be left", () => {
  function renderGridWithPersistentField() {
    return render(
      <GridTableV2<Row>
        columns={[{ id: "alpha", label: "Alpha" }]}
        getRowId={(row) => row.id}
        gridTemplateColumns="200px 120px"
        items={ROWS.slice(0, 1)}
        leadingLabel="Name"
        // A plain always-mounted field: no Escape handler, nothing to unmount.
        renderCell={() => <input aria-label="Filter alpha" />}
        renderLead={(row) => <span>{row.name}</span>}
      />
    );
  }

  it("F2 returns focus to the cell from a field that keeps its own Escape", () => {
    renderGridWithPersistentField();
    const cell = cellAt(0, 1);
    focusCell(cell);
    fireEvent.keyDown(cell, { key: "Enter" });
    const field = screen.getByRole("textbox", { name: "Filter alpha" });
    expect(document.activeElement).toBe(field);

    // Escape is the field's, by design — this is the premise of the finding, not
    // an aspiration. Asserting it here is what stops the F2 case below from
    // passing on a grid where Escape already did the job.
    fireEvent.keyDown(field, { key: "Escape" });
    expect(document.activeElement).toBe(field);

    fireEvent.keyDown(field, { key: "F2" });

    expect(document.activeElement).toBe(cell);
  });

  it("and the cell navigates again once F2 has left the field", () => {
    renderGridWithPersistentField();
    const cell = cellAt(0, 1);
    focusCell(cell);
    fireEvent.keyDown(cell, { key: "Enter" });
    const field = screen.getByRole("textbox", { name: "Filter alpha" });
    fireEvent.keyDown(field, { key: "F2" });

    // The point of getting back to the cell: grid navigation works from it
    // again. Inside the field, `shouldSkipGridNavigation` hands ArrowLeft to
    // the caret, so this move is only possible because focus really left.
    fireEvent.keyDown(cell, { key: "ArrowLeft" });

    expect(document.activeElement).toBe(cellAt(0, 0));
  });
});

/**
 * The removal the cell's own subtree cannot see. A control that deletes its row
 * mutates the grid BODY, not the cell, so a guard observing only the cell never
 * fires — and the cell it would restore to has been removed along with the row,
 * where `focus()` is a silent no-op. Focus lands on `<body>` either way.
 */
describe("GridTableV2 cell entry survives its own row being removed", () => {
  function DeletableGrid() {
    const [rows, setRows] = useState(ROWS.slice(0, 3));
    return (
      <GridTableV2<Row>
        columns={[{ id: "alpha", label: "Alpha" }]}
        getRowId={(row) => row.id}
        gridTemplateColumns="200px 120px"
        items={rows}
        leadingLabel="Name"
        renderCell={(_columnId, row) => (
          <button
            onClick={() =>
              setRows((current) =>
                current.filter((candidate) => candidate.id !== row.id)
              )
            }
            type="button"
          >
            {`Delete ${row.name}`}
          </button>
        )}
        renderLead={(row) => <span>{row.name}</span>}
      />
    );
  }

  it("hands focus to the row that took the removed one's place", async () => {
    render(<DeletableGrid />);
    // The MIDDLE row, so a surviving row exists both above and below it and
    // "the row that took its place" is a different answer from "the first row".
    const cell = cellAt(1, 1);
    focusCell(cell);
    fireEvent.keyDown(cell, { key: "Enter" });
    const remove = screen.getByRole("button", { name: "Delete Row 1" });
    expect(document.activeElement).toBe(remove);

    fireEvent.click(remove);

    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    // Row 2 is what slid up into the removed row's slot, and `cellAt` keys by
    // row ID — so this names the surviving ROW, and the check below is what ties
    // that row to the POSITION the removed one held.
    expect(document.activeElement).toBe(cellAt(2, 1));
    expect(renderedRowIds()).toEqual(["row-0", "row-2"]);
  });

  it("falls back to the new last row when the removed row was last", async () => {
    render(<DeletableGrid />);
    const cell = cellAt(2, 1);
    focusCell(cell);
    fireEvent.keyDown(cell, { key: "Enter" });

    fireEvent.click(screen.getByRole("button", { name: "Delete Row 2" }));

    // Nothing took index 2, so an unclamped restore would index off the end and
    // strand focus on `<body>` exactly as before.
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(document.activeElement).toBe(cellAt(1, 1));
    expect(renderedRowIds()).toEqual(["row-0", "row-1"]);
  });
});

/**
 * `data-grid-primary-editor` is an unvalidated public opt-in, so a caller can
 * point it at something that cannot take focus. Claiming the key anyway leaves
 * the user with a dead Enter AND no native fallback.
 */
describe("GridTableV2 cell entry declines an unfocusable target", () => {
  it("leaves the key alone when the primary editor cannot take focus", () => {
    render(
      <GridTableV2<Row>
        columns={[{ id: "alpha", label: "Alpha" }]}
        getRowId={(row) => row.id}
        gridTemplateColumns="200px 120px"
        items={ROWS.slice(0, 1)}
        leadingLabel="Name"
        renderCell={() => (
          <button data-grid-primary-editor="" disabled type="button">
            Unavailable
          </button>
        )}
        renderLead={(row) => <span>{row.name}</span>}
      />
    );
    const cell = cellAt(0, 1);
    focusCell(cell);

    const notDefaultPrevented = fireEvent.keyDown(cell, { key: "Enter" });

    expect(notDefaultPrevented).toBe(true);
    expect(document.activeElement).toBe(cell);
  });

  it("still enters a cell whose primary editor CAN take focus", () => {
    render(
      <GridTableV2<Row>
        columns={[{ id: "alpha", label: "Alpha" }]}
        getRowId={(row) => row.id}
        gridTemplateColumns="200px 120px"
        items={ROWS.slice(0, 1)}
        leadingLabel="Name"
        renderCell={() => (
          <button data-grid-primary-editor="" type="button">
            Available
          </button>
        )}
        renderLead={(row) => <span>{row.name}</span>}
      />
    );
    const cell = cellAt(0, 1);
    focusCell(cell);

    const notDefaultPrevented = fireEvent.keyDown(cell, { key: "Enter" });

    expect(notDefaultPrevented).toBe(false);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Available" })
    );
  });
});

/**
 * AC3. `TableFavoriteCell` in `renderLeadingUtility` is a control inside a cell
 * — the case the entry model exists to cover, and the proof it works on the
 * surface the ticket names. The utility cell was not a navigable cell at all
 * before this, so the star had no route through the grid.
 */
describe("GridTableV2 leading utility cell", () => {
  function FavoriteGrid() {
    const [favorited, setFavorited] = useState(false);
    return (
      <GridTableV2<Row>
        columns={[{ id: "alpha", label: "Alpha" }]}
        getRowId={(row) => row.id}
        gridTemplateColumns="36px 200px 120px"
        items={ROWS.slice(0, 1)}
        leadingLabel="Name"
        renderCell={(_columnId, row) => row.name}
        renderLead={(row) => <span>{row.name}</span>}
        renderLeadingUtility={() => (
          <TableFavoriteCell
            favorited={favorited}
            itemLabel="Row 0"
            onFavoriteChange={setFavorited}
          />
        )}
      />
    );
  }

  it("is the grid's entry point and navigates like any other cell", () => {
    render(<FavoriteGrid />);
    const star = screen.getByRole("button", { name: "Add Row 0 to favorites" });
    // Identity, not position: the cell that HOLDS the favorite control is the
    // one that has to be navigable. Asserting `cellAt(0, 0)` alone would pass
    // against a grid where the utility cell is not a `[data-grid-cell]` at all,
    // because the lead cell would simply take index 0.
    const utilityCell = star.closest<HTMLElement>("[data-grid-cell]");
    expect(utilityCell).toBe(cellAt(0, 0));
    expect(utilityCell).toHaveAttribute("aria-colindex", "1");

    // The single tab stop before the grid is entered is its FIRST cell, which
    // is now the utility cell rather than the lead cell beside it.
    expect(utilityCell?.tabIndex).toBe(0);
    expect(
      document.querySelectorAll('[data-grid-cell][tabindex="0"]')
    ).toHaveLength(1);

    const leadCell = cellAt(0, 1);
    focusCell(leadCell);
    fireEvent.keyDown(leadCell, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(utilityCell);
  });

  it("reads differently entered than merely navigated to", () => {
    render(<FavoriteGrid />);
    const utilityCell = cellAt(0, 0);
    const star = screen.getByRole("button", { name: "Add Row 0 to favorites" });

    // The star fills its whole track, so its focus ring lands on the same box as
    // the ring the grid draws on the cell — identical pixels for two different
    // states. jsdom paints nothing, so this asserts the shipped class list, and
    // reads the constant the component itself uses so it cannot drift into
    // asserting its own copy of the string.
    expect(star.className).toContain(TABLE_FAVORITE_FOCUS_FILL_CLASS);
    expect(utilityCell.className).not.toContain(
      TABLE_FAVORITE_FOCUS_FILL_CLASS
    );
  });

  it("gives the utility column a header, so every later header still pairs with its own body cells", () => {
    render(<FavoriteGrid />);
    const headers = screen.getAllByRole("columnheader");

    // `FavoriteGrid` passes `renderLeadingUtility` and NO `leadingUtilityHeader`
    // — the shape that used to render three body tracks under two headers. The
    // count is the whole finding: one header short and every remaining header
    // pairs with the body cell of the column before it.
    expect(headers).toHaveLength(3);
    expect(headers[0]).toHaveAccessibleName("Actions");
    expect(headers[0]).toHaveAttribute("aria-colindex", "1");

    // The pairing itself, read off both runs rather than assumed from the count:
    // the identity column is track 2 on the header side AND on the body side.
    expect(headers[1]).toHaveAttribute("aria-colindex", "2");
    expect(cellAt(0, 1)).toHaveAttribute("aria-colindex", "2");
  });

  it("lets a caller name the utility column", () => {
    render(
      <GridTableV2<Row>
        columns={[{ id: "alpha", label: "Alpha" }]}
        getRowId={(row) => row.id}
        gridTemplateColumns="36px 200px 120px"
        items={ROWS.slice(0, 1)}
        leadingLabel="Name"
        leadingUtilityLabel="Favorite"
        renderCell={(_columnId, row) => row.name}
        renderLead={(row) => <span>{row.name}</span>}
        renderLeadingUtility={() => (
          <TableFavoriteCell
            favorited={false}
            itemLabel="Row 0"
            onFavoriteChange={() => {
              // Naming the column is what is under test, not toggling it.
            }}
          />
        )}
      />
    );

    // A literal, not `DEFAULT_LEADING_UTILITY_LABEL`: reading the constant the
    // component defaults to would keep this green if the prop were ignored.
    expect(screen.getAllByRole("columnheader")[0]).toHaveAccessibleName(
      "Favorite"
    );
  });

  it("favorites a row from the keyboard through the entry model", () => {
    render(<FavoriteGrid />);
    const utilityCell = cellAt(0, 0);
    focusCell(utilityCell);

    fireEvent.keyDown(utilityCell, { key: "Enter" });
    const star = screen.getByRole("button", { name: "Add Row 0 to favorites" });
    expect(document.activeElement).toBe(star);
    expect(star).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(star);

    const pressed = screen.getByRole("button", {
      name: "Remove Row 0 from favorites",
    });
    expect(pressed).toHaveAttribute("aria-pressed", "true");
  });
});
