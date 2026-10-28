/**
 * ISS-12471 and ISS-12288 AC2 — the DESKTOP Sessions list comes back at the
 * offset the reader left it, with its body WINDOWED, driven through the shipped
 * Electron shell. Two claims, because each is green under the other's defect.
 *
 * TWO PRODUCTION MUTATIONS, EACH OF WHICH MUST TURN THIS RED:
 *
 * 1. (ISS-12471) Drop `tableScrollRef={registerRouteScroller}` from
 *    `SessionsV2View`'s `SessionsListSurfaceV2` mount. The App shell's per-href
 *    scroll memory (`use-content-scroll-restoration.ts`) then measures
 *    `desktop-content-viewport` again, which this route pins to the window
 *    height -- `clientHeight` and `scrollHeight` both 701 in the ISS-12471
 *    measurement -- so nothing is remembered and the restore has nothing to
 *    write. Measured red: `Expected: 381, Received: 0`.
 * 2. (ISS-12288 AC2) Make `resolveScrollParent`
 *    (`@closedloop-ai/design-system/lib/scroll-parent`) return null, the divergence
 *    ISS-12288 names: the window finds no scroller, disables itself, and paints
 *    the whole page. Restoration still works, so claim 1 stays GREEN -- which is
 *    why the row-window assertion exists. Measured red: `Expected: < 60,
 *    Received: 60`. Note `aria-rowcount` is still published under this mutation
 *    (it is gated on the `virtualizeBody` prop, not on finding a scroller), so
 *    the attribute alone cannot discriminate it; only the painted count can.
 *
 * WHY IT TAKES A LAUNCHED SHELL. The jsdom suite that owns this round trip,
 * `src/renderer/__tests__/app-shell-sessions.test.tsx`, asserted exactly this
 * restore for months against a no-op: jsdom stores whatever is written to
 * `scrollTop` with no layout behind it, and the content viewport div it drove
 * never unmounts, so the value it read back was the one it had assigned itself.
 * It now drives the grid band and proves the band is a fresh node, which makes
 * it fail on the mutation above -- but only a real layout can establish the
 * premise this spec opens with, that the viewport cannot overflow while the
 * band can.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import { expect, type Locator, test } from "@playwright/test";
import { breadcrumbParentLink, gotoHash } from "./helpers/desktop-app";
import type { SessionListSeed } from "./helpers/seed-branches-db";
import {
  cleanupSeededSessionsDirs,
  makeSeededSessionsDirs,
} from "./helpers/seeded-sessions-list";
import {
  expectGridTableV2Mounted,
  SCROLL_BAND_TEST_ID,
  SEEDED_SESSIONS_V2_MOUNT_TIMEOUT_MS,
  withSeededSessionsV2List,
} from "./helpers/seeded-sessions-v2-list";

/** The Topbar breadcrumb's parent segment, the back affordance this route has. */
const SESSIONS_BREADCRUMB = "Sessions";
const CONTENT_VIEWPORT_TEST_ID = "desktop-content-viewport";
const MINUTE_MS = 60_000;

/**
 * `SESSIONS_PAGE_SIZE_PARAM` and a base-ladder rung
 * (`TABLE_PAGE_SIZE_OPTIONS`), spelled here for the reason the helpers state:
 * this loader cannot pull a React component module, and the ladder's home is
 * one. 100 is in the BASE ladder, so no page-size flag is involved; 250 and 500
 * are the two rungs behind `table-page-size-ladder`.
 */
const PAGE_SIZE_PARAM = "pageSize";
const ONE_PAGE_SIZE = 100;

/**
 * `ARIA_HEADER_ROW_COUNT` (`grid-table-v2.tsx`), which is module-private there.
 * `aria-rowcount` counts the header row alongside the data rows, so the
 * population is the attribute minus this.
 */
const ARIA_HEADER_ROW_COUNT = 1;

/**
 * Every seeded row lands on ONE page, because the spec pins
 * `pageSize={ONE_PAGE_SIZE}`. That is what gives the row-window assertion its
 * margin: the window paints ~20 rows at this harness's window height, so the
 * comparison has ~40 rows of room rather than the 5 it would have at the
 * default 25. The ISS-12471 measurement on this corpus read `scrollHeight:
 * 1136` against `clientHeight: 361`; the premise assertions below
 * re-establish both facts rather than trusting either.
 */
const SEEDED_ROW_COUNT = 60;

/** Two digits, so no row name is a prefix of another (`row 1` matches `row 10`). */
function rowName(index: number): string {
  return `ISS-12471 scroll ${String(index + 1).padStart(2, "0")}`;
}

/**
 * `at` descending by a minute a row pins the order against the default
 * `lastActivity` desc view, and `inactive` keeps every row terminal so no label
 * depends on the run clock.
 */
const SEEDED_SESSIONS: SessionListSeed[] = Array.from(
  { length: SEEDED_ROW_COUNT },
  (_unused, index) => {
    const at = new Date(Date.now() - (index + 1) * MINUTE_MS).toISOString();
    return {
      at,
      lastActivityAt: at,
      name: rowName(index),
      sessionId: `iss-12471-scroll-${String(index + 1).padStart(2, "0")}`,
      status: "inactive",
    };
  }
);

test.describe("Desktop Sessions v2 scroll restoration (ISS-12471)", () => {
  test("returns from a windowed session list at the offset the band was left at", async () => {
    test.setTimeout(300_000);

    const dirs = makeSeededSessionsDirs("desktop-v2-scroll-restore");
    try {
      await withSeededSessionsV2List(
        dirs,
        {
          featureFlags: {},
          readyRowName: rowName(0),
          sessions: SEEDED_SESSIONS,
        },
        async (page, panel) => {
          const scrollBand = panel.getByTestId(SCROLL_BAND_TEST_ID);
          const contentViewport = page.getByTestId(CONTENT_VIEWPORT_TEST_ID);

          // ISS-12288 AC2: put the WHOLE corpus on one page, so the window's
          // slice sits far below the population. At the default 25 the margin
          // is a handful of rows and a taller harness window would close it,
          // which would redden as "windowing broke" rather than "the window
          // grew". The URL is the lever the desktop host owns (ISS-8756).
          await gotoHash(page, `/sessions?${PAGE_SIZE_PARAM}=${ONE_PAGE_SIZE}`);
          await expect(scrollBand).toBeVisible({
            timeout: SEEDED_SESSIONS_V2_MOUNT_TIMEOUT_MS,
          });
          await expect
            .poll(() => rowPopulation(panel), {
              timeout: SEEDED_SESSIONS_V2_MOUNT_TIMEOUT_MS,
            })
            .toBe(SEEDED_ROW_COUNT);

          // The windowing half of AC2, which the restoration assertions below
          // cannot cover: they pass whether or not the body is windowed. The
          // divergence ISS-12288 names is `getScrollParent` resolving to
          // nothing on desktop, which disables the window and paints the whole
          // page -- indistinguishable from working, until this is asserted.
          expect(await paintedRowCount(scrollBand)).toBeLessThan(
            SEEDED_ROW_COUNT
          );

          // The premise, and the whole reason the shell was measuring the wrong
          // element: on this route the content viewport cannot overflow, and the
          // band can. Without this pair, a restored 0 would be indistinguishable
          // from a restore that worked on a list that never scrolled.
          await expect
            .poll(() => overflow(scrollBand), {
              timeout: SEEDED_SESSIONS_V2_MOUNT_TIMEOUT_MS,
            })
            .toBeGreaterThan(0);
          expect(await overflow(contentViewport)).toBe(0);
          expect(await offsetOf(scrollBand)).toBe(0);

          const openedHref = await centerPaintedRow(scrollBand);
          const leftAt = await offsetOf(scrollBand);
          // A restore to 0 is what the bug produced, so the offset under test
          // has to be meaningfully off the top.
          expect(leftAt).toBeGreaterThan(80);

          // Marked so the assertion after the return cannot be satisfied by the
          // very element this spec scrolled: the detail route unmounts the list,
          // and the band that comes back is a new node with no marker.
          await scrollBand.evaluate((band) => {
            band.dataset.iss12471LeftAt = "1";
          });

          const openedRow = panel.locator(`a[href="${openedHref}"]`);
          await openedRow.click();
          await expect(
            breadcrumbParentLink(page, SESSIONS_BREADCRUMB)
          ).toBeVisible({ timeout: SEEDED_SESSIONS_V2_MOUNT_TIMEOUT_MS });

          await breadcrumbParentLink(page, SESSIONS_BREADCRUMB).click();
          await expect(panel).toBeVisible({
            timeout: SEEDED_SESSIONS_V2_MOUNT_TIMEOUT_MS,
          });
          await expectGridTableV2Mounted(panel);
          await expect(scrollBand).not.toHaveAttribute("data-iss12471-left-at");

          await expect
            .poll(() => offsetOf(scrollBand), {
              timeout: SEEDED_SESSIONS_V2_MOUNT_TIMEOUT_MS,
            })
            .toBe(leftAt);
        }
      );
    } finally {
      cleanupSeededSessionsDirs(dirs);
    }
  });
});

/**
 * The rows the PAGE holds, read off the grid's `aria-rowcount` rather than
 * counted in the DOM -- counting the DOM would measure the window's slice,
 * which is the other half of the comparison.
 */
async function rowPopulation(panel: Locator): Promise<number> {
  const rowCount = await panel
    .getByRole("grid")
    .first()
    .getAttribute("aria-rowcount");
  if (rowCount === null) {
    throw new Error(
      "the Sessions grid published no aria-rowcount, so the body is not windowed"
    );
  }
  return Number(rowCount) - ARIA_HEADER_ROW_COUNT;
}

/** The rows the windowed body actually painted, by their detail links. */
function paintedRowCount(scrollBand: Locator): Promise<number> {
  return scrollBand.evaluate(
    (band) => band.querySelectorAll('a[href^="#/sessions/"]').length
  );
}

function offsetOf(element: Locator): Promise<number> {
  return element.evaluate((node) => node.scrollTop);
}

function overflow(element: Locator): Promise<number> {
  return element.evaluate((node) => node.scrollHeight - node.clientHeight);
}

/**
 * Scrolls the band, then centers whichever row the windowed body actually
 * painted nearest the band's middle and returns that row's href.
 *
 * Centering first is what keeps the click from moving the band: Playwright
 * scrolls a target into view before clicking, and a row at the band's middle
 * needs no scrolling, so the offset captured afterwards is the one the reader
 * leaves on. Picking a PAINTED row rather than a row index is for the same
 * windowing reason the ISS-12471 measurement records -- the body paints a
 * subset, so a row deep in the page is not in the DOM until it is scrolled to.
 */
function centerPaintedRow(scrollBand: Locator): Promise<string> {
  return scrollBand.evaluate((band) => {
    band.scrollTop = Math.min(400, band.scrollHeight - band.clientHeight);
    const bandRect = band.getBoundingClientRect();
    const bandCenter = bandRect.top + bandRect.height / 2;
    const rows = [
      ...band.querySelectorAll<HTMLAnchorElement>('a[href^="#/sessions/"]'),
    ];
    const nearest = rows.reduce<{ row: HTMLAnchorElement; gap: number } | null>(
      (best, row) => {
        const rect = row.getBoundingClientRect();
        const gap = Math.abs(rect.top + rect.height / 2 - bandCenter);
        return best && best.gap <= gap ? best : { gap, row };
      },
      null
    );
    if (!nearest) {
      throw new Error("the windowed Sessions body painted no row links");
    }
    const rect = nearest.row.getBoundingClientRect();
    band.scrollTop +=
      rect.top - bandRect.top - bandRect.height / 2 + rect.height / 2;
    return nearest.row.getAttribute("href") ?? "";
  });
}
