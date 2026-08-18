/**
 * ISS-5579: full-surface coverage of the Sessions LIST column contract in the
 * Electron renderer.
 *
 * The 25 existing desktop Sessions specs are point-regressions. Between them
 * they assert that *some* header exists (`sessions-table-legibility` checks
 * every header is named and index-paired) and that the `Status` column can be
 * hidden — but none of them states WHICH columns the list has, or in what
 * order. A column could vanish from the desktop grid and all 25 stay green.
 *
 * It is the desktop half of `e2e/sessions-list-surface.spec.ts`: both surfaces
 * render the SAME shared `SessionsTable` from `packages/app/agents`, so the two
 * assert one contract through two adapters. Sort behavior is additionally
 * uncovered on BOTH surfaces today — no existing spec, web or desktop, clicks a
 * sort control.
 *
 * The expected labels are pinned as literals rather than imported from
 * `@repo/app/agents/lib/sessions-table-columns`: that module reaches
 * `@closedloop-ai/design-system/lib/column-order` through an extension-less `@repo/*`
 * subpath, and importing one of those from a desktop e2e spec aborts the whole
 * Electron run at load. The WEB spec derives the same list from the canonical
 * declaration, so a deliberate change to the column spec turns this file red and
 * the two are updated together.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import type { SessionListSeed } from "./helpers/seed-branches-db";
import {
  cleanupSeededSessionsDirs,
  makeSeededSessionsDirs,
  withSeededSessionsList,
} from "./helpers/seeded-sessions-list";

/**
 * The header sequence the Sessions spec declares with no user customization —
 * the lead column plus every data column that is not default-hidden, in
 * `SESSIONS_COLUMN_SPECS` order.
 *
 * ISS-5770 REMOVED `Signals` outright — it has no slot in the Sessions
 * prototype, and this list is the prototype's column set. This literal is the
 * desktop half of that change: the WEB twin derives its sequence from
 * `resolveRenderedSessionColumnIds` and so moved by itself, and a declaration
 * change that updates only the deriving side leaves the two surfaces asserting
 * different contracts — which is exactly what happened here. If you change
 * `SESSIONS_COLUMN_SPECS` or `SESSIONS_DEFAULT_HIDDEN_COLUMN_IDS`, this literal
 * is the line you must edit in the same commit.
 */
const EXPECTED_HEADERS = [
  "Session",
  "Status",
  "Owner",
  "Autonomy",
  "Repository",
  "Linked branches",
  "Harness",
  "Model",
  "Duration",
  "Cost",
  "Last active",
];

/**
 * Column IDs the spec declares but starts hidden
 * (`SESSIONS_DEFAULT_HIDDEN_COLUMN_IDS`) — PR / Merge / Started / Updated.
 *
 * ISS-6005 added `updated` (record-mutation recency, off by default at operator
 * direction). It belongs in THIS list rather than `EXPECTED_HEADERS`, and it is
 * ungated like its three neighbours, so its absence can only mean "hidden by
 * default" — the claim being made. This is the desktop half of the
 * off-by-default proof; a regression that leaked it into the visible set fails
 * here.
 *
 * ISS-5770 added `projects` and `issues` to that constant, but they are
 * deliberately NOT listed here: both are also gated behind `grid-table-v2`,
 * which this environment does not install, so their absence would be evidence
 * about the GATE and not about the default-hidden set. Listing them would make
 * this assertion pass for the wrong reason and keep passing if they leaked out
 * of the hidden set. The three above are ungated, so their absence can only mean
 * "hidden by default", which is the claim being made.
 *
 * Absence is asserted by ID, not by accessible name. A header cell also holds a
 * reorder grip named "Reorder <label> column, use arrow keys", so its
 * accessible name is not the bare label and a `getByRole("columnheader", {
 * exact: true, name: "Started" })` absence check would pass whether or not the
 * column rendered — a test that cannot fail.
 */
const DEFAULT_HIDDEN_COLUMN_IDS = ["pr", "merge", "started", "updated"];

/** `aria-sort` values an ACTIVE sortable header may carry. */
const SORTED_ARIA_SORT_PATTERN = /^(ascending|descending)$/;

/** Every header currently claiming the sort, whichever direction. */
const SORTED_HEADER_SELECTOR =
  '[role="columnheader"][aria-sort="ascending"], [role="columnheader"][aria-sort="descending"]';

/** The `aria-sort` value of a header that is ACTIVELY sorting. */
type SortedDirection = "ascending" | "descending";

/** The direction a second click on the already-active header must land on. */
const OPPOSITE_DIRECTION: Record<SortedDirection, SortedDirection> = {
  ascending: "descending",
  descending: "ascending",
};

const SESSION_ONE = "surface session one";
const SESSION_TWO = "surface session two";

/**
 * Matches the seeded rows' name links and nothing else. Anchored because
 * `getByRole` name matching is SUBSTRING by default.
 */
const SEEDED_ROW_NAME_PATTERN = /^surface session (one|two)$/;

const SEEDED: SessionListSeed[] = [
  {
    at: "2026-06-10T12:00:00.000Z",
    endedAt: "2026-06-10T13:00:00.000Z",
    estimatedCost: 4.25,
    lastActivityAt: "2026-06-10T13:00:00.000Z",
    name: SESSION_ONE,
    sessionId: "iss-5579-surface-1",
    status: "completed",
  },
  {
    at: "2026-06-10T14:00:00.000Z",
    endedAt: "2026-06-10T15:00:00.000Z",
    estimatedCost: 19.5,
    lastActivityAt: "2026-06-10T15:00:00.000Z",
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
  test("renders every default column, labelled, in the canonical order", async () => {
    test.setTimeout(180_000);
    const dirs = makeSeededSessionsDirs("iss5579-cols");
    try {
      await withSeededSessionsList(dirs, SEEDED, async (page) => {
        const headers = page.getByRole("columnheader").locator("visible=true");

        // Presence, label text AND order in one assertion. A per-header sweep
        // would pass on a shuffled grid; this is the statement of what the list
        // IS that the 25 point-regressions never make.
        await expect(headers).toHaveText(EXPECTED_HEADERS, {
          timeout: 30_000,
        });

        // Asserted only AFTER the positive above, so these cannot pass
        // vacuously on a page that never rendered a grid.
        for (const columnId of DEFAULT_HIDDEN_COLUMN_IDS) {
          await expect(
            page
              .locator(`[role="columnheader"][data-column-id="${columnId}"]`)
              .locator("visible=true")
          ).toHaveCount(0);
        }
      });
    } finally {
      cleanupSeededSessionsDirs(dirs);
    }
  });

  test("clicking a sortable header reorders the rows by that column", async () => {
    test.setTimeout(180_000);
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

        const costSortButton = costHeader.getByRole("button", {
          exact: true,
          name: "Cost",
        });
        // Exact name, not `.first()` and not a substring: a reorderable header
        // renders its drag grip as a button BEFORE the sort button, and that
        // grip is named "Reorder Cost column, use arrow keys" — so both a
        // positional pick and a loose name match operate the wrong control.
        await costSortButton.click();

        await expect(costHeader).toHaveAttribute(
          "aria-sort",
          SORTED_ARIA_SORT_PATTERN
        );
        // Direction is READ, not assumed: this spec deliberately does not pin
        // which way a first click opens (`SORTED_ARIA_SORT_PATTERN`), so the
        // row order it demands is the one that direction ANNOUNCES. Asserting a
        // fixed order here would make the test a claim about the toggle's
        // opening direction rather than about the ordering.
        const firstDirection = readSortedDirection(
          await costHeader.getAttribute("aria-sort")
        );
        // The reorder lands through a fresh IPC read, so give it the same
        // window the other cross-process assertions in this file get rather
        // than the 8s default.
        await expect(rowNames).toHaveText(COST_ROW_ORDER[firstDirection], {
          timeout: 30_000,
        });

        // The second click is what makes this test unfakeable. One of the two
        // Cost orders coincides with the default order, so a single pass could
        // land on the direction whose expectation an UNSORTED grid also
        // satisfies. Toggling to the opposite direction guarantees that the
        // order asserted below differs from the pre-click order in exactly one
        // of the two passes — and both are asserted, so the falsifiable one is
        // always among them.
        const secondDirection = OPPOSITE_DIRECTION[firstDirection];
        await costSortButton.click();
        await expect(costHeader).toHaveAttribute("aria-sort", secondDirection);
        await expect(rowNames).toHaveText(COST_ROW_ORDER[secondDirection], {
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

/**
 * Narrows a header's raw `aria-sort` to the direction it announces, failing
 * loudly on `none`/absent rather than coercing — a cast would let an
 * un-sorted header pick an arbitrary expected row order.
 */
function readSortedDirection(ariaSort: string | null): SortedDirection {
  if (ariaSort === "ascending" || ariaSort === "descending") {
    return ariaSort;
  }
  throw new Error(
    `expected the Cost header to announce a sort direction, got aria-sort="${ariaSort}"`
  );
}
