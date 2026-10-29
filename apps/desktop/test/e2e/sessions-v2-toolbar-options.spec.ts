/**
 * Native Sessions host regression: Options hides a card and column through
 * persisted view state, and Reset view restores both in the launched app.
 */

import { expect, test } from "@playwright/test";
import { TOTAL_TOKENS_METRIC_CARD_LABEL } from "@repo/app/agents/components/sessions/sessions-summary-card-labels.ts";
import type { SessionListSeed } from "./helpers/seed-branches-db";
import {
  cleanupSeededSessionsDirs,
  makeSeededSessionsDirs,
} from "./helpers/seeded-sessions-list";
import {
  columnHeaderById,
  SEEDED_SESSIONS_V2_MOUNT_TIMEOUT_MS,
  withSeededSessionsV2List,
} from "./helpers/seeded-sessions-v2-list";

/**
 * Spelled as LITERALS — for two different reasons, and NOT as a blanket rule
 * about `@repo/*`. An EXTENSION-QUALIFIED subpath resolves under Playwright's
 * ESM loader and sibling specs use them freely; it is the extension-LESS form
 * that does not (`apps/desktop/test/AGENTS.md`). So the summary card's label IS
 * imported above, from its zero-dependency constants module, rather than
 * re-typed as a third copy of the same string.
 *
 * The band test id and the menu's own labels, because their canonical homes
 * reach a React component runtime: they live IN
 * `packages/design-system/components/ui/*.tsx`, and `sessions-table-columns.ts`
 * pulls one in extension-lessly
 * (`@closedloop-ai/design-system/components/ui/grid-table`). Either way the import aborts
 * at load time and takes the WHOLE desktop-e2e suite down with no failing test
 * name to point at it. Drift in those is caught first by the renderer suites,
 * which import the real symbols.
 *
 * `METRIC_BAND_TEST_ID` — `GRID_TABLE_METRIC_BAND_TEST_ID`.
 * `SUMMARY_CARDS_SECTION` / `COLUMNS_SECTION` / `RESET_VIEW_ITEM` — the two
 *   `DropdownMenuLabel`s and the reset row of `TableOptionsMenu`.
 * `TOGGLED_COLUMN_*` / `CONTROL_COLUMN_*` — the `harness` and `status` entries of
 *   `SESSIONS_COLUMN_SPECS`.
 */
const METRIC_BAND_TEST_ID = "grid-table-metric-band";
const OPTIONS_BUTTON = "Options";
const SUMMARY_CARDS_SECTION = "Summary cards";
const COLUMNS_SECTION = "Show / hide columns";
const RESET_VIEW_ITEM = "Reset view";

/**
 * `Harness` is toggled and `Status` is the control, both deliberately.
 *
 * Neither is in `SESSIONS_DEFAULT_HIDDEN_COLUMN_IDS` (`pr`, `merge`, `started`,
 * `updated`, `projects`, `issues`, `tags`), so both are on screen at rest and an
 * assertion against either can actually fail. A hidden-by-default column would
 * make the "it disappeared" assertion true before the click and hang the
 * "it came back" assertion to the test timeout rather than failing it.
 */
const TOGGLED_COLUMN_ID = "harness";
const TOGGLED_COLUMN_LABEL = "Harness";
const CONTROL_COLUMN_ID = "status";

const SEEDED_SESSIONS: SessionListSeed[] = [
  {
    name: "ISS-8198 toolbar options",
    sessionId: "iss-8198-toolbar-options-1",
    // Explicit rather than defaulted, so the Status control column below renders
    // a real value and this corpus reads the same as the grouping spec's.
    status: "inactive",
  },
];
const READY_ROW_NAME = "ISS-8198 toolbar options";

test.describe("Desktop Sessions v2 Options menu (ISS-8198 T-1.1)", () => {
  /**
   * ONE test, three claims, on one launch. All three are read off the same
   * settled default view of the same seeded corpus, so splitting them would
   * re-verify the same boot three times: it buys no isolation and costs two more
   * launch pairs at ~17s each — the shape `sessions-pinned-lead-column.spec.ts`
   * documents.
   */
  test("hides a summary card and a column from the Options menu, and Reset view brings both back", async () => {
    test.setTimeout(300_000);

    const dirs = makeSeededSessionsDirs("desktop-v2-toolbar-options");
    try {
      await withSeededSessionsV2List(
        dirs,
        {
          featureFlags: {},
          readyRowName: READY_ROW_NAME,
          sessions: SEEDED_SESSIONS,
        },
        async (page, panel) => {
          const summaryCard = panel
            .getByTestId(METRIC_BAND_TEST_ID)
            .locator('[data-slot="card"]')
            .filter({ hasText: TOTAL_TOKENS_METRIC_CARD_LABEL });
          const toggledColumn = columnHeaderById(panel, TOGGLED_COLUMN_ID);
          const controlColumn = columnHeaderById(panel, CONTROL_COLUMN_ID);

          // The premise for every absence below: both are on screen at rest.
          await expect(summaryCard).toBeVisible({
            timeout: SEEDED_SESSIONS_V2_MOUNT_TIMEOUT_MS,
          });
          await expect(toggledColumn.first()).toBeVisible();
          await expect(controlColumn.first()).toBeVisible();

          await panel
            .getByRole("button", { exact: true, name: OPTIONS_BUTTON })
            .click();
          // The menu content is portalled to the document, not the nav panel, so
          // it is addressed page-wide; only one can be open at a time.
          const menu = page.getByRole("menu");
          await expect(
            menu.getByText(SUMMARY_CARDS_SECTION, { exact: true })
          ).toBeVisible();
          await expect(
            menu.getByText(COLUMNS_SECTION, { exact: true })
          ).toBeVisible();

          // `exact` throughout: the summary-card row "cost" and the column row
          // "Cost" both live in this menu, and Playwright's default name match is
          // a case-insensitive substring.
          await menu
            .getByRole("menuitem", {
              exact: true,
              name: TOTAL_TOKENS_METRIC_CARD_LABEL,
            })
            .click();
          await expect(summaryCard).toHaveCount(0);

          // The switch rows prevent the menu's own `onSelect` close, so the menu
          // is still open and the second flip needs no reopen.
          await menu
            .getByRole("menuitem", { exact: true, name: TOGGLED_COLUMN_LABEL })
            .click();
          await expect(toggledColumn).toHaveCount(0);
          // Addressed by column ID, never by accessible name: the id does not
          // depend on the header's naming, which before ISS-11837 folded in
          // the column-options button's name, so an absence assertion written
          // against the label could not fail (ISS-6065).
          // Paired with a column that must STILL be there, so the zero above is
          // the toggle rather than a grid that stopped rendering headers.
          await expect(controlColumn.first()).toBeVisible();

          await menu
            .getByRole("menuitem", { exact: true, name: RESET_VIEW_ITEM })
            .click();

          // Both halves come back — the columns AND the strip. A reset that
          // restored the columns and left the strip a card short would not be a
          // reset, which is why the two are asserted together.
          await expect(summaryCard).toBeVisible();
          await expect(toggledColumn.first()).toBeVisible();
        }
      );
    } finally {
      cleanupSeededSessionsDirs(dirs);
    }
  });
});
