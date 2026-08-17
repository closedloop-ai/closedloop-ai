/**
 * ISS-6270 (wongk, #5111): the Duration sort, through the LAUNCHED Electron app.
 *
 * The comparator half of this ticket is covered by unit suites on both surfaces
 * (`apps/desktop/test/session-duration-sort-displayed-status.test.ts`,
 * `apps/api/app/agent-sessions/service/duration-sort-displayed-status.test.ts`).
 * Neither of them clicks anything. This spec is the desktop half of the
 * launched-app coverage: a session silent past the display staleness cutoff
 * renders a BLANK Duration cell, and clicking the Duration header must leave that
 * row BELOW every row that renders a measured span — in both directions
 * (FEA-4330 nulls-last).
 *
 * That row is the whole ticket. Before ISS-6270 the comparator classified the RAW
 * `active` status, so it took the running branch and keyed a row whose cell
 * renders NOTHING on `now - start` — a span that grows against the clock. As
 * reported, that span was the largest in the table and led the descending page;
 * this fixture reproduces the same disagreement with a mid-range span so that
 * both directions, not just descending, are falsifiable (see
 * {@link BLANK_SILENT_MS}).
 *
 * Expected strings are pinned as literals rather than imported: an
 * extension-less `@repo/*` subpath or a main-process module imported from a
 * desktop e2e spec aborts the entire Electron run at load
 * (`apps/desktop/test/AGENTS.md`).
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import type { SessionListSeed } from "./helpers/seed-branches-db";
import {
  cleanupSeededSessionsDirs,
  makeSeededSessionsDirs,
  withSeededSessionsList,
} from "./helpers/seeded-sessions-list";

const HOUR_MS = 3_600_000;

/**
 * How long the `active` row has been silent — past the 24h
 * `STALE_SESSION_DISPLAY_THRESHOLD_HOURS`, so it displays Stale.
 *
 * It also lands strictly BETWEEN {@link SHORT_SPAN_MS} and {@link LONG_SPAN_MS},
 * and that is the load-bearing part of the arrangement. The pre-ISS-6270
 * comparator keyed this row on `now - started_at` — here 30h — so the blank row
 * lands in the MIDDLE of the page in BOTH directions. Had the fixture instead
 * made that span the largest, only the DESCENDING pass could fail: ascending
 * would put the largest key last, which is where nulls-last wants the blank row
 * anyway, and the assertion would have held with the bug still in place.
 */
const BLANK_SILENT_MS = 30 * HOUR_MS;
const SHORT_SPAN_MS = 10 * HOUR_MS;
const LONG_SPAN_MS = 50 * HOUR_MS;

/** `aria-sort` values an ACTIVE sortable header may carry. */
const SORTED_ARIA_SORT_PATTERN = /^(ascending|descending)$/;

/** The `aria-sort` value of a header that is ACTIVELY sorting. */
type SortedDirection = "ascending" | "descending";

/** The direction a second click on the already-active header must land on. */
const OPPOSITE_DIRECTION: Record<SortedDirection, SortedDirection> = {
  ascending: "descending",
  descending: "ascending",
};

const BLANK_ROW = "duration stale blank row";
const LONG_ROW = "duration long measured row";
const SHORT_ROW = "duration short measured row";

/**
 * Matches the seeded rows' name links and nothing else. Anchored because
 * Playwright's `getByRole` name matching is SUBSTRING by default.
 */
const SEEDED_ROW_NAME_PATTERN =
  /^duration (stale blank|long measured|short measured) row$/;

/**
 * Instants are relative to the run clock, never literals. The display staleness
 * fold compares `lastActivityAt` against the live `new Date()` in the renderer,
 * and the boot retention sweep deletes terminal sessions whose activity predates
 * the 90-day window — a pinned date is a time bomb on both counts.
 */
function seededSessions(): SessionListSeed[] {
  const now = Date.now();
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  return [
    {
      // The subject: `active`, never ended, and silent for 30h — past the 24h
      // display staleness cutoff, so it DISPLAYS as Stale and its Duration cell
      // renders the empty glyph.
      //
      // `at` is the SAME instant as `lastActivityAt` on purpose. The projected
      // activity anchor is the event-derived `max(started_at, max(event
      // created_at))` unless the read prefers the stored column, and the seeder
      // writes its substantive tool event at `at` — so pinning both to 30h ago
      // puts EVERY path that could win past the cutoff. A fixture where only one
      // of them is stale would fold to Stale or not depending on which branch
      // the read took.
      //
      // `updatedAt` is deliberately RECENT. The boot stale sweep reaps an
      // `active` row whose `updated_at` predates DEFAULT_STALE_SESSION_MINUTES
      // into `inactive` with `ended_at = last_activity_at` — which would hand
      // the row a MEASURED duration and make this spec pass or fail for a
      // reason that has nothing to do with the comparator.
      at: iso(BLANK_SILENT_MS),
      endedAt: null,
      lastActivityAt: iso(BLANK_SILENT_MS),
      name: BLANK_ROW,
      sessionId: "iss-6270-duration-blank",
      status: "active",
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
 * The blank row is LAST in BOTH — that is the nulls-last contract (FEA-4330),
 * and it is the assertion the pre-ISS-6270 comparator fails in BOTH directions:
 * keying the raw `active` status measured `now - start` for it (30h), which
 * places it between the 10h and 50h measured rows either way round.
 */
const DURATION_ROW_ORDER: Record<SortedDirection, string[]> = {
  ascending: [SHORT_ROW, LONG_ROW, BLANK_ROW],
  descending: [LONG_ROW, SHORT_ROW, BLANK_ROW],
};

test.describe("Desktop Sessions Duration sort keeps blank rows last (ISS-6270)", () => {
  test("a stale row's Duration cell is blank and sorts below every measured span", async () => {
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

        // Exact name, not `.first()`: a reorderable header renders its drag grip
        // as a button BEFORE the sort button, named "Reorder Duration column,
        // use arrow keys", so a positional pick operates the wrong control.
        const durationSortButton = durationHeader.getByRole("button", {
          exact: true,
          name: "Duration",
        });
        await durationSortButton.click();

        await expect(durationHeader).toHaveAttribute(
          "aria-sort",
          SORTED_ARIA_SORT_PATTERN
        );
        // Direction is READ, not assumed — this spec makes no claim about which
        // way a first click opens, only about the order each direction owes.
        const firstDirection = readSortedDirection(
          await durationHeader.getAttribute("aria-sort")
        );
        // The reorder lands through a fresh main-process IPC read, so it gets
        // the same window as the other cross-process assertions here.
        await expect(rowNames).toHaveText(DURATION_ROW_ORDER[firstDirection], {
          timeout: 30_000,
        });

        const secondDirection = OPPOSITE_DIRECTION[firstDirection];
        await durationSortButton.click();
        await expect(durationHeader).toHaveAttribute(
          "aria-sort",
          secondDirection
        );
        await expect(rowNames).toHaveText(DURATION_ROW_ORDER[secondDirection], {
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

/**
 * Narrows a header's raw `aria-sort` to the direction it announces, failing
 * loudly on `none`/absent rather than coercing — a cast would let an unsorted
 * header pick an arbitrary expected row order.
 */
function readSortedDirection(ariaSort: string | null): SortedDirection {
  if (ariaSort === "ascending" || ariaSort === "descending") {
    return ariaSort;
  }
  throw new Error(
    `expected the Duration header to announce a sort direction, got aria-sort="${ariaSort}"`
  );
}
