/**
 * ISS-6270 (whitlockk, #5111): the Duration sort, through the LAUNCHED Electron app.
 *
 * The comparator half of this ticket is covered by unit suites on both surfaces
 * (`apps/desktop/test/session-duration-sort-displayed-status.test.ts`,
 * `apps/api/app/agent-sessions/service/duration-sort-displayed-status.test.ts`).
 * Neither of them clicks anything. This spec is the desktop half of the
 * launched-app coverage: a session whose Duration cell renders BLANK must sit
 * BELOW every row that renders a measured span after a Duration-header click —
 * in both directions (FEA-4330 nulls-last).
 *
 * ISS-10364 (operator ruling, 2026-09-23) changed WHICH row is blank, not what
 * is being proved. The subject used to be a long-silent `active` row, blanked by
 * the display staleness fold; that fold is retired and such a row now times. The
 * blank here is a TERMINAL row with no end instant recorded — one instant is not
 * a span — which is the oracle's `d-terminal-no-end`, added for ISS-5131 so the
 * blanks population was never only the stale one.
 *
 * The nulls-last claim is the whole ticket, and it stays falsifiable in both
 * directions: the blank row's default-order position is mid-table, so neither
 * pass can hold by coincidence (see {@link BLANK_SILENT_MS}).
 *
 * Expected strings are pinned as literals rather than imported: an
 * extension-less `@repo/*` subpath or a main-process module imported from a
 * desktop e2e spec aborts the entire Electron run at load
 * (`apps/desktop/test/AGENTS.md`).
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import { sortColumnByOptionsMenu } from "./helpers/grid-column-sort";
import type { SessionListSeed } from "./helpers/seed-branches-db";
import {
  cleanupSeededSessionsDirs,
  makeSeededSessionsDirs,
  withSeededSessionsList,
} from "./helpers/seeded-sessions-list";

const HOUR_MS = 3_600_000;

/**
 * How long ago the blank row started and last reported.
 *
 * The load-bearing part is that it lands strictly BETWEEN {@link SHORT_SPAN_MS}
 * and {@link LONG_SPAN_MS}: a comparator that keys this row on elapsed time
 * rather than recognizing it as blank — the ISS-6270 defect — puts it in the
 * MIDDLE of the page in BOTH directions, so both passes are falsifiable. Had
 * the fixture made that elapsed time the largest, only the DESCENDING pass
 * could fail: ascending would put the largest key last, which is where
 * nulls-last wants the blank row anyway, and the assertion would have held with
 * the bug still in place.
 */
const BLANK_SILENT_MS = 30 * HOUR_MS;
const SHORT_SPAN_MS = 10 * HOUR_MS;
const LONG_SPAN_MS = 50 * HOUR_MS;

/** The `aria-sort` value of a header that is ACTIVELY sorting. */
type SortedDirection = "ascending" | "descending";

const BLANK_ROW = "duration unended blank row";
const LONG_ROW = "duration long measured row";
const SHORT_ROW = "duration short measured row";

/**
 * Matches the seeded rows' name links and nothing else. Anchored because
 * Playwright's `getByRole` name matching is SUBSTRING by default.
 */
const SEEDED_ROW_NAME_PATTERN =
  /^duration (unended blank|long measured|short measured) row$/;

/**
 * Instants are relative to the run clock, never literals: the boot retention
 * sweep deletes terminal sessions whose activity predates the 90-day window, so
 * a pinned date is a time bomb that would empty this fixture.
 */
function seededSessions(): SessionListSeed[] {
  const now = Date.now();
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  return [
    {
      // The subject: TERMINAL with no end instant recorded, so there is one
      // instant and not a span and the Duration cell renders the empty glyph.
      //
      // ISS-10364 (operator ruling, 2026-09-23) is why it is this shape and no
      // longer a long-silent `active` row. The staleness fold that used to
      // blank that row is retired, so it now times like any other live run —
      // see the sibling unit case "keeps the long-silent row timing WITH the
      // measured rows". The parity oracle's `d-terminal-no-end` was added
      // (ISS-5131) precisely so the blanks population was never only the stale
      // one, and it is the source this spec moved onto.
      //
      // `updatedAt` is deliberately RECENT so the boot retention sweep, which
      // deletes terminal sessions whose activity predates the 90-day window,
      // cannot take the row out from under the assertions.
      at: iso(BLANK_SILENT_MS),
      endedAt: null,
      lastActivityAt: iso(BLANK_SILENT_MS),
      name: BLANK_ROW,
      sessionId: "iss-6270-duration-blank",
      status: "inactive",
      updatedAt: iso(60_000),
    },
    {
      // 50h measured — the LONGEST span, and therefore the descending leader.
      at: iso(35 * HOUR_MS + LONG_SPAN_MS),
      endedAt: iso(35 * HOUR_MS),
      lastActivityAt: iso(35 * HOUR_MS),
      name: LONG_ROW,
      sessionId: "iss-6270-duration-long",
      status: "completed",
    },
    {
      // 10h measured — the SHORTEST span, and the ascending leader.
      at: iso(40 * HOUR_MS + SHORT_SPAN_MS),
      endedAt: iso(40 * HOUR_MS),
      lastActivityAt: iso(40 * HOUR_MS),
      name: SHORT_ROW,
      sessionId: "iss-6270-duration-short",
      status: "completed",
    },
  ];
}

/**
 * Row order under the DEFAULT sort — `lastActivity` descending (PLN-1034).
 *
 * The seed makes activity recency deliberately UNRELATED to duration: activity
 * runs blank (30h) -> long (35h) -> short (40h) while the spans run short (10h)
 * -> blank (none) -> long (50h). So this order matches NEITHER Duration order
 * below. The sibling Cost spec (`sessions-list-surface.spec.ts`) has to lean on
 * its second click because one of its two orders coincides with the default;
 * here both passes are falsifiable on their own, and the second click still runs
 * so the toggle is covered too.
 */
const DEFAULT_ROW_ORDER = [BLANK_ROW, LONG_ROW, SHORT_ROW];

/**
 * Row order under a Duration sort, per announced direction.
 *
 * The blank row is LAST in BOTH — that is the nulls-last contract (FEA-4330).
 * A comparator that measured elapsed time for it (30h) instead of recognizing
 * the blank would place it between the 10h and 50h measured rows either way
 * round, which is the ISS-6270 defect this ordering falsifies.
 */
const DURATION_ROW_ORDER: Record<SortedDirection, string[]> = {
  ascending: [SHORT_ROW, LONG_ROW, BLANK_ROW],
  descending: [LONG_ROW, SHORT_ROW, BLANK_ROW],
};

test.describe("Desktop Sessions Duration sort keeps blank rows last (ISS-6270)", () => {
  test("a terminal row with no recorded end has a blank Duration cell and sorts below every measured span", async () => {
    // Three Electron launches inside `withSeededSessionsList`; the config's
    // 60s file timeout is not enough for them.
    test.setTimeout(180_000);
    const dirs = makeSeededSessionsDirs("iss6270-duration");
    try {
      await withSeededSessionsList(dirs, seededSessions(), async (page) => {
        const rowNames = seededRowNames(page);
        // The PRE-click order, pinned first so no post-click order assertion can
        // pass on a grid that was already in that order.
        await expect(rowNames).toHaveText(DEFAULT_ROW_ORDER, {
          timeout: 30_000,
        });

        // The cell claim, asserted BEFORE the ordering claim: "sorts with the
        // blanks" is only meaningful if this row is in fact rendering a blank.
        // The measured control proves the same selector matches when a duration
        // IS rendered, so the absence assertions below cannot pass vacuously.
        await expect(durationCell(page, BLANK_ROW)).toHaveCount(1, {
          timeout: 30_000,
        });
        await expect(emptyDurationCell(page, BLANK_ROW)).toHaveCount(1);
        await expect(emptyDurationCell(page, LONG_ROW)).toHaveCount(0);
        await expect(emptyDurationCell(page, SHORT_ROW)).toHaveCount(0);

        const durationHeader = page
          .locator('[role="columnheader"][data-column-id="duration"]')
          .locator("visible=true");
        // An inactive sortable header announces `aria-sort="none"`. Pinned so
        // the assertions after the click cannot pass on a grid that was already
        // sorted by Duration.
        await expect(durationHeader).toHaveAttribute("aria-sort", "none", {
          timeout: 30_000,
        });

        // ISS-8909: the sort CONTROL moved, not the contract. v1 wrapped the
        // column label in a button that toggled through the directions; the
        // shared v2 header sorts from the column's options menu, which names
        // each direction — so each ordering is requested explicitly rather than
        // read back from whichever way a first click opened. Both directions
        // are still driven, and each still owes its own full row order.
        await sortColumnByOptionsMenu(page, page, "Duration", "descending");
        await expect(durationHeader).toHaveAttribute("aria-sort", "descending");
        // The reorder lands through a fresh main-process IPC read, so it gets
        // the same window as the other cross-process assertions here.
        await expect(rowNames).toHaveText(DURATION_ROW_ORDER.descending, {
          timeout: 30_000,
        });

        await sortColumnByOptionsMenu(page, page, "Duration", "ascending");
        await expect(durationHeader).toHaveAttribute("aria-sort", "ascending");
        await expect(rowNames).toHaveText(DURATION_ROW_ORDER.ascending, {
          timeout: 30_000,
        });

        // Still blank after the column it sorts by has been sorted twice: the
        // row sorts with the blanks BECAUSE it renders one, and a comparator
        // that reached nulls-last by blanking the cell instead would be a
        // different (and wrong) fix.
        await expect(emptyDurationCell(page, BLANK_ROW)).toHaveCount(1);
      });
    } finally {
      cleanupSeededSessionsDirs(dirs);
    }
  });
});

/**
 * The seeded rows' name links, in rendered order.
 *
 * Anchored on the name LINK inside each `role="row"` rather than on the lead
 * cell: `GridTable` stamps `data-column-id` on DATA cells only, and the lead
 * cell's text can also carry the provenance chip.
 */
function seededRowNames(page: Page): Locator {
  return page
    .getByRole("row")
    .getByRole("link", { name: SEEDED_ROW_NAME_PATTERN })
    .locator("visible=true");
}

/** One row's Duration cell. */
function durationCell(page: Page, rowName: string): Locator {
  return page
    .getByRole("row")
    .filter({ has: page.getByRole("link", { exact: true, name: rowName }) })
    .locator('[data-column-id="duration"]')
    .locator("visible=true");
}

/**
 * The EMPTY-value glyph inside one row's Duration cell — the shared
 * `GridEmptyValue` slot the cell renders in place of a span label.
 *
 * Asserted by slot rather than by the em-dash character: the glyph is a shared
 * design-system token, and matching its text would make this spec fail on a
 * purely typographic change while still passing if the cell started rendering a
 * real duration in a different dash.
 */
function emptyDurationCell(page: Page, rowName: string): Locator {
  return durationCell(page, rowName).locator('[data-slot="grid-empty-value"]');
}
