/**
 * ISS-8198 / PLN-1952 T-1.5 — what the DESKTOP Sessions list REMEMBERS across a
 * detail visit, driven through the shipped Electron shell with `grid-table-v2`
 * ON.
 *
 * THE PRODUCTION MUTATION THAT MUST TURN THIS RED: in `SessionsV2View`'s
 * `controlledView` memo (`sessions-v2-view.tsx`), hand the surface
 * `grouping: localGrouping` instead of
 * `reconcileSessionsGrouping(hostView.groupBy, localGrouping)`. Grouping then
 * works for as long as the view stays mounted and is GONE the moment it comes
 * back: `localGrouping` is `useState`, so it resets to None on the remount, and
 * the primary dimension the persisted view still holds never rejoins it. The
 * band is on screen before the detail visit and absent after.
 *
 * NO EXISTING jsdom OR RENDERER SUITE CATCHES THAT, measured rather than
 * assumed. The suite that owns this rejoin —
 * `sessions-v2-grouping-round-trip.test.tsx` — drives it through the surface
 * seam inside ONE mount, reporting a view and reading the next one back; there
 * `localGrouping` is holding the primary dimension itself, so the rejoin is
 * invisible and the mutation stays green. It takes a real unmount to separate
 * the two halves, and the detail route is the only thing in the product that
 * performs one.
 *
 * TWO STORES, NOT ONE — which is why all four claims are asserted together:
 *  - the PAGE INDEX and the FACET ride the hash URL, restored because the
 *    breadcrumb hands back the href the list was last on;
 *  - the PRIMARY GROUPING and the hidden COLUMN ride `useSessionsViewState`'s
 *    persisted view, restored because that store outlives the unmount.
 * The detail route genuinely unmounts this view (`SessionsView` says so at its
 * facet seed), so neither is free.
 *
 * THE URL-BORNE PAIR IS COVERED ON THE OTHER BRANCH, and this spec is what
 * extends it to this one. `app-shell-sessions.test.tsx` → "returns from a
 * page-two session detail to the same sessions page and scroll position" pins
 * the breadcrumb's `#/sessions?page=2` href, the click, and the restored rows —
 * with `grid-table-v2` OFF, on the v1 stack. So `sessionsBreadcrumbHref` is not
 * an eligible mutation here (that suite kills it), and the page and facet
 * assertions below are this spec's v2 coverage of a contract already proven on
 * v1 rather than its discriminator.
 *
 * WHAT IS DELIBERATELY NOT ASSERTED, and must not be added:
 *  - A SCROLL OFFSET, because it belongs to another spec now, not because the
 *    shell lacks one. ISS-12471 fixed the gap this note used to record -- the
 *    desktop mount passed no `tableScrollRef`, so the shell's scroll memory
 *    measured the content viewport while the grid band was the real scroller --
 *    and `sessions-v2-scroll-restore-back.spec.ts` owns the restore. This
 *    spec's page two holds exactly one row, so its band cannot overflow and an
 *    offset assertion here would still be vacuous.
 *  - SECONDARY GROUPING, its order, or show-empty-groups. Those are `useState`
 *    in `SessionsV2View` — `SessionsHostViewState` carries only the PRIMARY
 *    dimension — so they are expected NOT to survive an unmount. Asserting that
 *    they do would pin a bug in place.
 *
 * SINGLE-BOOT, FLAG-ON ONLY (PLN-1952 AC-006). `sessions-v2-mount.spec.ts`
 * already owns "the v2 branch is reachable and the v1 branch still is".
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import { expect, type Locator, test } from "@playwright/test";
import {
  breadcrumbParentLink,
  openDetailFromList,
} from "./helpers/desktop-app";
import {
  mapInactiveLinuxCiWindow,
  selectInactiveLinuxCiMapping,
} from "./helpers/inactive-linux-ci-window";
import type { SessionListSeed } from "./helpers/seed-branches-db";
import {
  cleanupSeededSessionsDirs,
  makeSeededSessionsDirs,
} from "./helpers/seeded-sessions-list";
import {
  CURRENT_PAGE_SELECTOR,
  columnHeaderById,
  expectGridTableV2Mounted,
  NEXT_PAGE_SELECTOR,
  PAGINATION_BAND_TEST_ID,
  SEEDED_SESSIONS_V2_MOUNT_TIMEOUT_MS,
  withSeededSessionsV2List,
} from "./helpers/seeded-sessions-v2-list";
import { readPageDataFilters } from "./helpers/sessions-page-data-gate";

/**
 * Menu labels stay local because their canonical homes are React component
 * modules that this E2E loader cannot import safely.
 *
 * `OPTIONS_BUTTON` / `GROUP_BUTTON` / `FILTER_BUTTON` — the three toolbar menus.
 * `PRIMARY_GROUPING_FIELD` — `TableGroupMenu`'s primary field select.
 * `INACTIVE_BAND` — `SESSION_STATUS_LABELS.inactive`, which is both the group
 *   band's label and the facet option's.
 * `INACTIVE_CHIP_REMOVE` — `FilterChip`'s remove control over the label
 *   `hostFacetLabel` builds for this facet.
 * `SESSIONS_BREADCRUMB` — the Topbar breadcrumb's parent segment.
 */
const OPTIONS_BUTTON = "Options";
const GROUP_BUTTON = "Group";
const FILTER_BUTTON = "Filter";
const PRIMARY_GROUPING_FIELD = "Primary grouping field";
const STATUS_FACET = "Status";
const STATUS_GROUP_OPTION = "Status";
const INACTIVE_BAND = "Inactive";
const INACTIVE_CHIP_REMOVE = "Remove Status: Inactive filter";
const SESSIONS_BREADCRUMB = "Sessions";

/**
 * `Harness` is hidden and `Owner` is the control, both deliberately.
 *
 * Neither is in `SESSIONS_DEFAULT_HIDDEN_COLUMN_IDS` (`pr`, `merge`, `started`,
 * `updated`, `projects`, `issues`, `tags`), so both are on screen at rest and an
 * assertion against either can actually fail — a hidden-by-default column would
 * make "it disappeared" true before the click. Owner is not the grouping
 * dimension, so the control assertion still proves the returned grid is
 * rendering headers while grouped Status is legitimately absent from the row
 * grid.
 */
const HIDDEN_COLUMN_ID = "harness";
const HIDDEN_COLUMN_LABEL = "Harness";
const CONTROL_COLUMN_ID = "owner";

const DEFAULT_PAGE_SIZE = 25;
/** One full page of Inactive rows plus one, so the facet still has a page two. */
const INACTIVE_ROW_COUNT = DEFAULT_PAGE_SIZE + 1;
const FAILED_ROW_COUNT = 4;
const MINUTE_MS = 60_000;

/** The readout `sessionsRangeSentence` states for page two of the FILTERED set. */
const FIRST_PAGE_READOUT = "Showing 1-25 of 26 sessions";
const RESTORED_READOUT = "Showing 26-26 of 26 sessions";
const REORDERABLE_HEADER =
  '[role="columnheader"][data-column-id][draggable="true"]';
const COLUMN_OPTIONS_NAME = / column options$/;
const RESIZE_HANDLE_NAME = /^Resize Repository column/;

/**
 * Two-digit row numbers, so no row name is a prefix of another: an accessible-
 * name match is a case-insensitive substring by default, and "row 1" would also
 * resolve "row 10".
 */
function inactiveRowName(index: number): string {
  return `ISS-8198 back inactive ${String(index + 1).padStart(2, "0")}`;
}

const FIRST_ROW_NAME = inactiveRowName(0);
/** The 26th Inactive row — the only one on page two once the facet applies. */
const SECOND_PAGE_ROW_NAME = inactiveRowName(DEFAULT_PAGE_SIZE);

/**
 * Twenty-six Inactive rows, then four Failed ones, every `status` EXPLICIT.
 *
 * `at` descending by a minute a row pins the ORDER: the default view sorts on
 * `lastActivity` desc, and the desktop cursor page ORDERs BY the DENORMALIZED
 * `sessions.last_activity_at` column (`listSqliteSessionCursorPage`), so
 * `lastActivityAt` — seeded equal to `at` on every row below — decides which
 * row lands on page two. The Failed rows are the oldest, so they trail the
 * Inactive ones and the facet has something real to remove.
 *
 * Neither value is `active`: `resolveDisplayedSessionStatus` folds a live row
 * silent for 24h to Stale, so a fixture that banded or filtered on it would
 * depend on the wall clock. Both of these are terminal and render fixed labels.
 */
const SEEDED_SESSIONS: SessionListSeed[] = Array.from(
  { length: INACTIVE_ROW_COUNT + FAILED_ROW_COUNT },
  (_unused, index) => {
    const at = new Date(Date.now() - (index + 1) * MINUTE_MS).toISOString();
    const isInactive = index < INACTIVE_ROW_COUNT;
    return {
      at,
      lastActivityAt: at,
      name: isInactive
        ? inactiveRowName(index)
        : `ISS-8198 back failed ${String(index - INACTIVE_ROW_COUNT + 1).padStart(2, "0")}`,
      sessionId: `iss-8198-back-${String(index + 1).padStart(2, "0")}`,
      status: isInactive ? "inactive" : "error",
    };
  }
);

test.describe("Desktop Sessions v2 detail-back view state (ISS-8198 T-1.5)", () => {
  test("restores the page, the facet, the grouping and the hidden column after a detail visit", async () => {
    test.setTimeout(300_000);

    const dirs = makeSeededSessionsDirs("desktop-v2-view-state-back");
    try {
      await withSeededSessionsV2List(
        dirs,
        {
          featureFlags: {},
          readyRowName: FIRST_ROW_NAME,
          sessionsPageDataGate: true,
          sessions: SEEDED_SESSIONS,
        },
        async (page, panel, app) => {
          await mapInactiveLinuxCiWindow(
            app,
            page,
            selectInactiveLinuxCiMapping(
              { platform: process.platform, env: process.env },
              true
            )
          );

          const hiddenColumn = columnHeaderById(panel, HIDDEN_COLUMN_ID);
          const controlColumn = columnHeaderById(panel, CONTROL_COLUMN_ID);
          const readout = panel
            .getByTestId(PAGINATION_BAND_TEST_ID)
            .getByRole("status");
          const currentPage = panel
            .getByTestId(PAGINATION_BAND_TEST_ID)
            .locator(CURRENT_PAGE_SELECTOR);
          const chipRemove = panel.getByRole("button", {
            exact: true,
            name: INACTIVE_CHIP_REMOVE,
          });
          const inactiveBand = panel.getByRole("button", {
            exact: true,
            name: INACTIVE_BAND,
          });
          const secondPageRow = panel.getByRole("link", {
            exact: true,
            name: SECOND_PAGE_ROW_NAME,
          });

          // The premise for every restored assertion: none of the four is in
          // force at rest, so finding it after the round trip is a restore and
          // not the surface's default.
          await expect(hiddenColumn.first()).toBeVisible({
            timeout: SEEDED_SESSIONS_V2_MOUNT_TIMEOUT_MS,
          });
          await expect(controlColumn.first()).toBeVisible();
          await expect(chipRemove).toHaveCount(0);
          await expect(inactiveBand).toHaveCount(0);
          await expect(currentPage).toHaveText("1");

          // Hide a column (persisted view).
          await panel
            .getByRole("button", { exact: true, name: OPTIONS_BUTTON })
            .click();
          await page
            .getByRole("menu")
            .getByRole("menuitem", { exact: true, name: HIDDEN_COLUMN_LABEL })
            .click();
          await page.keyboard.press("Escape");
          await expect(hiddenColumn).toHaveCount(0);

          // Apply a facet (hash URL). Narrows 30 rows to 26, so page two still
          // exists and holds exactly the row this spec drills into.
          await panel
            .getByRole("button", { exact: true, name: FILTER_BUTTON })
            .click();
          await page
            .getByRole("menuitem", { exact: true, name: STATUS_FACET })
            .click();
          await page
            .getByRole("menuitem", { exact: true, name: INACTIVE_BAND })
            .click();
          await page.keyboard.press("Escape");
          await page.keyboard.press("Escape");
          await expect(chipRemove).toBeVisible();

          // Group by Status (persisted view).
          await panel
            .getByRole("button", { exact: true, name: GROUP_BUTTON })
            .click();
          await page
            .getByRole("combobox", { name: PRIMARY_GROUPING_FIELD })
            .click();
          await page
            .getByRole("option", { exact: true, name: STATUS_GROUP_OPTION })
            .click();
          await page.keyboard.press("Escape");
          await expect(inactiveBand).toBeVisible();

          // Page two (hash URL). Both the facet and the grouping reset to page
          // one when they commit, so this has to be last.
          await panel
            .getByTestId(PAGINATION_BAND_TEST_ID)
            .locator(NEXT_PAGE_SELECTOR)
            .click();
          await expect(readout).toHaveText(RESTORED_READOUT);
          await expect(secondPageRow).toBeVisible();
          expect(await readPageDataFilters(app)).toContainEqual(
            expect.objectContaining({
              limit: DEFAULT_PAGE_SIZE,
              offset: DEFAULT_PAGE_SIZE,
            })
          );

          const headers = panel.locator(REORDERABLE_HEADER);
          const beforeOrder = await headerIds(headers);
          expect(beforeOrder.indexOf("owner")).toBeGreaterThanOrEqual(0);
          expect(beforeOrder.indexOf("repo")).toBeGreaterThan(
            beforeOrder.indexOf("owner")
          );
          const ownerHeader = columnHeaderById(panel, "owner");
          const repoHeader = columnHeaderById(panel, "repo");
          const repoLabel = repoHeader.locator('[data-slot="tooltip-trigger"]');
          await expect(repoLabel).toHaveCount(1);
          await repoLabel.dragTo(ownerHeader);
          const afterPointer = [...beforeOrder];
          afterPointer.splice(afterPointer.indexOf("repo"), 1);
          afterPointer.splice(afterPointer.indexOf("owner"), 0, "repo");
          await expect.poll(() => headerIds(headers)).toEqual(afterPointer);

          const ownerOptions = ownerHeader.getByRole("button", {
            name: COLUMN_OPTIONS_NAME,
          });
          await ownerOptions.focus();
          await ownerOptions.press("Enter");
          await page
            .getByRole("menuitem", { exact: true, name: "Move column" })
            .press("ArrowRight");
          await page
            .getByRole("menuitem", { exact: true, name: "Move to end" })
            .press("Enter");
          const editedOrder = [
            ...afterPointer.filter((id) => id !== "owner"),
            "owner",
          ];
          await expect.poll(() => headerIds(headers)).toEqual(editedOrder);
          await expect(ownerOptions).toBeFocused();

          const resizeHandle = repoHeader.getByRole("button", {
            name: RESIZE_HANDLE_NAME,
          });
          const originalWidth = await headerWidth(repoHeader);
          const initialName = await resizeHandle.getAttribute("aria-label");
          if (!initialName) {
            throw new Error("Repository resize handle has no accessible name");
          }
          await resizeHandle.focus();
          await resizeHandle.press("ArrowRight");
          await expect
            .poll(() => headerWidth(repoHeader))
            .toBeGreaterThan(originalWidth);
          await expect(resizeHandle).toBeFocused();
          await expect(resizeHandle).not.toHaveAttribute(
            "aria-label",
            initialName
          );
          const firstRightName = await resizeHandle.getAttribute("aria-label");
          if (!firstRightName) {
            throw new Error("Resized Repository has no width announcement");
          }
          const firstRightWidth = await headerWidth(repoHeader);
          await resizeHandle.press("ArrowRight");
          await expect
            .poll(() => headerWidth(repoHeader))
            .toBeGreaterThan(firstRightWidth);
          await expect(resizeHandle).toBeFocused();
          await expect(resizeHandle).not.toHaveAttribute(
            "aria-label",
            firstRightName
          );
          const secondRightWidth = await headerWidth(repoHeader);
          await resizeHandle.press("ArrowLeft");
          await expect
            .poll(() => headerWidth(repoHeader))
            .toBeLessThan(secondRightWidth);
          await expect(resizeHandle).toBeFocused();
          await expect(resizeHandle).toHaveAttribute(
            "aria-label",
            firstRightName
          );
          const keyboardWidth = await headerWidth(repoHeader);
          const scrollBand = panel.getByTestId("grid-table-scroll-band");
          // A covered resize handle sits behind the pinned Session header.
          await scrollBand.evaluate((element) => {
            element.scrollLeft = 0;
          });
          await expect
            .poll(() => scrollBand.evaluate((element) => element.scrollLeft))
            .toBe(0);
          const handleBox = await resizeHandle.boundingBox();
          if (!handleBox) {
            throw new Error("Repo resize handle has no measurable bounds");
          }
          const x = handleBox.x + handleBox.width / 2;
          const y = handleBox.y + handleBox.height / 2;
          await page.mouse.move(x, y);
          await page.mouse.down();
          await page.mouse.move(x + 32, y, { steps: 5 });
          await page.mouse.up();
          await expect
            .poll(() => headerWidth(repoHeader))
            .toBeGreaterThan(keyboardWidth);
          const editedWidth = await headerWidth(repoHeader);

          await scrollBand.evaluate((element) => {
            element.scrollLeft = 0;
          });
          await expect
            .poll(() => scrollBand.evaluate((element) => element.scrollLeft))
            .toBe(0);
          const pageIdentity = secondPageRow;
          const restingIdentity = await leftEdge(pageIdentity);
          const restingNeighbor = await leftEdge(repoHeader);
          await scrollBand.evaluate((element) => {
            element.scrollLeft = Math.min(
              400,
              element.scrollWidth - element.clientWidth
            );
          });
          await expect
            .poll(() => scrollBand.evaluate((element) => element.scrollLeft))
            .toBeGreaterThan(80);
          expect(
            restingNeighbor - (await leftEdge(repoHeader))
          ).toBeGreaterThan(80);
          expect(
            Math.abs((await leftEdge(pageIdentity)) - restingIdentity)
          ).toBeLessThan(2);
          await scrollBand.evaluate((element) => {
            element.scrollLeft = 0;
          });
          await expect
            .poll(() => scrollBand.evaluate((element) => element.scrollLeft))
            .toBe(0);
          await expect(currentPage).toHaveText("2");
          expect((await readPageDataFilters(app)).at(-1)).toMatchObject({
            limit: DEFAULT_PAGE_SIZE,
            offset: DEFAULT_PAGE_SIZE,
          });

          await panel
            .getByTestId(PAGINATION_BAND_TEST_ID)
            .locator('[aria-label="Go to previous page"]')
            .click();
          await expect(readout).toHaveText(FIRST_PAGE_READOUT);
          await expect(
            panel.getByRole("link", { exact: true, name: FIRST_ROW_NAME })
          ).toBeVisible();
          await expect
            .poll(async () => (await readPageDataFilters(app)).at(-1))
            .toMatchObject({ limit: DEFAULT_PAGE_SIZE, offset: 0 });
          await panel
            .getByTestId(PAGINATION_BAND_TEST_ID)
            .locator(NEXT_PAGE_SELECTOR)
            .click();
          await expect(readout).toHaveText(RESTORED_READOUT);
          await expect(secondPageRow).toBeVisible();
          await expect
            .poll(async () => (await readPageDataFilters(app)).at(-1))
            .toMatchObject({
              limit: DEFAULT_PAGE_SIZE,
              offset: DEFAULT_PAGE_SIZE,
            });

          await openDetailFromList(page, secondPageRow, SESSIONS_BREADCRUMB);
          await breadcrumbParentLink(page, SESSIONS_BREADCRUMB).click();
          await expect(panel).toBeVisible({
            timeout: SEEDED_SESSIONS_V2_MOUNT_TIMEOUT_MS,
          });
          // The barrier again: the setup one is a claim about the boot, this
          // one about the RETURN. The list unmounts for the detail route and
          // mounts again on the way back, and nothing above pins WHICH surface
          // came back.
          //
          // Not every assertion below would survive a v1 remount — the readout
          // and the pager are scoped inside `PAGINATION_BAND_TEST_ID`, which
          // only `GridTableListSurface` renders, so those two would redden on
          // their own. What they would redden AS is the point: a locator
          // timeout on a restored-state assertion reads as "the view state was
          // lost", which is the wrong bug. The chip, the band button, the row
          // link and the column headers (`table-grid-header.tsx` emits
          // `data-column-id` too) have v1 spellings and would simply pass.
          await expectGridTableV2Mounted(panel);

          // All four, together. The two URL-borne halves and the two persisted
          // ones fail independently, and a return that dropped the query would
          // still satisfy the persisted pair.
          await expect(readout).toHaveText(RESTORED_READOUT, {
            timeout: SEEDED_SESSIONS_V2_MOUNT_TIMEOUT_MS,
          });
          await expect(currentPage).toHaveText("2");
          await expect(chipRemove).toBeVisible();
          await expect(inactiveBand).toBeVisible();
          await expect(hiddenColumn).toHaveCount(0);
          // Paired with a column that must STILL be there, so the zero above is
          // the restored view rather than a grid that stopped rendering headers.
          await expect(controlColumn.first()).toBeVisible();
          await expect(secondPageRow).toBeVisible();
          await expect(repoHeader).toBeVisible();
          await expect(ownerHeader).toBeVisible();
          await expect.poll(() => headerIds(headers)).toEqual(editedOrder);
          await expect
            .poll(async () =>
              Math.abs((await headerWidth(repoHeader)) - editedWidth)
            )
            .toBeLessThanOrEqual(1);
        }
      );
    } finally {
      cleanupSeededSessionsDirs(dirs);
    }
  });
});

function headerIds(headers: Locator): Promise<string[]> {
  return headers.evaluateAll((cells) =>
    cells.map((cell) => (cell as HTMLElement).dataset.columnId ?? "")
  );
}

async function headerWidth(header: Locator): Promise<number> {
  const box = await header.boundingBox();
  if (!box) {
    throw new Error("The column header has no measurable bounds");
  }
  return box.width;
}

async function leftEdge(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error("The grid cell has no bounding box");
  }
  return box.x;
}
