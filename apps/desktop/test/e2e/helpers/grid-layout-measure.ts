/**
 * Real-layout measurement helpers for the desktop `GridTable` E2E specs.
 *
 * Column alignment is the one class of UI defect a class assertion cannot
 * decide. ISS-5333 is the case in point: `justify-end` sat on the header cell
 * the entire time the label was rendering left, because a sortable header wraps
 * its label in a `flex-1` button that consumed the cell's free space. The jsdom
 * suite has to execute the flexbox rule by hand (walk label → cell, first
 * `justify-end` ancestor wins unless something between them grows); a driven
 * browser does not, so a desktop spec measures bounding boxes instead.
 *
 * Its own module rather than private helpers in one spec: these are generic over
 * `GridTable`'s `role="columnheader"` / `data-column-id` contract, carry no
 * spec-specific state, and the alternative is the next alignment spec
 * copy-pasting six functions (AGENTS.md — extract a shared helper rather than
 * duplicate one).
 */

import { expect, type Locator, type Page } from "@playwright/test";

/**
 * How far apart two right edges may land and still count as aligned.
 *
 * Two right-aligned boxes in one column share an x give or take sub-pixel
 * rounding on a fractional grid track. Well under a glyph — far tighter than the
 * width any two differing renderings differ by, so this cannot absorb a real
 * misalignment.
 */
export const GRID_ALIGNMENT_TOLERANCE_PX = 1.5;

/** The label element inside a column's header cell. */
export function gridHeaderLabel(page: Page, columnId: string): Locator {
  return page
    .locator(`[role="columnheader"][data-column-id="${columnId}"]`)
    .locator("span")
    .last();
}

/** The rendered value element in one row's column cell. */
export function gridCellIn(row: Locator, columnId: string): Locator {
  return row.locator(`[data-column-id="${columnId}"] span`).last();
}

/**
 * The grid row containing `text`. Scoping every measurement to its own row stops
 * a matching string elsewhere on the page — a summary strip rendering the same
 * metric, say — from satisfying it.
 */
export function gridRowWithText(page: Page, text: string): Locator {
  return page.getByRole("row").filter({ hasText: text });
}

/** Two elements' right edges land on the same x, within sub-pixel rounding. */
export async function expectRightEdgesAligned(
  a: Locator,
  b: Locator
): Promise<void> {
  const boxA = await gridLayoutBox(a);
  const boxB = await gridLayoutBox(b);
  expect(Math.abs(rightEdgePx(boxA) - rightEdgePx(boxB))).toBeLessThanOrEqual(
    GRID_ALIGNMENT_TOLERANCE_PX
  );
}

/** Two elements' LEFT edges land on the same x — the uniformly-left-aligned state. */
export async function expectLeftEdgesAligned(
  a: Locator,
  b: Locator
): Promise<void> {
  const boxA = await gridLayoutBox(a);
  const boxB = await gridLayoutBox(b);
  expect(Math.abs(boxA.x - boxB.x)).toBeLessThanOrEqual(
    GRID_ALIGNMENT_TOLERANCE_PX
  );
}

/**
 * The element's layout box, or a thrown failure. A missing box means the element
 * is not laid out at all, which must fail loudly rather than silently skip the
 * measurement it was fetched for.
 */
export async function gridLayoutBox(
  locator: Locator
): Promise<{ x: number; width: number }> {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error("expected the measured element to have a layout box");
  }
  return box;
}

function rightEdgePx(box: { x: number; width: number }): number {
  return box.x + box.width;
}
