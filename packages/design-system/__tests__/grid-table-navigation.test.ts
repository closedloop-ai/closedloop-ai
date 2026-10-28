/**
 * Pure-DOM coverage for the GridTable v2 keyboard navigation contract
 * (`packages/design-system/lib/grid-table-navigation.ts`). No React, so a
 * synthetic `data-grid-body` / `data-grid-row` / `data-grid-cell` tree stands
 * in for a rendered grid.
 */

import {
  focusCellFromRowClick,
  GRID_PAGE_ROW_COUNT,
  GridNavigationKey,
  isGridRowJumpKey,
  isInteractiveRowClickTarget,
  ownsItsOwnKeys,
  resolveNextGridCell,
  resolveRowWiseDestinationIndex,
  shouldSkipGridNavigation,
} from "@closedloop-ai/design-system/lib/grid-table-navigation";
import { afterEach, describe, expect, it } from "vitest";

type GridFixture = {
  body: HTMLElement;
  rows: HTMLElement[];
  cells: HTMLElement[][];
};

function buildGrid(rowCellCounts: number[]): GridFixture {
  const body = document.createElement("div");
  body.setAttribute("data-grid-body", "");

  const rows: HTMLElement[] = [];
  const cells: HTMLElement[][] = [];

  rowCellCounts.forEach((cellCount, rowIndex) => {
    const row = document.createElement("div");
    row.setAttribute("data-grid-row", "");
    row.setAttribute("data-grid-row-id", `r${rowIndex}`);

    const rowCells: HTMLElement[] = [];
    for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
      const cell = document.createElement("div");
      cell.setAttribute("data-grid-cell", "");
      cell.setAttribute("tabindex", "-1");
      cell.textContent = `r${rowIndex}c${cellIndex}`;
      row.appendChild(cell);
      rowCells.push(cell);
    }

    body.appendChild(row);
    rows.push(row);
    cells.push(rowCells);
  });

  document.body.appendChild(body);
  return { body, cells, rows };
}

const NO_MODIFIERS = { altKey: false, ctrlKey: false, metaKey: false };

afterEach(() => {
  document.body.innerHTML = "";
});

describe("isInteractiveRowClickTarget", () => {
  it("is false for a plain click with no interactive ancestor", () => {
    const cell = document.createElement("div");
    const target = document.createElement("span");
    cell.appendChild(target);

    expect(isInteractiveRowClickTarget(target)).toBe(false);
  });

  it("is true when the target IS the interactive element", () => {
    const button = document.createElement("button");

    expect(isInteractiveRowClickTarget(button)).toBe(true);
  });

  it("is true for a click on content NESTED inside an interactive ancestor", () => {
    const link = document.createElement("a");
    const icon = document.createElement("span");
    link.appendChild(icon);

    expect(isInteractiveRowClickTarget(icon)).toBe(true);
  });

  it("is true for the data-no-row-select opt-out marker", () => {
    const marker = document.createElement("div");
    marker.setAttribute("data-no-row-select", "");

    expect(isInteractiveRowClickTarget(marker)).toBe(true);
  });

  it("is true for an ARIA role='button' element", () => {
    const pseudoButton = document.createElement("div");
    pseudoButton.setAttribute("role", "button");

    expect(isInteractiveRowClickTarget(pseudoButton)).toBe(true);
  });

  it("is FALSE when a data-row-selection-surface ancestor opts back into row selection, even over an interactive control", () => {
    const surface = document.createElement("div");
    surface.setAttribute("data-row-selection-surface", "");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    surface.appendChild(checkbox);

    expect(isInteractiveRowClickTarget(checkbox)).toBe(false);
  });

  it("is false when the target itself is the row-selection-surface element", () => {
    const surface = document.createElement("div");
    surface.setAttribute("data-row-selection-surface", "");

    expect(isInteractiveRowClickTarget(surface)).toBe(false);
  });
});

describe("focusCellFromRowClick", () => {
  it("focuses and returns the ancestor cell for a click on nested content", () => {
    const { cells } = buildGrid([2]);
    const cell = cells[0][1];
    const nestedText = document.createElement("span");
    cell.appendChild(nestedText);

    const result = focusCellFromRowClick(nestedText);

    expect(result).toBe(cell);
    expect(document.activeElement).toBe(cell);
  });

  it("returns null and leaves focus untouched when there is no cell ancestor", () => {
    const outsider = document.createElement("div");
    document.body.appendChild(outsider);
    const activeBefore = document.activeElement;

    const result = focusCellFromRowClick(outsider);

    expect(result).toBeNull();
    expect(document.activeElement).toBe(activeBefore);
  });
});

describe("resolveNextGridCell — arrow keys on a uniform grid", () => {
  it("ArrowLeft moves to the previous cell in the row", () => {
    const { cells } = buildGrid([3, 3, 3]);
    const result = resolveNextGridCell(
      cells[1][1],
      GridNavigationKey.ArrowLeft
    );
    expect(result).toBe(cells[1][0]);
  });

  it("ArrowLeft off the first column leaves the grid (null)", () => {
    const { cells } = buildGrid([3, 3, 3]);
    const result = resolveNextGridCell(
      cells[1][0],
      GridNavigationKey.ArrowLeft
    );
    expect(result).toBeNull();
  });

  it("ArrowRight moves to the next cell in the row", () => {
    const { cells } = buildGrid([3, 3, 3]);
    const result = resolveNextGridCell(
      cells[1][1],
      GridNavigationKey.ArrowRight
    );
    expect(result).toBe(cells[1][2]);
  });

  it("ArrowRight off the last column leaves the grid (null)", () => {
    const { cells } = buildGrid([3, 3, 3]);
    const result = resolveNextGridCell(
      cells[1][2],
      GridNavigationKey.ArrowRight
    );
    expect(result).toBeNull();
  });

  it("ArrowUp moves to the same column in the previous row", () => {
    const { cells } = buildGrid([3, 3, 3]);
    const result = resolveNextGridCell(cells[1][1], GridNavigationKey.ArrowUp);
    expect(result).toBe(cells[0][1]);
  });

  it("ArrowUp off the first row leaves the grid (null)", () => {
    const { cells } = buildGrid([3, 3, 3]);
    const result = resolveNextGridCell(cells[0][1], GridNavigationKey.ArrowUp);
    expect(result).toBeNull();
  });

  it("ArrowDown moves to the same column in the next row", () => {
    const { cells } = buildGrid([3, 3, 3]);
    const result = resolveNextGridCell(
      cells[1][1],
      GridNavigationKey.ArrowDown
    );
    expect(result).toBe(cells[2][1]);
  });

  it("ArrowDown off the last row leaves the grid (null)", () => {
    const { cells } = buildGrid([3, 3, 3]);
    const result = resolveNextGridCell(
      cells[2][1],
      GridNavigationKey.ArrowDown
    );
    expect(result).toBeNull();
  });
});

describe("resolveNextGridCell — Home/End are row-scoped, not edge-stopping", () => {
  it("Home moves to the first cell of THIS row", () => {
    const { cells } = buildGrid([3, 3, 3]);
    const result = resolveNextGridCell(cells[1][2], GridNavigationKey.Home);
    expect(result).toBe(cells[1][0]);
  });

  it("Home on the row's own first cell resolves to that same cell rather than null", () => {
    const { cells } = buildGrid([3, 3, 3]);
    const result = resolveNextGridCell(cells[1][0], GridNavigationKey.Home);
    expect(result).toBe(cells[1][0]);
  });

  it("End moves to the last cell of THIS row", () => {
    const { cells } = buildGrid([3, 3, 3]);
    const result = resolveNextGridCell(cells[1][0], GridNavigationKey.End);
    expect(result).toBe(cells[1][2]);
  });

  it("End on the row's own last cell resolves to that same cell rather than null", () => {
    const { cells } = buildGrid([3, 3, 3]);
    const result = resolveNextGridCell(cells[1][2], GridNavigationKey.End);
    expect(result).toBe(cells[1][2]);
  });
});

describe("resolveNextGridCell — treegrid Home/End traverse visible rows", () => {
  it("moves End to the first cell of the last visible row", () => {
    const { cells } = buildGrid([3, 3, 3]);
    const result = resolveNextGridCell(cells[0][0], GridNavigationKey.End, {
      homeEndByRow: true,
    });

    expect(result).toBe(cells[2][0]);
  });

  it("moves Home to the first cell of the first visible row", () => {
    const { cells } = buildGrid([3, 3, 3]);
    const result = resolveNextGridCell(cells[2][2], GridNavigationKey.Home, {
      homeEndByRow: true,
    });

    expect(result).toBe(cells[0][0]);
  });
});

describe("resolveNextGridCell — Ctrl+Home/Ctrl+End are grid extremes", () => {
  it("Ctrl+Home lands on the FIRST cell of the grid, not the current column", () => {
    const { cells } = buildGrid([3, 3, 3]);
    const result = resolveNextGridCell(cells[1][2], GridNavigationKey.Home, {
      ctrlKey: true,
    });
    expect(result).toBe(cells[0][0]);
  });

  it("Ctrl+End lands on the LAST cell of the grid, not the current column", () => {
    const { cells } = buildGrid([3, 3, 3]);
    const result = resolveNextGridCell(cells[1][0], GridNavigationKey.End, {
      ctrlKey: true,
    });
    expect(result).toBe(cells[2][2]);
  });

  it("Ctrl+Home from the grid's own first cell resolves to that same cell", () => {
    const { cells } = buildGrid([3, 3, 3]);
    const result = resolveNextGridCell(cells[0][0], GridNavigationKey.Home, {
      ctrlKey: true,
    });
    expect(result).toBe(cells[0][0]);
  });

  it("Ctrl+End from the grid's own last cell resolves to that same cell", () => {
    const { cells } = buildGrid([3, 3, 3]);
    const result = resolveNextGridCell(cells[2][2], GridNavigationKey.End, {
      ctrlKey: true,
    });
    expect(result).toBe(cells[2][2]);
  });
});

describe("resolveNextGridCell — PageUp/PageDown clamp instead of leaving the grid", () => {
  // 15 rows so a page (GRID_PAGE_ROW_COUNT = 10) both moves cleanly and clamps.
  it("PageDown moves GRID_PAGE_ROW_COUNT rows down when that lands inside the grid", () => {
    const { cells } = buildGrid(new Array(15).fill(2));
    const result = resolveNextGridCell(cells[3][1], GridNavigationKey.PageDown);
    expect(result).toBe(cells[13][1]);
  });

  it("PageDown clamps to the LAST row instead of overshooting", () => {
    const { cells } = buildGrid(new Array(15).fill(2));
    const result = resolveNextGridCell(
      cells[12][1],
      GridNavigationKey.PageDown
    );
    expect(result).toBe(cells[14][1]);
  });

  it("PageDown on the grid's own last row resolves to that same cell, not null", () => {
    const { cells } = buildGrid(new Array(15).fill(2));
    const result = resolveNextGridCell(
      cells[14][1],
      GridNavigationKey.PageDown
    );
    expect(result).toBe(cells[14][1]);
  });

  it("PageUp moves GRID_PAGE_ROW_COUNT rows up when that lands inside the grid", () => {
    const { cells } = buildGrid(new Array(15).fill(2));
    const result = resolveNextGridCell(cells[12][1], GridNavigationKey.PageUp);
    expect(result).toBe(cells[2][1]);
  });

  it("PageUp clamps to the FIRST row instead of undershooting", () => {
    const { cells } = buildGrid(new Array(15).fill(2));
    const result = resolveNextGridCell(cells[3][1], GridNavigationKey.PageUp);
    expect(result).toBe(cells[0][1]);
  });

  it("PageUp on the grid's own first row resolves to that same cell, not null", () => {
    const { cells } = buildGrid(new Array(15).fill(2));
    const result = resolveNextGridCell(cells[0][1], GridNavigationKey.PageUp);
    expect(result).toBe(cells[0][1]);
  });
});

describe("resolveNextGridCell — defensive branches with no reachable answer", () => {
  it("returns null when the current cell has no data-grid-row ancestor", () => {
    const orphan = document.createElement("div");
    orphan.setAttribute("data-grid-cell", "");
    document.body.appendChild(orphan);

    const result = resolveNextGridCell(orphan, GridNavigationKey.ArrowRight);
    expect(result).toBeNull();
  });

  it("returns null when the row has no data-grid-body ancestor", () => {
    const row = document.createElement("div");
    row.setAttribute("data-grid-row", "");
    const cell = document.createElement("div");
    cell.setAttribute("data-grid-cell", "");
    row.appendChild(cell);
    // Deliberately NOT wrapped in a [data-grid-body] element.
    document.body.appendChild(row);

    const result = resolveNextGridCell(cell, GridNavigationKey.ArrowRight);
    expect(result).toBeNull();
  });

  it("returns null when the current cell is not among its row's own [data-grid-cell] children", () => {
    const { rows } = buildGrid([2]);
    const notACell = document.createElement("div");
    rows[0].appendChild(notACell);

    const result = resolveNextGridCell(notACell, GridNavigationKey.ArrowRight);
    expect(result).toBeNull();
  });
});

describe("resolveNextGridCell — short destination row column resolution (ISS-8219)", () => {
  it("matches the destination cell declaring the SAME aria-colindex over DOM position", () => {
    const body = document.createElement("div");
    body.setAttribute("data-grid-body", "");

    const fullRow = document.createElement("div");
    fullRow.setAttribute("data-grid-row", "");
    const favoriteCell = document.createElement("div");
    favoriteCell.setAttribute("data-grid-cell", "");
    favoriteCell.setAttribute("aria-colindex", "1");
    const identityCell = document.createElement("div");
    identityCell.setAttribute("data-grid-cell", "");
    identityCell.setAttribute("aria-colindex", "2");
    fullRow.append(favoriteCell, identityCell);
    // identityCell is at DOM index 1 in fullRow.

    const shortRow = document.createElement("div");
    shortRow.setAttribute("data-grid-row", "");
    // The LOGICAL match (aria-colindex 2) sits at DOM index 0 here, and a decoy
    // cell sits at DOM index 1 — the DOM index a naive fallback would pick for
    // a move starting from identityCell. If the fallback ever won over the
    // aria-colindex match, this assertion would catch it by landing on decoyCell.
    const affordanceCell = document.createElement("div");
    affordanceCell.setAttribute("data-grid-cell", "");
    affordanceCell.setAttribute("aria-colindex", "2");
    const decoyCell = document.createElement("div");
    decoyCell.setAttribute("data-grid-cell", "");
    decoyCell.setAttribute("aria-colindex", "99");
    shortRow.append(affordanceCell, decoyCell);

    body.append(fullRow, shortRow);
    document.body.appendChild(body);

    const result = resolveNextGridCell(
      identityCell,
      GridNavigationKey.ArrowDown
    );
    expect(result).toBe(affordanceCell);
  });

  it("falls back to the DOM index when neither side declares aria-colindex", () => {
    const { rows, cells } = buildGrid([3]);
    const shortRow = document.createElement("div");
    shortRow.setAttribute("data-grid-row", "");
    const targetCellAtIndex1 = document.createElement("div");
    targetCellAtIndex1.setAttribute("data-grid-cell", "");
    const otherCell = document.createElement("div");
    otherCell.setAttribute("data-grid-cell", "");
    shortRow.append(otherCell, targetCellAtIndex1);
    (rows[0].parentElement as HTMLElement).appendChild(shortRow);

    // Source cell is index 1 (middle of 3); destination row has 2 cells, so
    // index 1 exists there too.
    const result = resolveNextGridCell(
      cells[0][1],
      GridNavigationKey.ArrowDown
    );
    expect(result).toBe(targetCellAtIndex1);
  });

  it("falls back to the LAST cell when the DOM index has no counterpart either", () => {
    const { rows, cells } = buildGrid([3]);
    const shortRow = document.createElement("div");
    shortRow.setAttribute("data-grid-row", "");
    const onlyCell = document.createElement("div");
    onlyCell.setAttribute("data-grid-cell", "");
    shortRow.appendChild(onlyCell);
    (rows[0].parentElement as HTMLElement).appendChild(shortRow);

    // Source cell is index 2 (last of 3); destination row has only 1 cell, so
    // index 2 does not exist there and the DOM-index fallback also misses.
    const result = resolveNextGridCell(
      cells[0][2],
      GridNavigationKey.ArrowDown
    );
    expect(result).toBe(onlyCell);
  });
});

describe("shouldSkipGridNavigation", () => {
  it("skips when Alt is held, regardless of key", () => {
    const result = shouldSkipGridNavigation(GridNavigationKey.ArrowDown, null, {
      ...NO_MODIFIERS,
      altKey: true,
    });
    expect(result).toBe(true);
  });

  it("skips when Meta is held, regardless of key", () => {
    const result = shouldSkipGridNavigation(GridNavigationKey.Home, null, {
      ...NO_MODIFIERS,
      metaKey: true,
    });
    expect(result).toBe(true);
  });

  it("skips a non-navigation key even with no modifiers", () => {
    const result = shouldSkipGridNavigation("a", null, NO_MODIFIERS);
    expect(result).toBe(true);
  });

  it("skips a non-navigation key even when Ctrl is held (order pins the NAVIGATION_KEYS check ahead of the ctrl-chord check)", () => {
    const result = shouldSkipGridNavigation("Escape", null, {
      ...NO_MODIFIERS,
      ctrlKey: true,
    });
    expect(result).toBe(true);
  });

  it("skips Ctrl+ArrowDown — Ctrl only belongs to the grid for Home/End", () => {
    const result = shouldSkipGridNavigation(GridNavigationKey.ArrowDown, null, {
      ...NO_MODIFIERS,
      ctrlKey: true,
    });
    expect(result).toBe(true);
  });

  it("does NOT skip Ctrl+Home on a non-text-input target", () => {
    const result = shouldSkipGridNavigation(GridNavigationKey.Home, null, {
      ...NO_MODIFIERS,
      ctrlKey: true,
    });
    expect(result).toBe(false);
  });

  it("does NOT skip Ctrl+End on a non-text-input target", () => {
    const result = shouldSkipGridNavigation(GridNavigationKey.End, null, {
      ...NO_MODIFIERS,
      ctrlKey: true,
    });
    expect(result).toBe(false);
  });

  it("does not skip a plain navigation key with no modifiers and no target", () => {
    const result = shouldSkipGridNavigation(
      GridNavigationKey.ArrowDown,
      null,
      NO_MODIFIERS
    );
    expect(result).toBe(false);
  });

  it("does not skip a plain navigation key over a non-text target", () => {
    const div = document.createElement("div");
    const result = shouldSkipGridNavigation(
      GridNavigationKey.PageUp,
      div,
      NO_MODIFIERS
    );
    expect(result).toBe(false);
  });

  it("skips a navigation key when the target is a text input", () => {
    const input = document.createElement("input");
    const result = shouldSkipGridNavigation(
      GridNavigationKey.ArrowLeft,
      input,
      NO_MODIFIERS
    );
    expect(result).toBe(true);
  });

  it("skips a navigation key when the target is a textarea", () => {
    const textarea = document.createElement("textarea");
    const result = shouldSkipGridNavigation(
      GridNavigationKey.ArrowLeft,
      textarea,
      NO_MODIFIERS
    );
    expect(result).toBe(true);
  });

  it("skips a navigation key when the target is a select", () => {
    const select = document.createElement("select");
    const result = shouldSkipGridNavigation(
      GridNavigationKey.ArrowLeft,
      select,
      NO_MODIFIERS
    );
    expect(result).toBe(true);
  });
});

describe("ownsItsOwnKeys", () => {
  it("is true for an input", () => {
    expect(ownsItsOwnKeys(document.createElement("input"))).toBe(true);
  });

  it("is true for a textarea", () => {
    expect(ownsItsOwnKeys(document.createElement("textarea"))).toBe(true);
  });

  it("is true for a select", () => {
    expect(ownsItsOwnKeys(document.createElement("select"))).toBe(true);
  });

  it("is false for a plain div", () => {
    expect(ownsItsOwnKeys(document.createElement("div"))).toBe(false);
  });

  it("is false for null", () => {
    expect(ownsItsOwnKeys(null)).toBe(false);
  });
});

/**
 * The index half of a row-wise move (ISS-12288). The DOM walk above resolves
 * against the rows a body PAINTED; a windowed body resolves against the rows it
 * HAS, and these two answers have to agree wherever both are defined — which is
 * why the walk reads this function rather than carrying its own copy.
 */
describe("resolveRowWiseDestinationIndex", () => {
  const destination = (
    key: string,
    rowIndex: number,
    modifiers: { ctrlKey?: boolean } = {},
    rowCount = 500
  ) => resolveRowWiseDestinationIndex({ key, modifiers, rowCount, rowIndex });

  it("steps to the neighbour", () => {
    expect(destination(GridNavigationKey.ArrowDown, 10)).toBe(11);
    expect(destination(GridNavigationKey.ArrowUp, 10)).toBe(9);
  });

  it("returns null at the population's edges", () => {
    expect(destination(GridNavigationKey.ArrowUp, 0)).toBeNull();
    expect(destination(GridNavigationKey.ArrowDown, 499)).toBeNull();
  });

  it("jumps a page and clamps inside the population", () => {
    expect(destination(GridNavigationKey.PageDown, 10)).toBe(
      10 + GRID_PAGE_ROW_COUNT
    );
    expect(destination(GridNavigationKey.PageUp, 2)).toBe(0);
    expect(destination(GridNavigationKey.PageDown, 497)).toBe(499);
  });

  it("resolves the grid extremes against the whole population", () => {
    expect(destination(GridNavigationKey.Home, 250, { ctrlKey: true })).toBe(0);
    expect(destination(GridNavigationKey.End, 250, { ctrlKey: true })).toBe(
      499
    );
  });

  it("claims no move for a key that is not row-wise", () => {
    expect(destination(GridNavigationKey.ArrowLeft, 10)).toBeNull();
    expect(destination(GridNavigationKey.Home, 10)).toBeNull();
    expect(destination("x", 10)).toBeNull();
  });

  it("claims no move for a row it does not hold", () => {
    expect(destination(GridNavigationKey.ArrowDown, -1)).toBeNull();
    expect(destination(GridNavigationKey.ArrowDown, 0, {}, 0)).toBeNull();
  });
});

describe("isGridRowJumpKey", () => {
  it("is true for the keys a window edge would clamp wrongly", () => {
    expect(isGridRowJumpKey(GridNavigationKey.PageDown, {})).toBe(true);
    expect(isGridRowJumpKey(GridNavigationKey.PageUp, {})).toBe(true);
    expect(isGridRowJumpKey(GridNavigationKey.End, { ctrlKey: true })).toBe(
      true
    );
    expect(isGridRowJumpKey(GridNavigationKey.Home, { ctrlKey: true })).toBe(
      true
    );
  });

  it("is false for a step, and for the un-chorded extremes", () => {
    expect(isGridRowJumpKey(GridNavigationKey.ArrowDown, {})).toBe(false);
    expect(isGridRowJumpKey(GridNavigationKey.End, {})).toBe(false);
    expect(
      isGridRowJumpKey(GridNavigationKey.PageDown, { ctrlKey: true })
    ).toBe(false);
  });
});
