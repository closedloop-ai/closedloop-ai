/**
 * ISS-8198 / PLN-1952 T-1.4 — the DESKTOP Sessions footer's PAGER and the range
 * readout beside it, driven through the shipped Electron shell with
 * `grid-table-v2` ON.
 *
 * THE PRODUCTION MUTATION THAT MUST TURN THIS RED: in `writeDesktopSessionsPage`
 * (`SessionsView.tsx`), make the v2 arm write page index 0 —
 * `writePageWithPageSize(params, 0, effectivePageSize)`. Every page write on
 * this branch then lands on page one: Next renumbers nothing, the readout keeps
 * reporting the first page, and the rows never move. A pager that looks live and
 * reaches nothing.
 *
 * NO EXISTING jsdom OR RENDERER SUITE CATCHES THAT, measured rather than
 * assumed. That function branches on the flag, and the one suite that clicks
 * this same Next control — `app-shell-sessions.test.tsx`, which asserts the hash
 * becomes `#/sessions?page=2` and the read goes out at `offset: 25` — runs with
 * `grid-table-v2` OFF, so it takes the OTHER arm (`writeSessionsPage`) and stays
 * green. The two v2 suites that reach this arm at all
 * (`sessions-v2-mount.test.tsx`, `sessions-view-page-size.test.tsx`) mock the
 * list surface and toolbar away and drive the URL directly; their only v2 page
 * write is the RESET to page one that a size change performs, which the mutation
 * reproduces byte-for-byte.
 *
 * THE OBVIOUS MUTATION IS ALREADY CAUGHT, and naming it would have failed
 * PLN-1952 AC-002's second clause. Dropping `replacePage: setPage` from the
 * writer set `SessionsV2View` hands `applySessionsHostViewChange` reddens
 * `sessions-v2-mount.test.tsx` → "reads v2 page size from the URL and resets a
 * higher page in one write", which reaches `replacePage` through the surface's
 * page reset rather than through a pager click. So does pointing the read's
 * `offset` at zero. Same shape as C1's finding on T-1.1.
 *
 * WHAT THE REQUEST READ ADDS. `readPageDataFilters` is the local analogue of
 * reading `page.route`'s URLs — there is no HTTP on this path, so the request
 * record lives in the main process. It is asserted because the footer DERIVES
 * its sentence from `page`, `pageSize`, `rowsOnPage` and `total` rather than
 * from the read: a pager that renumbered without refetching would still print a
 * true-looking "Showing 26-30 of 30 sessions" over page one's rows. The row
 * identity assertions kill that too; the request assertion is what names it.
 *
 * THE ROWS-PER-PAGE HALF OF T-1.4 IS DELIBERATELY ABSENT, and this is a
 * correction to the plan rather than a gap. ISS-8756 already shipped it as the
 * third case of `sessions-v2-mount.spec.ts` — "the desktop Sessions v2 footer
 * changes rows per page through URL-backed state" — on this same shell, this
 * same flag and a 30-row corpus, asserting the control, `?pageSize=50` and both
 * readout sentences. Its "Showing 1-30 of 30 sessions" can only be true of a
 * read that actually returned 30 rows, so even the outgoing-request claim is
 * already made there. Re-driving it here would be a second copy that fails in
 * the same week as the first and proves nothing more.
 *
 * SINGLE-BOOT, FLAG-ON ONLY (PLN-1952 AC-006). `sessions-v2-mount.spec.ts`
 * already owns "the v2 branch is reachable and the v1 branch still is".
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import { expect, test } from "@playwright/test";
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
import { readPageDataFilters } from "./helpers/sessions-page-data-gate";

/**
 * Spelled as LITERALS because their canonical homes are React component modules
 * under `packages/design-system/components/ui/`, and pulling a React runtime
 * through Playwright's ESM loader aborts the WHOLE desktop-e2e suite at load
 * with no failing test name to point at it. An EXTENSION-QUALIFIED `@repo/*`
 * subpath resolves fine and sibling specs use them freely
 * (`apps/desktop/test/AGENTS.md`); it is the extension-less form that does not.
 *
 * The band's test id, the current-page link and the next-page control are the
 * three literals every v2 spec addresses the footer through, so all three live
 * in `helpers/seeded-sessions-v2-list` and are imported above rather than
 * re-spelled here.
 * The two readout sentences are `sessionsRangeSentence` over this corpus,
 * written out rather than derived: an expectation computed from the code under
 * test cannot fail.
 */
const FIRST_PAGE_READOUT = "Showing 1-25 of 30 sessions";
const SECOND_PAGE_READOUT = "Showing 26-30 of 30 sessions";

/** One page of 25 plus a short second page — the smallest corpus with two pages. */
const SEEDED_ROW_COUNT = 30;
const DEFAULT_PAGE_SIZE = 25;
const MINUTE_MS = 60_000;

/**
 * Two-digit row numbers, so no row name is a prefix of another: an accessible-
 * name match is a case-insensitive substring by default, and "row 1" would also
 * resolve "row 10".
 */
function rowName(index: number): string {
  return `ISS-8198 pagination row ${String(index + 1).padStart(2, "0")}`;
}

const FIRST_PAGE_ROW_NAME = rowName(0);
/** The 26th row — first of page two under the default 25-row page. */
const SECOND_PAGE_ROW_NAME = rowName(DEFAULT_PAGE_SIZE);

/**
 * Thirty rows, newest first, each `status` seeded EXPLICITLY.
 *
 * `at` descending by a minute a row pins the ORDER: the default view sorts on
 * `lastActivity` desc, and the desktop cursor page ORDERs BY the DENORMALIZED
 * `sessions.last_activity_at` column (`listSqliteSessionCursorPage`), so
 * `lastActivityAt` — seeded equal to `at` on every row below — is the lever
 * that decides which row lands on which page. All thirty are minutes old, so
 * every one is inside any preset window.
 *
 * `inactive` rather than `active`: `resolveDisplayedSessionStatus` folds a live
 * row silent for 24h to Stale, so an `active` fixture's rendered status depends
 * on the wall clock. Nothing here reads the status, but the corpus stays
 * consistent with the sibling v2 specs.
 */
const SEEDED_SESSIONS: SessionListSeed[] = Array.from(
  { length: SEEDED_ROW_COUNT },
  (_unused, index) => {
    const at = new Date(Date.now() - (index + 1) * MINUTE_MS).toISOString();
    return {
      at,
      lastActivityAt: at,
      name: rowName(index),
      sessionId: `iss-8198-pagination-${String(index + 1).padStart(2, "0")}`,
      status: "inactive",
    };
  }
);

test.describe("Desktop Sessions v2 pagination (ISS-8198 T-1.4)", () => {
  test("turns the page, and the readout, the pager and the outgoing read all move with it", async () => {
    test.setTimeout(300_000);

    const dirs = makeSeededSessionsDirs("desktop-v2-pagination");
    try {
      await withSeededSessionsV2List(
        dirs,
        {
          featureFlags: {},
          readyRowName: FIRST_PAGE_ROW_NAME,
          // Records the query of every `pageData` invocation. INERT unless a
          // spec arms it, which this one never does — it only reads.
          sessionsPageDataGate: true,
          sessions: SEEDED_SESSIONS,
        },
        async (_page, panel, app) => {
          // Without this, a pin that stopped taking would silently re-test v1
          // through a footer v1's host composes for itself.
          await expectGridTableV2Mounted(panel);

          const footer = panel.getByTestId(PAGINATION_BAND_TEST_ID);
          const readout = footer.getByRole("status");
          const currentPage = footer.locator(CURRENT_PAGE_SELECTOR);
          const firstPageRow = panel.getByRole("link", {
            exact: true,
            name: FIRST_PAGE_ROW_NAME,
          });
          const secondPageRow = panel.getByRole("link", {
            exact: true,
            name: SECOND_PAGE_ROW_NAME,
          });

          // Page one, stated. The ABSENCE is the premise for the page change
          // below: the 26th row is genuinely NOT on this page, so its
          // appearance afterwards is the page turning and not a corpus that
          // always held it. Page one's own first row is this launch's
          // `readyRowName`, so the helper has already asserted the identical
          // locator and it is not restated here.
          await expect(readout).toHaveText(FIRST_PAGE_READOUT, {
            timeout: SEEDED_SESSIONS_V2_MOUNT_TIMEOUT_MS,
          });
          await expect(currentPage).toHaveText("1");
          await expect(secondPageRow).toHaveCount(0);

          await footer.locator(NEXT_PAGE_SELECTOR).click();

          // The sentence, the pager and the ROWS move together. Asserting only
          // the sentence would leave a pager that renumbers over a page it never
          // fetched looking correct.
          await expect(readout).toHaveText(SECOND_PAGE_READOUT);
          await expect(currentPage).toHaveText("2");
          await expect(secondPageRow).toBeVisible();
          await expect(firstPageRow).toHaveCount(0);

          // And the READ moved with the control: a second-page request actually
          // went out at the second page's offset. The footer derives its
          // sentence from `page`/`pageSize`/`total`, so this claim is not
          // recoverable from the readout.
          const requests = await readPageDataFilters(app);
          expect(requests).toContainEqual(
            expect.objectContaining({
              limit: DEFAULT_PAGE_SIZE,
              offset: DEFAULT_PAGE_SIZE,
            })
          );
        }
      );
    } finally {
      cleanupSeededSessionsDirs(dirs);
    }
  });
});
