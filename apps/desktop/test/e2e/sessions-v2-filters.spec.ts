/**
 * ISS-8198 / PLN-1952 T-1.3 — the DESKTOP Sessions toolbar's Filter popover and
 * the explicit date window beside it, driven through the shipped Electron shell
 * with `grid-table-v2` ON.
 *
 * THE PRODUCTION MUTATION THAT MUST TURN THIS RED: flip
 * `pendingWindowWrite.current = "clear"` to `null` in
 * `useSessionsWindowClearFold`
 * (`packages/app/agents/hooks/use-sessions-window-clear-fold.ts`) — the fold
 * `sessions-v2-view.tsx` reads, held in the shared host library since ISS-9822
 * so the web v2 host adopts it rather than hand-writing a second copy.
 * "Clear filters" then drops the facets and LEAVES the explicit window: the chip
 * row goes, and `?from=`/`?to=` survive into the write that carries the cleared
 * facets, so the listing stays narrowed to a window whose control the reader has
 * just been told is cleared. That ref is the whole of the ISS-9107 AC7 seam —
 * the surface calls `onCustomDateWindowChange(null)` BEFORE it reports the view
 * change, so the clear has to be remembered across the two calls and spent by
 * the single `replaceListParams` that follows.
 *
 * A JSDOM SUITE NOW COVERS THE FOLD ITSELF, and none did when this spec was
 * written: `use-sessions-window-clear-fold.test.ts` drives the clear directly
 * and pins that the flag survives EVERY read inside one synchronous event. What
 * that suite cannot see, and what this spec still uniquely proves, is the WIRING
 * around it — that the real `ActiveFiltersBar` calls
 * `onCustomDateWindowChange(null)` before it reports the view change, that this
 * shell hands the fold's callback to the surface and the fold's answer to the
 * scope write, and that the shipped Electron shell ends up on a URL carrying
 * neither param. The closest jsdom neighbours each stop short of that:
 * `sessions-list-url-writers.test.ts` drives `handleScopeChange` with a
 * `clearWindow` it supplies itself, so it pins what the writer does with the
 * flag and never who sets it; `sessions-view-custom-date-window.test.tsx`
 * covers the params, the Labs gate and whether the toolbar is handed a setter at
 * all, never a clear routed through the FILTER control. And the desktop e2e that
 * does drive this window (`sessions-custom-date-window.spec.ts`) clears it with
 * the window control's OWN X — `handleCustomDateWindowChange`, a different path
 * that writes its own params — and runs with `grid-table-v2` off, on the v1
 * toolbar.
 *
 * THE PRESET IS DELIBERATELY LEFT WHERE IT BOOTS (`dateRangePreset: null`), and
 * that is what makes the mutation above discriminate. `clearAllFilters` patches
 * `dateRange` back to `DEFAULT_DATE_RANGE`; from any OTHER preset that is a
 * range move, and `resolveSessionsScopeDelta` then reports a non-null
 * `dateRange`, which strips the window params on its own no matter what the ref
 * said. Sitting on the default makes the range a no-move, so the clear reaching
 * the window is attributable to this seam alone. The seeded rows are dated
 * "now", so they are inside that default 7-day window.
 *
 * THE FIRST CASE: TWO BEATS, ONE LAUNCH (~90s each), FLAG-ON ONLY (PLN-1952 AC-006):
 * applying a Status facet and reading the chip and the narrowed rows, then
 * applying an explicit window and clearing BOTH with one control.
 *
 * The Status facet needs NO `usage` seed. The plan says to seed a facet's
 * options through `usage`, which holds for Owner, Harness, Model and Repository;
 * Status is served from the fixed `SESSION_STATUS_FILTER_OPTIONS` vocabulary
 * (`STATUS_OPTIONS` in `session-filter-adapter.tsx`) and is populated for an
 * empty corpus.
 *
 * THE SECOND CASE (ISS-9822) IS ITS OWN LAUNCH, WITH ITS OWN MUTATION: in
 * `sessions-v2-view.tsx`, `const pageIndex = page;`. It picks a window from
 * PAGE 2 with no window in the hash. The pick writes `?from=`/`?to=` and the
 * page reset in one `replaceListParams`, and the surface then reports a
 * `page: 0` view change; read against the pre-click hash snapshot, that change
 * used to issue a second write carrying no window, which landed last. The mount
 * test covering the fix (`sessions-v2-mount.test.tsx`) mocks navigation, so it
 * pins the single write and never runs the hash adapter that held the stale
 * snapshot (`desktop-adapter.tsx`). This case pins the other half only: the
 * picked window is still in the real hash, and its rows are on screen. It
 * starts with no window because one already in the hash is copied back out of
 * that same snapshot, and the loss would not show.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  ARTIFACT_STATUS_DETAIL,
  DISPLAYED_ARTIFACT_STATUS,
} from "../../../../packages/api/src/types/artifact-status.ts";
import {
  ARTIFACT_STATUS_DETAIL_LABELS,
  ARTIFACT_STATUS_DISPLAY_LABELS,
} from "../../../../packages/api/src/types/artifact-status-display.ts";
import { SESSION_STATUS } from "../../../../packages/api/src/types/session-status.ts";
import { SESSION_STATUS_LABELS } from "../../../../packages/api/src/types/session-status-display.ts";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "../../../../packages/api/src/types/universal-artifact-status-flag";
import {
  DATE_RANGE_LABELS,
  DateRange,
} from "../../../../packages/app/shared/lib/format-utils.ts";
import { hashQuery } from "./helpers/hash-router-query";
import {
  mapInactiveLinuxCiWindow,
  selectInactiveLinuxCiMapping,
} from "./helpers/inactive-linux-ci-window";
import {
  capturePreviousMonthDays,
  type PreviousMonthDays,
} from "./helpers/previous-month-days";
import type { SessionListSeed } from "./helpers/seed-branches-db";
import {
  cleanupSeededSessionsDirs,
  makeSeededSessionsDirs,
} from "./helpers/seeded-sessions-list";
import {
  CURRENT_PAGE_SELECTOR,
  expectGridTableV2Mounted,
  NEXT_PAGE_SELECTOR,
  PAGINATION_BAND_TEST_ID,
  SEEDED_SESSIONS_V2_MOUNT_TIMEOUT_MS,
  withSeededSessionsV2List,
} from "./helpers/seeded-sessions-v2-list";

/**
 * The local keys below stay literals because their canonical homes reach a React component
 * runtime (`packages/design-system/components/ui/*.tsx`) or pull an
 * extension-less `@repo/api/src/types/…` subpath in, either of which aborts the
 * WHOLE desktop-e2e suite at load with no failing test name to point at it. That
 * is not a blanket rule about `@repo/*` — an EXTENSION-QUALIFIED subpath resolves
 * fine and sibling specs use them (`apps/desktop/test/AGENTS.md`).
 *
 * `CUSTOM_DATE_WINDOW_FLAG_KEY` —
 *   `DESKTOP_SESSIONS_CUSTOM_DATE_WINDOW_FEATURE_FLAG_KEY`. Without it the
 *   listing is handed no window setter and the Custom control does not mount.
 * `FILTER_BUTTON` / `CLEAR_FILTERS_SELECTOR` — `FilterPopover`'s trigger and the
 *   X beside it. The X renders only while a facet is applied, and is addressed
 *   by ATTRIBUTE rather than accessible name: once the window has emptied the
 *   list, `SessionsEmptyState` renders a recovery button reading the same two
 *   words, and only the toolbar control carries the `aria-label`.
 * `STATUS_FACET` / `FAILED_OPTION` — the `status` group of
 *   `sessionFilterFacetGroups` and `SESSION_STATUS_LABELS.error`.
 * `FAILED_CHIP_REMOVE` — `FilterChip`'s remove control, named from the chip
 *   label `hostFacetLabel` builds.
 * `CUSTOM_TRIGGER` / `APPLY` / `PREVIOUS_MONTH` — `SessionsCustomRangeControl`
 *   and the DS `Calendar` inside it.
 */
const CUSTOM_DATE_WINDOW_FLAG_KEY = "sessions-custom-date-window";
const FILTER_BUTTON = "Filter";
const CLEAR_FILTERS_SELECTOR = 'button[aria-label="Clear filters"]';
const STATUS_FACET = "Status";
const FAILED_OPTION = "Failed";
const FAILED_CHIP_REMOVE = "Remove Status: Failed filter";
const ALL_TIME = DATE_RANGE_LABELS[DateRange.AllTime];
/** The chip row's own clear, distinct from the toolbar's "Clear filters". */
const CLEAR_ALL_BUTTON = "Clear all";
const CUSTOM_TRIGGER = "Custom";
const APPLIED_TRIGGER = /^Custom date range: /;
const APPLY = "Apply";
const PREVIOUS_MONTH = /Go to the Previous Month/;

/** `SESSION_FACET_FILTER_PARAMS.statuses`, and the two window params. */
const STATUS_PARAM = "status";
const FROM_PARAM = "from";
const TO_PARAM = "to";
/** `SESSIONS_PAGE_PARAM`, one-based in the hash (`#/sessions?page=2`). */
const PAGE_PARAM = "page";

// Distinct, NON-PREFIX names: an accessible-name match is a case-insensitive
// substring by default, so a shared prefix would make both row locators
// ambiguous under strict mode.
const INACTIVE_ROW_NAME = "ISS-8198 filters inactive alpha";
const FAILED_ROW_NAME = "ISS-8198 filters failed beta";
const OLD_ALL_TIME_ROW_NAME = "ISS-10816 old all-time inactive gamma";
const DAY_MS = 24 * 60 * 60 * 1000;
const OLD_ALL_TIME_AT = new Date(Date.now() - 30 * DAY_MS).toISOString();

/**
 * The window this spec applies, as days of the PREVIOUS calendar month.
 *
 * Previous rather than current so no clicked cell is in the future, and so the
 * window provably EXCLUDES the corpus — both rows are seeded at "now", which is
 * what makes the empty list after Apply attributable to the window.
 */
const WINDOW_FROM_DAY = 2;
const WINDOW_TO_DAY = 10;

/**
 * Both statuses seeded EXPLICITLY, and neither is `active`.
 *
 * `SessionListSeed.status` defaults to `inactive`, so an unseeded corpus would
 * put both rows in one bucket and the facet could not narrow anything. `active`
 * is excluded on purpose: `resolveDisplayedSessionStatus` folds a live row
 * silent for 24h to Stale, so a fixture banding or filtering on it depends on
 * the wall clock. Both values are terminal: their persisted facet options are
 * Inactive and Failed, while the universal row badges show Done · Completed
 * and Canceled · Failed with this spec's flag enabled.
 */
const SEEDED_SESSIONS: SessionListSeed[] = [
  {
    name: INACTIVE_ROW_NAME,
    sessionId: "iss-8198-filters-inactive",
    status: "inactive",
  },
  {
    name: FAILED_ROW_NAME,
    sessionId: "iss-8198-filters-failed",
    status: "error",
  },
  {
    at: OLD_ALL_TIME_AT,
    lastActivityAt: OLD_ALL_TIME_AT,
    name: OLD_ALL_TIME_ROW_NAME,
    sessionId: "iss-10816-old-all-time-inactive",
    status: "inactive",
    updatedAt: OLD_ALL_TIME_AT,
  },
];

/**
 * The page-2 case's corpus sizes: thirty recent rows under the default 25-row
 * page is the smallest corpus with a real page 2, the same corpus
 * `sessions-v2-pagination.spec.ts` turns the page on. Row names carry two-digit
 * numbers so none is a prefix of another, and none holds "Custom".
 */
const PAGED_ROW_COUNT = 30;
const DEFAULT_PAGE_SIZE = 25;
const MINUTE_MS = 60_000;
const PAGED_FIRST_ROW_NAME = pagedRowName(0);
/** The 26th row: first of page two. */
const PAGED_SECOND_PAGE_ROW_NAME = pagedRowName(DEFAULT_PAGE_SIZE);
/** Inside the picked window, and older than the boot 7-day preset. */
const WINDOW_ROW_DAY = 5;
const WINDOW_ROW_NAME = "ISS-9822 window pick inside";

test.describe("Desktop Sessions v2 filters (ISS-8198 T-1.3)", () => {
  test("applies a Status facet, then clears the facet AND the explicit window with one control", async () => {
    test.setTimeout(300_000);

    // One clock reading for the clicked cells and the URL expectations below.
    const days = capturePreviousMonthDays();
    const dirs = makeSeededSessionsDirs("desktop-v2-filters");
    try {
      await withSeededSessionsV2List(
        dirs,
        {
          // Stay on the boot default preset — see the docstring: from any other
          // range, "Clear filters" would strip the window as a RANGE move and
          // the seam under test would not be what cleared it.
          dateRangePreset: null,
          // The seeded month, the clicked cells and the `?from=`/`?to=`
          // assertions all read UTC calendar fields, while the picker opens on
          // the app's LOCAL month. Unpinned they disagree for the hours when the
          // two calendars differ, and the single back click then lands a month
          // early where the clicked day does not exist. Same lever as
          // `sessions-custom-date-window.spec.ts`.
          env: { TZ: "UTC" },
          featureFlags: {
            [CUSTOM_DATE_WINDOW_FLAG_KEY]: true,
            [UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY]: true,
          },
          readyRowName: INACTIVE_ROW_NAME,
          sessions: SEEDED_SESSIONS,
        },
        async (page, panel) => {
          // Without this, a pin that stopped taking would silently re-test v1
          // through a Filter popover v1 does not have.
          await expectGridTableV2Mounted(panel);

          const inactiveRow = panel.getByRole("link", {
            exact: true,
            name: INACTIVE_ROW_NAME,
          });
          const failedRow = panel.getByRole("link", {
            exact: true,
            name: FAILED_ROW_NAME,
          });
          const oldAllTimeRow = panel.getByRole("link", {
            exact: true,
            name: OLD_ALL_TIME_ROW_NAME,
          });
          const failedChipRemove = panel.getByRole("button", {
            exact: true,
            name: FAILED_CHIP_REMOVE,
          });
          const clearAll = panel.getByRole("button", {
            exact: true,
            name: CLEAR_ALL_BUTTON,
          });

          // The premise for every absence below: both rows are on screen at
          // rest, inside the default preset's window. Only the FAILED row is
          // stated here — the inactive one is this launch's `readyRowName`, so
          // the helper has already asserted the identical locator.
          await expect(failedRow).toBeVisible({
            timeout: SEEDED_SESSIONS_V2_MOUNT_TIMEOUT_MS,
          });
          await expect(oldAllTimeRow).toHaveCount(0);
          const completedStatus = panel.getByLabel(
            `${ARTIFACT_STATUS_DISPLAY_LABELS[DISPLAYED_ARTIFACT_STATUS.Done]}, ${ARTIFACT_STATUS_DETAIL_LABELS[ARTIFACT_STATUS_DETAIL.SessionCompleted]}`,
            { exact: true }
          );
          await expect(completedStatus).toBeVisible();
          await expect(completedStatus).toHaveText(
            `${ARTIFACT_STATUS_DISPLAY_LABELS[DISPLAYED_ARTIFACT_STATUS.Done]} · ${ARTIFACT_STATUS_DETAIL_LABELS[ARTIFACT_STATUS_DETAIL.SessionCompleted]}`
          );
          await expect(
            panel.getByText(SESSION_STATUS_LABELS[SESSION_STATUS.INACTIVE], {
              exact: true,
            })
          ).toHaveCount(0);
          // The TZ pin is the precondition the day cells below rest on, so it is
          // asserted rather than trusted: a non-UTC runner fails HERE with a
          // named cause instead of as an unexplained locator timeout on the two
          // days a month when the local and UTC calendars disagree.
          await expect
            .poll(() => page.evaluate(() => new Date().getTimezoneOffset()))
            .toBe(0);

          // ISS-8909 regression: with nothing filtered the chip row renders
          // NOTHING, so no "Clear all" sits there offering to clear no filter.
          // Paired with the post-facet assertion below, because an absence on a
          // row that never renders at all would pass either way.
          await expect(
            panel.getByRole("button", { exact: true, name: CLEAR_ALL_BUTTON })
          ).toHaveCount(0);

          // BEAT ONE — the facet applies, chips, and narrows.
          await panel
            .getByRole("button", { exact: true, name: FILTER_BUTTON })
            .click();
          // The menu and its facet submenus are portalled to the document, not
          // the nav panel, so they are addressed page-wide.
          await page
            .getByRole("menuitem", { exact: true, name: STATUS_FACET })
            .click();
          await page
            .getByRole("menuitem", { exact: true, name: FAILED_OPTION })
            .click();
          // The facet rows `preventDefault` their own select so the menu stays
          // open; close it so it cannot answer a chip or row query with its own
          // controls. Twice: the submenu, then the menu.
          await page.keyboard.press("Escape");
          await page.keyboard.press("Escape");

          await expect(failedChipRemove).toBeVisible();
          // The other half of the ISS-8909 absence above: the row that
          // renders nothing when nothing is filtered still renders its
          // "Clear all" the moment a facet is active.
          await expect(clearAll).toBeVisible();
          // The rows actually narrowed — paired with the row that must STILL be
          // there, so the zero is the facet and not a grid that stopped
          // rendering.
          await expect(inactiveRow).toHaveCount(0);
          await expect(failedRow).toBeVisible();
          await expect
            .poll(() => hashQuery(page.url()).get(STATUS_PARAM))
            .not.toBeNull();

          // ISS-10816 item 5: the chip removes only Status. The independent
          // All-time range survives in the real Desktop hash and both rows
          // return, unlike the full-clear controls exercised below.
          await panel
            .getByRole("radio", { exact: true, name: ALL_TIME })
            .click();
          await expect(
            panel.getByRole("radio", { exact: true, name: ALL_TIME })
          ).toBeChecked();
          await failedChipRemove.click();
          await expect
            .poll(() => hashQuery(page.url()).get(STATUS_PARAM))
            .toBeNull();
          await expect(
            panel.getByRole("radio", { exact: true, name: ALL_TIME })
          ).toBeChecked();
          await expect(failedRow).toBeVisible();
          await expect(inactiveRow).toBeVisible();
          await expect(oldAllTimeRow).toBeVisible();

          await page.reload();
          await expectGridTableV2Mounted(panel);
          await expect(
            panel.getByRole("radio", { exact: true, name: ALL_TIME })
          ).toBeChecked();
          await expect(oldAllTimeRow).toBeVisible({
            timeout: SEEDED_SESSIONS_V2_MOUNT_TIMEOUT_MS,
          });

          // Reapply the facet so the full-clear path below owns its setup.
          await panel
            .getByRole("button", { exact: true, name: FILTER_BUTTON })
            .click();
          await page
            .getByRole("menuitem", { exact: true, name: STATUS_FACET })
            .click();
          await page
            .getByRole("menuitem", { exact: true, name: FAILED_OPTION })
            .click();
          await page.keyboard.press("Escape");
          await page.keyboard.press("Escape");

          // BEAT TWO — an explicit window, applied through the real control.
          await panel
            .getByRole("button", { exact: true, name: CUSTOM_TRIGGER })
            .click();
          // One page back, so the days clicked below are the previous month's.
          await page.getByRole("button", { name: PREVIOUS_MONTH }).click();
          await dayCell(page, days, WINDOW_FROM_DAY).click();
          await dayCell(page, days, WINDOW_TO_DAY).click();
          await page.getByRole("button", { name: APPLY }).click();

          // The window reached the URL, is stated in WORDS on the trigger, and
          // the renderer re-queried on it — the corpus is dated "now", so a
          // previous-month window empties the list.
          await expect
            .poll(() => hashQuery(page.url()).get(FROM_PARAM))
            .toBe(days.isoDay(WINDOW_FROM_DAY));
          expect(hashQuery(page.url()).get(TO_PARAM)).toBe(
            days.isoDay(WINDOW_TO_DAY)
          );
          await expect(
            panel.getByRole("button", { name: APPLIED_TRIGGER })
          ).toBeVisible();
          await expect(failedRow).toHaveCount(0);

          // ONE control, BOTH axes, in one write (ISS-9107 AC7). A clear that
          // dropped the facets and left the window would leave the listing
          // narrowed by a filter whose control now says it is off.
          await panel.locator(CLEAR_FILTERS_SELECTOR).click();

          await expect
            .poll(() => hashQuery(page.url()).get(FROM_PARAM))
            .toBeNull();
          expect(hashQuery(page.url()).get(TO_PARAM)).toBeNull();
          expect(hashQuery(page.url()).get(STATUS_PARAM)).toBeNull();
          await expect(failedChipRemove).toHaveCount(0);
          // Both rows are back: the window is gone AND the facet is gone. Either
          // one surviving would leave one of these two absent.
          await expect(failedRow).toBeVisible({
            timeout: SEEDED_SESSIONS_V2_MOUNT_TIMEOUT_MS,
          });
          await expect(inactiveRow).toBeVisible();

          // BEAT FOUR (ISS-8909, davetho review) — the chip row's OWN
          // "Clear all", driven rather than merely seen. Re-applied from the
          // now-clean state so this beat owns its own setup: the control
          // appears with the facet and actually clears it, which is what the
          // empty-row guard must not have cost.
          await panel
            .getByRole("button", { exact: true, name: FILTER_BUTTON })
            .click();
          await page
            .getByRole("menuitem", { exact: true, name: STATUS_FACET })
            .click();
          await page
            .getByRole("menuitem", { exact: true, name: FAILED_OPTION })
            .click();
          await page.keyboard.press("Escape");
          await page.keyboard.press("Escape");

          await expect(clearAll).toBeVisible();
          await clearAll.click();

          await expect
            .poll(() => hashQuery(page.url()).get(STATUS_PARAM))
            .toBeNull();
          // Back to nothing filtered, so the row is gone again — the absence at
          // rest and this one are the same guard, seen before and after use.
          await expect(clearAll).toHaveCount(0);
          await expect(inactiveRow).toBeVisible();
        }
      );
    } finally {
      cleanupSeededSessionsDirs(dirs);
    }
  });

  test("keeps a custom window picked from page 2 in the real hash, and lists that window's rows", async () => {
    test.setTimeout(300_000);

    const days = capturePreviousMonthDays();
    const dirs = makeSeededSessionsDirs("desktop-v2-window-page-two");
    try {
      await withSeededSessionsV2List(
        dirs,
        {
          // The boot 7-day preset, so the window's row is off the list until the
          // pick and page 2 holds recent rows only (see `pagedWindowSessions`).
          dateRangePreset: null,
          // The same UTC pin as the case above, for the same clicked cells.
          env: { TZ: "UTC" },
          featureFlags: {
            [CUSTOM_DATE_WINDOW_FLAG_KEY]: true,
          },
          readyRowName: PAGED_FIRST_ROW_NAME,
          sessions: pagedWindowSessions(days),
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
          const footer = panel.getByTestId(PAGINATION_BAND_TEST_ID);
          const firstPageRow = panel.getByRole("link", {
            exact: true,
            name: PAGED_FIRST_ROW_NAME,
          });
          const secondPageRow = panel.getByRole("link", {
            exact: true,
            name: PAGED_SECOND_PAGE_ROW_NAME,
          });
          const windowRow = panel.getByRole("link", {
            exact: true,
            name: WINDOW_ROW_NAME,
          });
          const apply = page.getByRole("button", { exact: true, name: APPLY });

          await expect
            .poll(() => page.evaluate(() => new Date().getTimezoneOffset()))
            .toBe(0);
          // The premise for the window row appearing below: it is not listed yet.
          await expect(windowRow).toHaveCount(0);

          await footer.locator(NEXT_PAGE_SELECTOR).click();

          // Really past page 1, in the hash a stale second write is built from
          // AND in the rows, so a clamp back to page 1 fails here rather than
          // quietly re-testing the page that never had the defect.
          await expect
            .poll(() => hashQuery(page.url()).get(PAGE_PARAM))
            .toBe("2");
          await expect(footer.locator(CURRENT_PAGE_SELECTOR)).toHaveText("2");
          await expect(secondPageRow).toBeVisible();
          await expect(firstPageRow).toHaveCount(0);
          // No window yet: one already present is copied back out of the
          // pre-click snapshot, and the loss would not show.
          const beforePick = hashQuery(page.url());
          expect(beforePick.get(FROM_PARAM)).toBeNull();
          expect(beforePick.get(TO_PARAM)).toBeNull();

          // Exact: a substring "Custom" can resolve more than the trigger.
          await panel
            .getByRole("button", { exact: true, name: CUSTOM_TRIGGER })
            .click();
          await page.getByRole("button", { name: PREVIOUS_MONTH }).click();
          await dayCell(page, days, WINDOW_FROM_DAY).click();
          await dayCell(page, days, WINDOW_TO_DAY).click();
          await apply.click();

          // Settled: Apply closes the popover in the same handler that issues
          // every write of this click, so once it is gone no write is still to
          // come, whichever one landed last.
          await expect(apply).toHaveCount(0);
          await expect
            .poll(() => hashQuery(page.url()).get(FROM_PARAM))
            .toBe(days.isoDay(WINDOW_FROM_DAY));
          expect(hashQuery(page.url()).get(TO_PARAM)).toBe(
            days.isoDay(WINDOW_TO_DAY)
          );

          // The list re-queried on that window: its one row, not page 2 of the
          // recent rows the preset listed.
          await expect(windowRow).toBeVisible({
            timeout: SEEDED_SESSIONS_V2_MOUNT_TIMEOUT_MS,
          });
          await expect(secondPageRow).toHaveCount(0);
          // And still in the hash once that read has landed.
          const afterRead = hashQuery(page.url());
          expect(afterRead.get(FROM_PARAM)).toBe(days.isoDay(WINDOW_FROM_DAY));
          expect(afterRead.get(TO_PARAM)).toBe(days.isoDay(WINDOW_TO_DAY));
        }
      );
    } finally {
      cleanupSeededSessionsDirs(dirs);
    }
  });
});

/**
 * A day button of the seeded month in the open calendar.
 *
 * `:not([data-outside])` because `react-day-picker` renders the neighbouring
 * months' spill days in the same grid, and one of those carries the same
 * `data-day` as the cell this spec means.
 */
function dayCell(page: Page, days: PreviousMonthDays, day: number): Locator {
  return page.locator(
    `td[data-day="${days.isoDay(day)}"]:not([data-outside]) button`
  );
}

function pagedRowName(index: number): string {
  return `ISS-9822 window pick row ${String(index + 1).padStart(2, "0")}`;
}

/**
 * The page-2 case's corpus.
 *
 * The thirty recent rows are a minute apart, newest first, because the list
 * ORDERs BY `last_activity_at` and that decides which row lands on which page.
 * The window row sits on a day of the previous month: outside the boot 7-day
 * preset, so before the pick the list is the recent rows alone, and inside the
 * picked window, which holds nothing else.
 */
function pagedWindowSessions(days: PreviousMonthDays): SessionListSeed[] {
  const recent = Array.from(
    { length: PAGED_ROW_COUNT },
    (_unused, index): SessionListSeed => {
      const at = new Date(Date.now() - (index + 1) * MINUTE_MS).toISOString();
      return {
        at,
        lastActivityAt: at,
        name: pagedRowName(index),
        sessionId: `iss-9822-window-pick-${String(index + 1).padStart(2, "0")}`,
        status: "inactive",
      };
    }
  );
  const windowAt = `${days.isoDay(WINDOW_ROW_DAY)}T09:00:00.000Z`;
  return [
    ...recent,
    {
      at: windowAt,
      lastActivityAt: windowAt,
      name: WINDOW_ROW_NAME,
      sessionId: "iss-9822-window-pick-inside",
      status: "inactive",
    },
  ];
}
