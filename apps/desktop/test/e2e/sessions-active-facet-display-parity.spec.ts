/**
 * @file sessions-active-facet-display-parity.spec.ts
 * @description ISS-10741 (Electron shell): a Local row that STORES `active` is
 * returned by the Status = Active facet whatever its badge says — driven
 * seed-to-render through the real SQLite store, the real main-process filter
 * (`matchesStatusFilter` plus the SQL `buildUsageStatusPredicate` behind the
 * counts), the real IPC, and the renderer's Sessions list.
 *
 * WHY A LAUNCHED-APP SPEC AND NOT ANOTHER UNIT TEST (whitlockk, PR #7677). The
 * change is renderer-VISIBLE — it decides which rows a user sees after picking a
 * facet — and every suite that covered it stops at a main-process return value.
 * The existing filter specs never select Active against a row badging Waiting or
 * Stale at all, so unwiring the facet from the widened predicate leaves all of
 * them green while the shipped list goes back to hiding those rows. Nothing here
 * calls the matcher: it seeds rows, clicks the facet, and reads the list.
 *
 * THE BADGE ASSERTIONS ARE LOAD-BEARING. Without them the corpus is three rows
 * that all display Active and the case degrades to "Active returns active rows",
 * which passes with either predicate. Each row's badge is asserted BEFORE the
 * facet is applied, so the claim is "a row the grid labels Waiting/Stale comes
 * back under Active".
 *
 * ENDED_ACTIVE_NAME (stores `active`, recorded end, no activity after it) is
 * kept as a counterfactual, the same treatment WAITING_NAME and STALE_NAME got
 * from ISS-10364 below: reintroducing either a badge-side derivation off
 * `endedAt` or a stored-`active`-plus-`endedAt` subtraction from the facet
 * reddens here.
 *
 * THE CONTROL ROW IS LOAD-BEARING TOO. Widening ACTIVE to gather everything is
 * the likelier way this goes wrong, and INACTIVE_NAME stores `inactive`: it must
 * be on screen at rest and gone once the facet is applied.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import type { SessionListSeed } from "./helpers/seed-branches-db";
import {
  cleanupSeededSessionsDirs,
  makeSeededSessionsDirs,
  withSeededSessionsList,
} from "./helpers/seeded-sessions-list";

/**
 * Distinct, NON-PREFIX names: an accessible-name match is a case-insensitive
 * substring by default, so a shared prefix makes two row locators ambiguous
 * under strict mode.
 */
const LIVE_NAME = "iss-10741 running session";
const WAITING_NAME = "iss-10741 awaiting input session";
const STALE_NAME = "iss-10741 long silent session";
const INACTIVE_NAME = "iss-10741 finished session";
const ENDED_ACTIVE_NAME = "iss-11239 ended stored-active session";

const FILTER_BUTTON = "Filter";
const STATUS_FACET = "Status";
/**
 * `SESSION_STATUS_LABELS`. `exact` everywhere the word is "Active", because it
 * is a substring of "Inactive" and a loose match resolves to both.
 */
const ACTIVE_OPTION = "Active";
/** The BADGE word, distinct from the facet OPTION above that happens to match. */
const ACTIVE_LABEL = "Active";
const WAITING_LABEL = "Waiting";
const INACTIVE_LABEL = "Inactive";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** Past `STALE_SESSION_DISPLAY_THRESHOLD_HOURS`, so the row badges Stale. */
const SILENT_MS = 48 * HOUR_MS;

/**
 * Instants are relative to the run clock, never literals: the display staleness
 * fold compares against the live `new Date()` in the renderer.
 *
 * `updatedAt` is RECENT on all three `active` rows. The boot stale sweep reaps
 * an `active` row whose `updated_at` predates `DEFAULT_STALE_SESSION_MINUTES` to
 * `inactive` before the renderer reads it, which would take STALE_NAME out of
 * the population under test without the facet ever running.
 */
function seededSessions(): SessionListSeed[] {
  const now = Date.now();
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  return [
    {
      // Badges Active: recent anchor, nothing awaiting, no recorded end.
      at: iso(HOUR_MS),
      endedAt: null,
      lastActivityAt: iso(HOUR_MS),
      name: LIVE_NAME,
      sessionId: "iss-10741-running",
      status: "active",
      updatedAt: iso(MINUTE_MS),
    },
    {
      // SUBJECT 1. `awaiting_input_since` on a non-terminal row with no end is
      // the desktop's only encoding of "blocked on the user", so it badges
      // Waiting while still storing `active`.
      at: iso(HOUR_MS),
      awaitingInputSince: iso(30 * MINUTE_MS),
      endedAt: null,
      lastActivityAt: iso(HOUR_MS),
      name: WAITING_NAME,
      sessionId: "iss-10741-awaiting",
      status: "active",
      updatedAt: iso(MINUTE_MS),
    },
    {
      // SUBJECT 2. `at` moves with `lastActivityAt` because the projected anchor
      // is `max(started_at, max(events.created_at))` and the seed's single event
      // lands at `at` — the column alone would leave the badge reading Active.
      at: iso(SILENT_MS),
      endedAt: null,
      lastActivityAt: iso(SILENT_MS),
      name: STALE_NAME,
      sessionId: "iss-10741-silent",
      status: "active",
      updatedAt: iso(MINUTE_MS),
    },
    {
      // SUBJECT 3. Stored `active`, a recorded end, and its only event at `at`,
      // before that end — nothing happened after the run stopped.
      // `updatedAt` is recent for the same stale-sweep reason as the rows above.
      at: iso(3 * HOUR_MS),
      endedAt: iso(2 * HOUR_MS),
      lastActivityAt: iso(2 * HOUR_MS),
      name: ENDED_ACTIVE_NAME,
      sessionId: "iss-11239-ended-active",
      status: "active",
      updatedAt: iso(MINUTE_MS),
    },
    {
      // CONTROL: stores a terminal status, so Active must drop it.
      at: iso(2 * HOUR_MS),
      lastActivityAt: iso(2 * HOUR_MS),
      name: INACTIVE_NAME,
      sessionId: "iss-10741-finished",
      status: "inactive",
      updatedAt: iso(2 * HOUR_MS),
    },
  ];
}

test.describe("Sessions Active facet over displayed status (ISS-10741)", () => {
  test("rows storing active come back under Active whatever they badge, and a stored-inactive row does not", async () => {
    test.setTimeout(180_000);

    const dirs = makeSeededSessionsDirs("desktop-active-facet-parity");
    try {
      await withSeededSessionsList(dirs, seededSessions(), async (page) => {
        // The premise for every assertion below: the whole corpus is on screen
        // before anything is filtered, so an absence after the facet is the
        // facet and not a list that never loaded.
        for (const name of [
          LIVE_NAME,
          WAITING_NAME,
          STALE_NAME,
          ENDED_ACTIVE_NAME,
          INACTIVE_NAME,
        ]) {
          await expect(sessionLink(page, name)).toBeVisible({
            timeout: 30_000,
          });
        }

        // What each subject DISPLAYS, pinned before the facet runs so the
        // filter assertions below are a statement about badges rather than
        // about indistinguishable rows.
        //
        // ISS-10364 (operator ruling, 2026-09-23/24) retired BOTH the staleness
        // fold and the Waiting projection: "Unparsable status are already
        // converted to Active on import. Don't distinguish between active and
        // stale", then "let's drop waiting as well". The renderer projection
        // (`resolveDisplayedSessionStatusWithWaiting`) this surface reads is
        // now a thin alias of the shared lifecycle resolver, so both subjects
        // badge plain Active, kept as counterfactuals rather than deleted: a
        // future regression restoring either fold reddens here.
        await expect(
          rowForSession(page, WAITING_NAME).getByText(ACTIVE_LABEL, {
            exact: true,
          })
        ).toBeVisible();
        await expect(
          rowForSession(page, WAITING_NAME).getByText(WAITING_LABEL, {
            exact: true,
          })
        ).toHaveCount(0);
        await expect(
          rowForSession(page, STALE_NAME).getByText(ACTIVE_LABEL, {
            exact: true,
          })
        ).toBeVisible();
        await expect(
          rowForSession(page, INACTIVE_NAME).getByText(INACTIVE_LABEL, {
            exact: true,
          })
        ).toBeVisible();
        await expect(
          rowForSession(page, ENDED_ACTIVE_NAME).getByText(ACTIVE_LABEL, {
            exact: true,
          })
        ).toBeVisible();

        await page
          .getByRole("button", { exact: true, name: FILTER_BUTTON })
          .click();
        await page.getByRole("menuitem", { name: STATUS_FACET }).click();
        await page
          .getByRole("menuitem", { exact: true, name: ACTIVE_OPTION })
          .click();
        // The facet rows `preventDefault` their own select so the menu stays
        // open; close it so it cannot answer a row query with its own controls.
        // One press, as `sessions-list-dbseed.spec.ts` does on this surface.
        await page.keyboard.press("Escape");

        // Before ISS-10741 the two subjects were subtracted here and — since
        // PR #7603 took the Waiting and Stale chips away — reachable from no
        // facet at all.
        for (const name of [
          LIVE_NAME,
          WAITING_NAME,
          STALE_NAME,
          ENDED_ACTIVE_NAME,
        ]) {
          await expect(sessionLink(page, name)).toBeVisible({
            timeout: 30_000,
          });
        }
        // The badge is unchanged by the facet run.
        await expect(
          rowForSession(page, ENDED_ACTIVE_NAME).getByText(ACTIVE_LABEL, {
            exact: true,
          })
        ).toBeVisible();
        await expect(sessionLink(page, INACTIVE_NAME)).toHaveCount(0);
      });
    } finally {
      cleanupSeededSessionsDirs(dirs);
    }
  });
});

/**
 * The row that owns a given session's name link. Scoping every badge assertion
 * to it is what stops a page-wide `getByText` from passing while the statuses
 * are swapped between rows (whitlockk, PR #4474).
 *
 * `visible=true` for the reason `sessions-list-surface.spec.ts` gives: the
 * narrow-surface card layout contributes a second copy of every row, so an
 * unfiltered match is two elements and strict mode refuses it.
 */
function rowForSession(page: Page, sessionName: string): Locator {
  return page
    .getByRole("row")
    .filter({ has: page.getByRole("link", { exact: true, name: sessionName }) })
    .locator("visible=true");
}

/** The one VISIBLE name link for a seeded row — see {@link rowForSession}. */
function sessionLink(page: Page, sessionName: string): Locator {
  return page
    .getByRole("link", { exact: true, name: sessionName })
    .locator("visible=true");
}
