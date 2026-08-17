/**
 * DOM helpers shared by `grid-table.stories.tsx`'s `play` functions (ISS-4517).
 *
 * They live outside the story file because it is already close to the
 * 1,000-line lint ceiling, and they read `data-*` hooks rather than roles
 * because a GridTable cell's column identity is carried by `data-column-id` —
 * there is no accessible name that distinguishes one column's cells from
 * another's.
 *
 * For that same file-size reason this module now also holds the `play` BODIES
 * themselves (`playColumnOrderAlignment`, `playKeyboardResize`), so the story
 * file keeps only a one-line call site per story.
 */

import {
  COLUMN_RESIZE_KEYBOARD_STEP_PX,
  MIN_COLUMN_WIDTH_PX,
} from "@repo/design-system/lib/column-order";
import { expect, userEvent, within } from "storybook/test";

/** Matches every column reorder handle, whatever the column is labelled. */
export const REORDER_HANDLE_NAME = /^Reorder .+ column, use arrow keys$/;

/** Matches every column resize handle, whatever the column is labelled. */
export const RESIZE_HANDLE_NAME = /^Resize .+ column, use arrow keys$/;

/** The `<id> → <n>px` readout the resize story renders after each step. */
export const RESIZE_REPORT = /→ (\d+)px$/;

/**
 * Column ids in the header, left to right. The lead column carries no
 * `data-column-id`, so it is absent from this list on both the header and the
 * body — which is what lets the two be compared directly.
 */
export function headerColumnIds(canvasElement: HTMLElement): string[] {
  const header = Array.from(
    canvasElement.querySelectorAll('[role="row"]')
  ).find((row) => !row.hasAttribute("data-grid-row"));
  if (header === undefined) {
    throw new Error("grid table rendered no header row");
  }
  return columnIdsWithin(header);
}

/** The body rows, in render order. */
export function bodyRows(canvasElement: HTMLElement): Element[] {
  return Array.from(canvasElement.querySelectorAll("[data-grid-row]"));
}

/** Column ids of the cells inside one row or header, left to right. */
export function columnIdsWithin(container: Element): string[] {
  return Array.from(container.querySelectorAll("[data-column-id]")).map(
    (cell) => cell.getAttribute("data-column-id") ?? ""
  );
}

/** The `play` body of the `ReorderableAndHideable` story. */
export async function playColumnOrderAlignment(
  canvasElement: HTMLElement
): Promise<void> {
  const canvas = within(canvasElement);

  // Header and body must agree on column order. A grid table whose two halves
  // disagree renders every cell under the wrong heading, and because both are
  // driven from one `gridTemplateColumns` string the failure is silent.
  const before = headerColumnIds(canvasElement);
  await expect(before.length).toBeGreaterThan(1);
  for (const row of bodyRows(canvasElement)) {
    await expect(columnIdsWithin(row)).toEqual(before);
  }

  // Reorder by keyboard rather than by drag: the handle advertises arrow-key
  // operation in its own accessible name, so this is the documented path and
  // it does not depend on jsdom synthesising a drag.
  const handles = canvas.getAllByRole("button", {
    name: REORDER_HANDLE_NAME,
  });
  handles[1]?.focus();
  await userEvent.keyboard("{ArrowLeft}");

  // The moved column swapped with the one before it...
  const after = headerColumnIds(canvasElement);
  await expect(after[0]).toBe(before[1]);
  await expect(after[1]).toBe(before[0]);

  // ...and every row followed the header in the same step.
  for (const row of bodyRows(canvasElement)) {
    await expect(columnIdsWithin(row)).toEqual(after);
  }
}

/** The `play` body of the `ResizableColumns` story. */
export async function playKeyboardResize(
  canvasElement: HTMLElement
): Promise<void> {
  const canvas = within(canvasElement);
  const [handle] = canvas.getAllByRole("button", {
    name: RESIZE_HANDLE_NAME,
  });
  handle?.focus();

  // Two steps rather than one, so the assertion is the STEP SIZE and does not
  // depend on knowing the column's seeded width.
  await userEvent.keyboard("{ArrowRight}");
  const firstStep = reportedWidth(canvas);
  await userEvent.keyboard("{ArrowRight}");
  await expect(reportedWidth(canvas) - firstStep).toBe(
    COLUMN_RESIZE_KEYBOARD_STEP_PX
  );

  // Shrinking clamps at the shared floor instead of collapsing the column to
  // nothing. Far more presses than the distance needs, so the assertion is
  // that it STOPS rather than that it lands.
  for (let step = 0; step < 20; step += 1) {
    await userEvent.keyboard("{ArrowLeft}");
  }
  await expect(reportedWidth(canvas)).toBe(MIN_COLUMN_WIDTH_PX);
}

// The width the resize story reports after its most recent step. Read from the
// rendered readout rather than from the grid template, because that readout is
// what a reviewer looking at the story actually sees.
function reportedWidth(canvas: ReturnType<typeof within>): number {
  const reported = canvas.getByText(RESIZE_REPORT).textContent ?? "";
  const match = RESIZE_REPORT.exec(reported);
  if (match === null) {
    throw new Error(`no resize reported, readout was "${reported}"`);
  }
  return Number(match[1]);
}
