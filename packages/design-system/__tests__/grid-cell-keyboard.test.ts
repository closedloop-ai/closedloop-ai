import {
  type GridRowExpansionHandlers,
  type GridSelectionHandlers,
  handleGridCellEntryKeyDown,
  handleGridCellKeyDown,
} from "@closedloop-ai/design-system/lib/grid-cell-keyboard";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Builds a synthetic grid body with rows and cells for keyboard testing.
 * Mirrors the DOM shape both GridTable and GridTableV2 produce.
 */
function buildGrid(rowCount = 3, cellCount = 3) {
  const gridBody = document.createElement("div");
  gridBody.setAttribute("data-grid-body", "");

  const rows: HTMLDivElement[] = [];
  const cells: HTMLDivElement[][] = [];

  for (let r = 0; r < rowCount; r++) {
    const row = document.createElement("div");
    row.setAttribute("data-grid-row", "");
    row.setAttribute("data-grid-row-id", `r${r}`);
    rows.push(row);
    cells.push([]);

    for (let c = 0; c < cellCount; c++) {
      const cell = document.createElement("div");
      cell.setAttribute("data-grid-cell", "");
      cell.tabIndex = r === 0 && c === 0 ? 0 : -1;
      cells[r].push(cell);
      row.appendChild(cell);
    }
    gridBody.appendChild(row);
  }

  document.body.appendChild(gridBody);
  return {
    gridBody,
    rows,
    cells,
    cleanup: () => document.body.removeChild(gridBody),
  };
}

function makeKeyEvent(
  key: string,
  currentTarget: HTMLElement,
  overrides: {
    target?: EventTarget | null;
    altKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
  } = {}
) {
  return {
    key,
    currentTarget,
    target: overrides.target ?? currentTarget,
    altKey: overrides.altKey ?? false,
    ctrlKey: overrides.ctrlKey ?? false,
    metaKey: overrides.metaKey ?? false,
    shiftKey: overrides.shiftKey ?? false,
    preventDefault: vi.fn(),
  };
}

let cleanupFn: (() => void) | null = null;
afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
});

describe("handleGridCellEntryKeyDown", () => {
  it("returns false for non-entry keys when focus is on the cell", () => {
    const { cells, cleanup } = buildGrid();
    cleanupFn = cleanup;
    const cell = cells[0][0];
    const event = makeKeyEvent("ArrowDown", cell);
    expect(handleGridCellEntryKeyDown(event)).toBe(false);
  });

  it("enters a cell with a focusable button on Enter", () => {
    const { cells, cleanup } = buildGrid();
    cleanupFn = cleanup;
    const cell = cells[0][0];
    const button = document.createElement("button");
    button.textContent = "Edit";
    cell.appendChild(button);

    cell.focus();
    const event = makeKeyEvent("Enter", cell);
    const consumed = handleGridCellEntryKeyDown(event);

    expect(consumed).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(document.activeElement).toBe(button);
  });

  it("enters a cell with a focusable button on F2", () => {
    const { cells, cleanup } = buildGrid();
    cleanupFn = cleanup;
    const cell = cells[0][0];
    const button = document.createElement("button");
    cell.appendChild(button);

    cell.focus();
    const event = makeKeyEvent("F2", cell);
    const consumed = handleGridCellEntryKeyDown(event);

    expect(consumed).toBe(true);
    expect(document.activeElement).toBe(button);
  });

  it("returns false when cell has no focusable content", () => {
    const { cells, cleanup } = buildGrid();
    cleanupFn = cleanup;
    const cell = cells[0][0];
    cell.textContent = "Plain text";

    cell.focus();
    const event = makeKeyEvent("Enter", cell);
    expect(handleGridCellEntryKeyDown(event)).toBe(false);
  });

  it("exits a cell on Escape when focus is inside the cell on a non-text control", () => {
    const { cells, cleanup } = buildGrid();
    cleanupFn = cleanup;
    const cell = cells[0][0];
    const button = document.createElement("button");
    cell.appendChild(button);

    button.focus();
    const event = makeKeyEvent("Escape", cell, { target: button });
    const consumed = handleGridCellEntryKeyDown(event);

    expect(consumed).toBe(true);
    expect(document.activeElement).toBe(cell);
  });

  it("does not exit on Escape when focus is on a text input (owns its own keys)", () => {
    const { cells, cleanup } = buildGrid();
    cleanupFn = cleanup;
    const cell = cells[0][0];
    const input = document.createElement("input");
    cell.appendChild(input);

    input.focus();
    const event = makeKeyEvent("Escape", cell, { target: input });
    const consumed = handleGridCellEntryKeyDown(event);

    // canExitOnEscape returns false for input — so exitGridCell is not attempted
    expect(consumed).toBe(false);
  });

  it("does not exit on Escape when focus is on a textarea", () => {
    const { cells, cleanup } = buildGrid();
    cleanupFn = cleanup;
    const cell = cells[0][0];
    const textarea = document.createElement("textarea");
    cell.appendChild(textarea);

    textarea.focus();
    const event = makeKeyEvent("Escape", cell, { target: textarea });
    expect(handleGridCellEntryKeyDown(event)).toBe(false);
  });

  it("exits via F2 toggle when inside an entered cell", () => {
    const { cells, cleanup } = buildGrid();
    cleanupFn = cleanup;
    const cell = cells[0][0];
    const button = document.createElement("button");
    cell.appendChild(button);

    button.focus();
    const event = makeKeyEvent("F2", cell, { target: button });
    const consumed = handleGridCellEntryKeyDown(event);

    expect(consumed).toBe(true);
    expect(document.activeElement).toBe(cell);
  });

  it("consumes Enter inside an entered cell (belongs to the control)", () => {
    const { cells, cleanup } = buildGrid();
    cleanupFn = cleanup;
    const cell = cells[0][0];
    const button = document.createElement("button");
    cell.appendChild(button);

    button.focus();
    const event = makeKeyEvent("Enter", cell, { target: button });
    // Inside the cell, Enter belongs to the control — consumed to prevent navigation
    expect(handleGridCellEntryKeyDown(event)).toBe(true);
  });

  it("prefers data-grid-primary-editor as entry target", () => {
    const { cells, cleanup } = buildGrid();
    cleanupFn = cleanup;
    const cell = cells[0][0];
    const secondary = document.createElement("button");
    secondary.textContent = "Secondary";
    const primary = document.createElement("button");
    primary.textContent = "Primary";
    primary.setAttribute("data-grid-primary-editor", "");
    cell.appendChild(secondary);
    cell.appendChild(primary);

    cell.focus();
    const event = makeKeyEvent("Enter", cell);
    handleGridCellEntryKeyDown(event);

    expect(document.activeElement).toBe(primary);
  });
});

describe("handleGridCellKeyDown — selection keys", () => {
  it("Space toggles row selection when on the cell itself", () => {
    const { cells, cleanup } = buildGrid();
    cleanupFn = cleanup;
    const cell = cells[0][0];
    const toggleRow = vi.fn();
    const selection: GridSelectionHandlers = {
      onToggleRowSelection: toggleRow,
    };

    cell.focus();
    const event = makeKeyEvent(" ", cell);
    handleGridCellKeyDown(event, undefined, selection);

    expect(toggleRow).toHaveBeenCalledWith("r0");
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("Ctrl+A selects all rows", () => {
    const { cells, cleanup } = buildGrid();
    cleanupFn = cleanup;
    const cell = cells[0][0];
    const selectAll = vi.fn();
    const selection: GridSelectionHandlers = { onSelectAllRows: selectAll };

    cell.focus();
    const event = makeKeyEvent("a", cell, { ctrlKey: true });
    handleGridCellKeyDown(event, undefined, selection);

    expect(selectAll).toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("Meta+A also selects all rows (Mac)", () => {
    const { cells, cleanup } = buildGrid();
    cleanupFn = cleanup;
    const cell = cells[0][0];
    const selectAll = vi.fn();
    const selection: GridSelectionHandlers = { onSelectAllRows: selectAll };

    cell.focus();
    const event = makeKeyEvent("a", cell, { metaKey: true });
    handleGridCellKeyDown(event, undefined, selection);

    expect(selectAll).toHaveBeenCalled();
  });

  /*
   * ISS-7493 (whitlockk review, PR #7424). `GridCellKeyEvent.key` is typed `string`
   * and both grids hand this handler a React keydown, but the events that reach
   * a grid are not all ones this side constructed — a synthetic keydown can
   * carry no `key`, or a non-string one. The chord matcher lowercases `key`, so
   * without the guard each case below throws out of the host's keydown handler
   * instead of falling through.
   *
   * The casts are the point rather than a convenience: the type FORBIDS these
   * inputs and the runtime delivers them anyway, which is the trust-boundary
   * carve-out AGENTS.md names.
   *
   * A NO-OP, spelled out as three separate claims, because "did not crash" is
   * the weakest of them and the other two are what a user would actually
   * notice: nothing is selected, and the browser's own Ctrl+A is not
   * suppressed — `preventDefault` on an unmatched chord would leave a user
   * unable to select text anywhere the grid is mounted. The handler returns
   * `void`, so those three are the whole observable surface.
   */
  const unusableSelectAllKeys: ReadonlyArray<readonly [string, unknown]> = [
    ["absent", undefined],
    ["null", null],
    ["a non-string", 42],
  ];

  for (const [label, key] of unusableSelectAllKeys) {
    it(`Ctrl+A with ${label} key is a no-op (ISS-7493)`, () => {
      const { cells, cleanup } = buildGrid();
      cleanupFn = cleanup;
      const cell = cells[0][0];
      const selectAll = vi.fn();
      const selection: GridSelectionHandlers = { onSelectAllRows: selectAll };

      cell.focus();
      const event = {
        ...makeKeyEvent("a", cell, { ctrlKey: true }),
        key,
      } as unknown as ReturnType<typeof makeKeyEvent>;

      expect(() =>
        handleGridCellKeyDown(event, undefined, selection)
      ).not.toThrow();
      expect(selectAll).not.toHaveBeenCalled();
      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it(`Meta+A with ${label} key is a no-op too (ISS-7493)`, () => {
      const { cells, cleanup } = buildGrid();
      cleanupFn = cleanup;
      const cell = cells[0][0];
      const selectAll = vi.fn();
      const selection: GridSelectionHandlers = { onSelectAllRows: selectAll };

      cell.focus();
      const event = {
        ...makeKeyEvent("a", cell, { metaKey: true }),
        key,
      } as unknown as ReturnType<typeof makeKeyEvent>;

      expect(() =>
        handleGridCellKeyDown(event, undefined, selection)
      ).not.toThrow();
      expect(selectAll).not.toHaveBeenCalled();
      expect(event.preventDefault).not.toHaveBeenCalled();
    });
  }

  it("Space with modifiers does not toggle selection", () => {
    const { cells, cleanup } = buildGrid();
    cleanupFn = cleanup;
    const cell = cells[0][0];
    const toggleRow = vi.fn();
    const selection: GridSelectionHandlers = {
      onToggleRowSelection: toggleRow,
    };

    cell.focus();
    const event = makeKeyEvent(" ", cell, { ctrlKey: true });
    handleGridCellKeyDown(event, undefined, selection);

    expect(toggleRow).not.toHaveBeenCalled();
  });

  it("selection keys are not claimed when focus is inside an entered control", () => {
    const { cells, cleanup } = buildGrid();
    cleanupFn = cleanup;
    const cell = cells[0][0];
    const button = document.createElement("button");
    cell.appendChild(button);
    const toggleRow = vi.fn();
    const selection: GridSelectionHandlers = {
      onToggleRowSelection: toggleRow,
    };

    button.focus();
    const event = makeKeyEvent(" ", cell, { target: button });
    handleGridCellKeyDown(event, undefined, selection);

    expect(toggleRow).not.toHaveBeenCalled();
  });
});

describe("handleGridCellKeyDown — expansion keys", () => {
  it("ArrowRight expands a collapsed expandable row", () => {
    const { cells, cleanup } = buildGrid();
    cleanupFn = cleanup;
    const cell = cells[0][0];
    const setExpanded = vi.fn();
    const expansion: GridRowExpansionHandlers = {
      canExpandRow: () => true,
      isRowExpanded: () => false,
      setRowExpanded: setExpanded,
    };

    cell.focus();
    const event = makeKeyEvent("ArrowRight", cell);
    handleGridCellKeyDown(event, undefined, undefined, expansion);

    expect(setExpanded).toHaveBeenCalledWith("r0", true);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("ArrowLeft collapses an expanded expandable row", () => {
    const { cells, cleanup } = buildGrid();
    cleanupFn = cleanup;
    const cell = cells[0][0];
    const setExpanded = vi.fn();
    const expansion: GridRowExpansionHandlers = {
      canExpandRow: () => true,
      isRowExpanded: () => true,
      setRowExpanded: setExpanded,
    };

    cell.focus();
    const event = makeKeyEvent("ArrowLeft", cell);
    handleGridCellKeyDown(event, undefined, undefined, expansion);

    expect(setExpanded).toHaveBeenCalledWith("r0", false);
  });

  it("ArrowRight on already-expanded falls through to navigation", () => {
    const { cells, cleanup } = buildGrid();
    cleanupFn = cleanup;
    const cell = cells[0][0];
    const setExpanded = vi.fn();
    const expansion: GridRowExpansionHandlers = {
      canExpandRow: () => true,
      isRowExpanded: () => true,
      setRowExpanded: setExpanded,
    };

    cell.focus();
    const event = makeKeyEvent("ArrowRight", cell);
    handleGridCellKeyDown(event, undefined, undefined, expansion);

    // Not claimed by expansion — falls through to navigation
    expect(setExpanded).not.toHaveBeenCalled();
  });

  it("expansion keys do not fire on non-expandable rows", () => {
    const { cells, cleanup } = buildGrid();
    cleanupFn = cleanup;
    const cell = cells[0][0];
    const setExpanded = vi.fn();
    const expansion: GridRowExpansionHandlers = {
      canExpandRow: () => false,
      isRowExpanded: () => false,
      setRowExpanded: setExpanded,
    };

    cell.focus();
    const event = makeKeyEvent("ArrowRight", cell);
    handleGridCellKeyDown(event, undefined, undefined, expansion);

    expect(setExpanded).not.toHaveBeenCalled();
  });

  it("expansion keys do not fire with modifiers", () => {
    const { cells, cleanup } = buildGrid();
    cleanupFn = cleanup;
    const cell = cells[0][0];
    const setExpanded = vi.fn();
    const expansion: GridRowExpansionHandlers = {
      canExpandRow: () => true,
      isRowExpanded: () => false,
      setRowExpanded: setExpanded,
    };

    cell.focus();
    const event = makeKeyEvent("ArrowRight", cell, { ctrlKey: true });
    handleGridCellKeyDown(event, undefined, undefined, expansion);

    expect(setExpanded).not.toHaveBeenCalled();
  });
});

describe("handleGridCellKeyDown — navigation + callback", () => {
  it("calls onKeyboardNavigate with the destination row id", () => {
    const { cells, cleanup } = buildGrid();
    cleanupFn = cleanup;
    const cell = cells[0][0];
    const navigate = vi.fn();

    cell.focus();
    const event = makeKeyEvent("ArrowDown", cell);
    handleGridCellKeyDown(event, navigate);

    expect(navigate).toHaveBeenCalledWith("r1", expect.anything());
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("clicks the destination cell when no onKeyboardNavigate is wired", () => {
    const { cells, cleanup } = buildGrid();
    cleanupFn = cleanup;
    const cell = cells[0][0];
    const clickSpy = vi.spyOn(cells[1][0], "click");

    cell.focus();
    const event = makeKeyEvent("ArrowDown", cell);
    handleGridCellKeyDown(event);

    expect(clickSpy).toHaveBeenCalled();
  });

  it("does not navigate at the grid edge", () => {
    const { cells, cleanup } = buildGrid();
    cleanupFn = cleanup;
    const cell = cells[0][0];
    const navigate = vi.fn();

    cell.focus();
    const event = makeKeyEvent("ArrowUp", cell);
    handleGridCellKeyDown(event, navigate);

    // At the top edge — no navigation
    expect(navigate).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
