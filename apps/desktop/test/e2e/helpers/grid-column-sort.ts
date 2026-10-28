/**
 * Driving a v2 grid's column sort, for the desktop specs that assert an
 * ordering.
 *
 * ISS-8909 retired the v1 Sessions and Branches hosts, so both desktop lists
 * render the shared v2 surface. The two headers do NOT expose the same control:
 * v1 wrapped each column label in a `<button>` named by the bare label, so a
 * spec clicked `getByRole("button", { name: "Cost" })` and TOGGLED through the
 * directions. v2 renders the label as a plain `<span>` and puts sorting behind a
 * per-column options menu (`HeaderActionsMenu`) whose trigger is named
 * "<Label> column options" and whose items are "Sort ascending" / "Sort
 * descending" — so the direction is CHOSEN rather than toggled.
 *
 * One helper rather than a copy in each of the four specs that sort a column
 * (AGENTS.md — extract a shared helper rather than duplicate one), and it takes
 * the direction explicitly so a caller still states which ordering it expects
 * instead of reading back whatever the click happened to produce.
 *
 * The LEADING identity column is deliberately not covered: it keeps v1's
 * label-named button (`getLeadingAriaSort`), which is why the Branches "Name"
 * sort still resolves through `getByRole("button", { name: "Name" })`.
 */

import { expect, type Locator, type Page } from "@playwright/test";

/** The `aria-sort` value each menu item leaves on its column header. */
export const SORT_DIRECTION_ARIA = {
  ascending: "ascending",
  descending: "descending",
} as const;

export type GridSortDirection = keyof typeof SORT_DIRECTION_ARIA;

/** The `DropdownMenuItem` labels `HeaderActionsMenu` renders when sortable. */
const SORT_MENU_ITEM: Record<GridSortDirection, string> = {
  ascending: "Sort ascending",
  descending: "Sort descending",
};

/**
 * Sort `columnLabel` in `direction` through the v2 header's options menu.
 *
 * `scope` is the locator the column header lives in — the active nav panel, or
 * the grid itself. The MENU is addressed page-wide because Radix portals its
 * content to the document rather than leaving it inside the panel, and only one
 * menu can be open at a time.
 *
 * The trigger is addressed by its `aria-label` rather than by role+name: it is
 * an icon-only button, and its name is the interpolated "<Label> column
 * options", which a bare-label match would never find.
 */
export async function sortColumnByOptionsMenu(
  page: Page,
  scope: Page | Locator,
  columnLabel: string,
  direction: GridSortDirection
): Promise<void> {
  // `visible=true` because the desktop shell keeps visited views mounted: a
  // hidden Sessions or Dashboard grid renders column-options triggers of its
  // own, and a page-rooted scope would otherwise resolve one of those.
  await scope
    .getByRole("button", { exact: true, name: `${columnLabel} column options` })
    .locator("visible=true")
    .click();
  const item = page.getByRole("menuitem", {
    exact: true,
    name: SORT_MENU_ITEM[direction],
  });
  await expect(item).toBeVisible({ timeout: 30_000 });
  await item.click();
}
