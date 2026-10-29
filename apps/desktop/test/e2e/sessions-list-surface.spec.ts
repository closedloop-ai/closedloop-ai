/** Sorting the shared Sessions headers must reorder rows returned by the local working-set query. */

import { expect, type Locator, type Page, test } from "@playwright/test";
import { expectFixtureInsideDefaultDateWindow } from "./helpers/date-window-fixture-guard";
import { sortColumnByOptionsMenu } from "./helpers/grid-column-sort";
import type { SessionListSeed } from "./helpers/seed-branches-db";
import {
  cleanupSeededSessionsDirs,
  makeSeededSessionsDirs,
  withSeededSessionsList,
} from "./helpers/seeded-sessions-list";

/** Every header currently claiming the sort, whichever direction. */
const SORTED_HEADER_SELECTOR =
  '[role="columnheader"][aria-sort="ascending"], [role="columnheader"][aria-sort="descending"]';

/** The `aria-sort` value of a header that is ACTIVELY sorting. */
type SortedDirection = "ascending" | "descending";

/**
 * The Cost column HEADER's rendered label — the one dollar phrase since
 * ISS-10636, and the word `sortColumnByOptionsMenu` interpolates into the
 * trigger's accessible name. Re-typed rather than imported because a
 * `@repo/app/…` specifier only resolves through the renderer's vite alias, not
 * this spec's Node runtime. The column's ID is still `"cost"`.
 */
const COST_COLUMN_HEADER_LABEL = "Total estimated cost";

const SESSION_ONE = "surface session one";
const SESSION_TWO = "surface session two";

/**
 * Matches the seeded rows' name links and nothing else. Anchored because
 * `getByRole` name matching is SUBSTRING by default.
 */
const SEEDED_ROW_NAME_PATTERN = /^surface session (one|two)$/;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * ISS-8066: the corpus anchor, derived from the run clock rather than pinned.
 *
 * These two rows used to be stamped `2026-06-10T12:00–15:00Z`, which put them
 * inside the default Sessions window on the day they were written and outside it
 * forever after. Two separate things then had to hold for this file to stay
 * green: `withSeededSessionsList` widening the range to "All time" (a rescue
 * invisible from both the assignment site and the assertions), and the seeded
 * `last_activity_at` staying inside the desktop retention sweep's 90-day horizon
 * — a sweep that DELETES terminal sessions, which the widening cannot rescue at
 * all and which the pinned dates were three days from crossing.
 *
 * A day back, so every derived instant below is safely in the past on any clock,
 * and the whole corpus sits inside the default window with no widening needed.
 * Do NOT re-pin these to a newer literal; that just re-arms both bombs.
 */
const SEED_ANCHOR_MS = Date.now() - DAY_MS;

/**
 * The two rows' instants, keeping the shape the row-order expectations below
 * were written against: one hour of runtime each, session TWO the more recent.
 */
const SESSION_ONE_STARTED_AT = seedInstant(0);
const SESSION_ONE_ACTIVITY_AT = seedInstant(1);
const SESSION_TWO_STARTED_AT = seedInstant(2);
const SESSION_TWO_ACTIVITY_AT = seedInstant(3);

const SEEDED: SessionListSeed[] = [
  {
    at: SESSION_ONE_STARTED_AT,
    endedAt: SESSION_ONE_ACTIVITY_AT,
    estimatedCost: 4.25,
    lastActivityAt: SESSION_ONE_ACTIVITY_AT,
    name: SESSION_ONE,
    sessionId: "iss-5579-surface-1",
    status: "completed",
  },
  {
    at: SESSION_TWO_STARTED_AT,
    endedAt: SESSION_TWO_ACTIVITY_AT,
    estimatedCost: 19.5,
    lastActivityAt: SESSION_TWO_ACTIVITY_AT,
    name: SESSION_TWO,
    sessionId: "iss-5579-surface-2",
    status: "completed",
  },
];

/**
 * Row order under the DEFAULT sort — `lastActivity` descending (PLN-1034) —
 * with session two the more recent (15:00 vs 13:00).
 */
const DEFAULT_ROW_ORDER = [SESSION_TWO, SESSION_ONE];

/**
 * Row order under a Cost sort, per announced direction. The seed makes cost
 * ANTI-correlated with activity ($4.25 for one, $19.50 for two), so
 * cost-ascending is the exact REVERSE of {@link DEFAULT_ROW_ORDER} while
 * cost-descending coincides with it.
 *
 * That coincidence is the trap this test has to walk around: a grid that never
 * sorted at all still shows `[two, one]`, so asserting only the descending
 * order proves nothing. Hence the test asserts the order for BOTH directions,
 * reached by clicking twice — whatever direction the header opens on, the
 * ASCENDING pass is always performed and it is the one that cannot hold unless
 * the rows genuinely reordered.
 */
const COST_ROW_ORDER: Record<SortedDirection, string[]> = {
  ascending: [SESSION_ONE, SESSION_TWO],
  descending: [SESSION_TWO, SESSION_ONE],
};

test.describe("Desktop Sessions list column surface (ISS-5579)", () => {
  test("clicking a sortable header reorders the rows by that column", async () => {
    test.setTimeout(180_000);
    expectSeedInsideDefaultWindow();
    const dirs = makeSeededSessionsDirs("iss5579-sort");
    try {
      await withSeededSessionsList(dirs, SEEDED, async (page) => {
        // Addressed by column id, the convention the desktop Sessions specs
        // already use (`[data-column-id="duration"]`), because a header cell
        // also carries reorder/resize affordances that widen its accessible
        // name.
        const costHeader = page
          .locator('[role="columnheader"][data-column-id="cost"]')
          .locator("visible=true");
        // An inactive sortable header announces `aria-sort="none"`. Pinned
        // before the click so the assertion after it cannot pass on a grid that
        // was already sorted by Cost.
        await expect(costHeader).toHaveAttribute("aria-sort", "none", {
          timeout: 30_000,
        });
        // The PRE-click row order, pinned for the same reason: without it a
        // post-click order assertion could hold on a grid that was already in
        // that order before anything was clicked.
        const rowNames = seededRowNames(page);
        await expect(rowNames).toHaveText(DEFAULT_ROW_ORDER, {
          timeout: 30_000,
        });

        // ISS-8909: the sort CONTROL moved, not the contract. v1 wrapped the
        // column label in a button that toggled through the directions, so this
        // clicked once and read back whichever way it opened. The shared v2
        // header renders the label as a plain `<span>` and sorts from the
        // column's options menu, which names each direction — so each ordering
        // is now requested explicitly instead of inferred.
        //
        // BOTH directions are still driven and asserted, which is what keeps
        // this unfakeable: one of the two Cost orders coincides with the
        // default order, so a single direction could pass on a grid that never
        // re-sorted at all. Asserting the other guarantees an order that
        // differs from the pre-click one.
        await sortColumnByOptionsMenu(
          page,
          page,
          COST_COLUMN_HEADER_LABEL,
          "descending"
        );
        await expect(costHeader).toHaveAttribute("aria-sort", "descending");
        // The reorder lands through a fresh IPC read, so give it the same
        // window the other cross-process assertions in this file get rather
        // than the 8s default.
        await expect(rowNames).toHaveText(COST_ROW_ORDER.descending, {
          timeout: 30_000,
        });

        await sortColumnByOptionsMenu(
          page,
          page,
          COST_COLUMN_HEADER_LABEL,
          "ascending"
        );
        await expect(costHeader).toHaveAttribute("aria-sort", "ascending");
        await expect(rowNames).toHaveText(COST_ROW_ORDER.ascending, {
          timeout: 30_000,
        });

        // Exactly one column may claim the sort — a second sorted header would
        // mean the grid is announcing two orderings for one row set.
        const sorted = page
          .locator(SORTED_HEADER_SELECTOR)
          .locator("visible=true");
        await expect(sorted).toHaveCount(1);
      });
    } finally {
      cleanupSeededSessionsDirs(dirs);
    }
  });
});

/**
 * The seeded rows' name links, in rendered order — the handle the row-order
 * assertions compare against.
 *
 * Anchored on the name LINK inside each `role="row"` rather than on the lead
 * cell: `GridTable` stamps `data-column-id` on DATA cells only (the lead cell
 * has none), and the lead cell's text can also carry the provenance chip, so
 * its text is not the row's name. `visible=true` follows this file's
 * convention, keeping the narrow-surface card layout from contributing a second
 * copy of a row.
 */
function seededRowNames(page: Page): Locator {
  return page
    .getByRole("row")
    .getByRole("link", { name: SEEDED_ROW_NAME_PATTERN })
    .locator("visible=true");
}

/** One seeded instant, `hoursAfterAnchor` past {@link SEED_ANCHOR_MS}. */
function seedInstant(hoursAfterAnchor: number): string {
  return new Date(SEED_ANCHOR_MS + hoursAfterAnchor * HOUR_MS).toISOString();
}

/**
 * ISS-8066: the seeded rows are inside the window the Sessions read applies
 * BEFORE `withSeededSessionsList` widens the range, so this file no longer
 * depends on that widening for its rows to exist.
 *
 * `last_activity_at` is the field the desktop Sessions read windows on
 * (`session-aggregate-filters.ts`), so it is the field checked. Runs first in
 * each test, so a re-pinned literal fails here in milliseconds with the range
 * and the bounds named, instead of as a 30s `getByRole("link")` timeout inside
 * the helper that reads like the grid stopped rendering.
 *
 * A precondition only. The row-order expectations (`DEFAULT_ROW_ORDER`,
 * `COST_ROW_ORDER`) stay independently-written literals.
 */
function expectSeedInsideDefaultWindow(): void {
  expectFixtureInsideDefaultDateWindow(
    SESSION_ONE_ACTIVITY_AT,
    `Seeded "${SESSION_ONE}" lastActivityAt`
  );
  expectFixtureInsideDefaultDateWindow(
    SESSION_TWO_ACTIVITY_AT,
    `Seeded "${SESSION_TWO}" lastActivityAt`
  );
}
