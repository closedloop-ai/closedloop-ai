/**
 * DOM helpers shared by the Grid Table V2 story family's `play` functions
 * (ISS-8490; `grid-table-v2-cell.stories.tsx` is a second consumer since
 * ISS-9290). A change here reaches every story that imports them.
 *
 * Every cell is addressed BY IDENTITY — a row id plus a column id — and never by
 * position: a positional `cells[n]` silently resolves to the wrong cell once the
 * column order or the leading-utility track changes, and the play then passes
 * against a grid that never handled the gesture.
 *
 * They live beside the story rather than inside it for the same reason
 * `grid-table-play-helpers.ts` does: the story file carries the harness AND its
 * fixtures, and a `.ts` under this directory is not itself indexed as a story.
 */

import { isGridChromeRowId } from "@repo/design-system/lib/grid-table-v2-chrome-rows";
import { fireEvent } from "storybook/test";

/**
 * The DATA rows this render painted, in visible order.
 *
 * Chrome rows are excluded, and that exclusion is load-bearing rather than
 * tidiness: since ISS-8930 the column-header row and every band header carry
 * `data-grid-row-id` too, so with `navigableHeaderCells` open this selector
 * returns the header FIRST. A play reading `[0]` as "the first row" then
 * addresses the header and asserts against the wrong element entirely.
 */
export function renderedRowIds(canvasElement: HTMLElement): string[] {
  return Array.from(
    canvasElement.querySelectorAll<HTMLElement>("[data-grid-row-id]")
  )
    .map((row) => row.dataset.gridRowId ?? "")
    .filter((rowId) => !isGridChromeRowId(rowId));
}

/**
 * The selected rows, in painted order, read off `aria-selected` — the attribute
 * assistive tech actually reports, so a selection that never reaches the
 * accessibility tree cannot satisfy an assertion made through this.
 */
export function selectedRowIds(canvasElement: HTMLElement): string[] {
  return Array.from(
    canvasElement.querySelectorAll<HTMLElement>(
      '[data-grid-row-id][aria-selected="true"]'
    )
  ).map((row) => row.dataset.gridRowId ?? "");
}

/**
 * Each painted group section as its header label plus the row ids under it —
 * the membership, not merely the section count, so a handler that groups by the
 * WRONG column fails here rather than passing on "some sections appeared".
 *
 * Read off the DOM rather than through `getAllByRole`, whose not-found path
 * prints the WHOLE canvas: on a grid this size that turns a one-line mismatch
 * into a dump that outlives the test timeout, so the failure never arrives.
 */
export function renderedGroups(
  canvasElement: HTMLElement
): { label: string; rowIds: string[] }[] {
  return Array.from(
    canvasElement.querySelectorAll<HTMLElement>('[role="rowgroup"]')
  ).map((section) => ({
    label: section.querySelector("[aria-expanded] span")?.textContent ?? "",
    rowIds: renderedRowIds(section),
  }));
}

/**
 * The grid's rendered column TRACKS, read off a body row's inline style.
 *
 * This is the coupling `GridTableV2` documents and cannot enforce: it reports a
 * new width and the host must fold it back into `gridTemplateColumns` itself, so
 * a host that drops the callback leaves the header and body paired to a width
 * the user did not choose. A readout the story prints for itself would not catch
 * that; the track string is what actually lays the table out.
 */
export function gridTemplateTracks(canvasElement: HTMLElement): string[] {
  const row = canvasElement.querySelector<HTMLElement>("[data-grid-row-id]");
  if (!row) {
    throw new Error("grid rendered no body rows");
  }
  return row.style.gridTemplateColumns.split(" ").filter(Boolean);
}

/** One row's cell for a NAMED column. */
export function rowCell(
  canvasElement: HTMLElement,
  rowId: string,
  columnId: string
): HTMLElement {
  const row = canvasElement.querySelector<HTMLElement>(
    `[data-grid-row-id="${rowId}"]`
  );
  if (!row) {
    throw new Error(`no rendered row for ${rowId}`);
  }
  const cell = row.querySelector<HTMLElement>(`[data-column-id="${columnId}"]`);
  if (!cell) {
    throw new Error(`no ${columnId} cell in ${rowId}`);
  }
  return cell;
}

export function focusRowCell(
  canvasElement: HTMLElement,
  rowId: string,
  columnId: string
): void {
  rowCell(canvasElement, rowId, columnId).focus();
}

/**
 * Clicks a row THROUGH one of its cells, which is where a real pointer lands:
 * the row's own handler focuses `target.closest('[data-grid-cell]')`, so a click
 * synthesized on the row element has no cell ancestor and would select the row
 * while leaving focus on `<body>` — stranding every keyboard step after it.
 *
 * `fireEvent` rather than `userEvent`, because user-event v14 drops a
 * `{ shiftKey }` passed to `click()` and the range branch would never be taken.
 */
export function clickRowCell(
  canvasElement: HTMLElement,
  rowId: string,
  columnId: string,
  modifiers: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean } = {}
): void {
  fireEvent.click(rowCell(canvasElement, rowId, columnId), modifiers);
}
