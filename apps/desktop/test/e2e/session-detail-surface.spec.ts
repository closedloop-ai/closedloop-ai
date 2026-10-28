/** Local SQLite detail projection: trace, activity, sync state and cache TTL split. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { gotoHash, launchDesktopApp } from "./helpers/desktop-app";
import {
  seedSessionActivitySegments,
  waitForActivitySegmentsSchema,
} from "./helpers/seed-activity-segments";
import {
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

const SESSION_ID = "iss-5593-desktop-detail-surface-session";
const SESSION_NAME = "ISS-5593 desktop detail surface";

/**
 * The seeded session's window, anchored to LAUNCH TIME rather than to a
 * calendar instant (codex, #4669).
 *
 * This seed is `status='completed'` — terminal — and the second launch runs
 * `sweepExpiredSessions` at boot (`apps/desktop/src/main/database/sqlite.ts`),
 * which DELETES terminal sessions whose `last_activity_at` predates a 90-day
 * retention window. A hardcoded instant therefore makes this spec a time bomb:
 * it passes until exactly 90 days after whatever date was typed here, then the
 * boot sweep purges the row before navigation and the required `desktop-e2e`
 * job starts reporting the not-found state instead of the detail surface. The
 * original literals (2026-05-21) had ten days left when this was written.
 *
 * Deriving the window from `Date.now()` keeps it a fixed 90 days from expiry on
 * every run. The shape is unchanged and is what the assertions below need: a
 * 20-minute session that ended an hour ago, split 15/5 between the two seeded
 * phases. Nothing in this file asserts a rendered date, so no assertion depends
 * on the anchor being any particular day.
 */
const SESSION_END_MS = Date.now() - 60 * 60_000;
const SESSION_START_MS = SESSION_END_MS - 20 * 60_000;
const IMPLEMENT_END_MS = SESSION_END_MS - 5 * 60_000;
const SESSION_START = new Date(SESSION_START_MS).toISOString();
const SESSION_END = new Date(SESSION_END_MS).toISOString();
const ESTIMATED_COST = 4.82;

// The `<h1>` renders `name ?? externalSessionId`; it is the only per-session
// mount barrier on this screen, because `gotoHash` only assigns the hash and
// returns without waiting for anything.
const SESSION_TITLE_SELECTOR = ".sd3-head h1";
const PROPERTIES_BUTTON_NAME = "Properties";
const PROPERTY_LABEL_SELECTOR = ".prd-props .prd-prop .prd-prop-label";
/**
 * What the trace header reads for this seed, pinned rather than merely
 * non-empty (whitlockk, #4669).
 *
 * `not.toBeEmpty()` could not fail here: `getTraceCountLabel`
 * (`agent-session-detail-view.tsx`) always returns "<n> events", so it renders
 * the string "0 events" on a session whose SQLite→UI transcript projection
 * dropped every row — the assertion stayed green through exactly the breakage
 * it looked like it was guarding.
 *
 * ONE, not two, and the difference is the point. The header counts `turnItems`,
 * and `buildToolsTurn` (`@repo/lib/sessions/agent-session-detail-projection`)
 * coalesces a run of CONSECUTIVE tool-like timeline events into a single tools
 * turn with no gap check — so the seed's two `PreToolUse` events, 20 minutes
 * apart with nothing between them, are one turn carrying two tool items. That
 * is why {@link TRACE_TURN_SUMMARY} is asserted alongside: it is where the two
 * seeded events are actually observable, and a projection that lost one would
 * leave this count at 1 while changing that summary.
 */
const TRACE_COUNT_LABEL = "1 event";
/**
 * The tools turn's own summary line (`summarizeToolRun`), asserted as a
 * containment check on the transcript region: the surrounding row also carries
 * a clock time and a duration, which are seed-relative and not what this pins.
 */
const TRACE_TURN_SUMMARY = "Ran 2 tools";
/**
 * ISS-5820: the cache-write TTL subdivision this session reports. Byte-identical
 * to the web twin's `CACHE_WRITE_TOKEN_USAGE` buckets so the two adapters are
 * asserted against the SAME split, and small enough that `toLocaleString` adds
 * no grouping separator — the rendered string is then locale-independent, which
 * a runner grouping with dots instead of commas would otherwise break.
 */
const CACHE_WRITE_TTL_SPLIT = { ephemeral1h: 150, ephemeral5m: 250 } as const;
const CACHE_WRITE_LABEL_RE = /^Cache Write$/;
const SYNC_LABEL_RE = /^Sync$/;
const CACHE_WRITE_VALUE = "250 (5m TTL) | 150 (1h TTL)";
const MOUNT_TIMEOUT_MS = 30_000;

test.describe("Session detail full surface, Electron adapter (ISS-5593)", () => {
  test("the local read projects trace, activity, sync and cache TTL evidence", async () => {
    test.setTimeout(240_000);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-iss5593-surface-claude-")
    );
    // Isolate CODEX_HOME: unset, the boot Codex collector reads the real
    // ~/.codex/sessions and would ingest a developer's rollouts alongside the
    // seed.
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-iss5593-surface-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-iss5593-surface-udd-")
    );

    try {
      // Launch 1 — create + migrate the SQLite schema, then close so the seed
      // writes with the app DOWN.
      const first = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });
      try {
        await waitForBranchesSchema(userDataDir);
        await waitForActivitySegmentsSchema(userDataDir);
      } finally {
        await first.cleanup();
      }

      await seedSessionsList(userDataDir, [
        {
          at: SESSION_START,
          // `activityEventAt` is the ONE lever that moves the PROJECTED
          // `lastActivityAt` — the desktop read derives it as
          // `max(started_at, max(events.created_at))`, so the `lastActivityAt`
          // column alone leaves the projection pinned to `at` (see the
          // `SessionListSeed` docstring). Seeding both keeps the session window
          // internally consistent instead of leaning on an `endedAt` fallback
          // to mask the gap, which would let the timeline assertions below pass
          // for the wrong reason. Mirrors `session-detail-duration-captions`.
          activityEventAt: SESSION_END,
          // ISS-5820: a session that DID report the cache-write TTL split, so
          // the now-ungated Cache Write row has a subdivision to render.
          cacheWriteTtlSplit: CACHE_WRITE_TTL_SPLIT,
          endedAt: SESSION_END,
          estimatedCost: ESTIMATED_COST,
          lastActivityAt: SESSION_END,
          name: SESSION_NAME,
          sessionId: SESSION_ID,
        },
      ]);
      // Two attributed phases plus an idle tail: enough for both the raw phase
      // strip and the derived breakdown to render real rows rather than their
      // "nothing attributed" fallbacks, and NOT idle-dominant, which would fold
      // the phase strip closed by default (FEA-4238).
      await seedSessionActivitySegments(userDataDir, SESSION_ID, [
        {
          confidence: 0.82,
          endMs: IMPLEMENT_END_MS,
          phase: "implement",
          startMs: SESSION_START_MS,
        },
        {
          confidence: 0.61,
          endMs: SESSION_END_MS,
          phase: "validate",
          startMs: IMPLEMENT_END_MS,
        },
      ]);

      const { page, pageErrors, cleanup } = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });

      try {
        await gotoHash(page, `/sessions/${SESSION_ID}`);
        await expect(visible(page, SESSION_TITLE_SELECTOR)).toHaveText(
          SESSION_NAME,
          { timeout: MOUNT_TIMEOUT_MS }
        );

        // Session Timeline, with real plotted buckets rather than the
        // "nothing to plot" branch.
        const bars = visible(page, "button.sd3-bar2");
        await expect(bars.first()).toBeVisible();

        // The trace header names the section and counts what it is showing.
        await expect(visible(page, ".sd3-tracehead .sd3-th-count")).toHaveText(
          TRACE_COUNT_LABEL
        );
        // …and the panel under that header rendered the turn the count is
        // counting. Both assertions are needed and neither subsumes the other:
        // the header alone can read a number while the transcript region is
        // empty, and the region alone says nothing about the header agreeing
        // with it (whitlockk, #4669).
        await expect(visible(page, ".sd3-trace")).toContainText(
          TRACE_TURN_SUMMARY
        );

        await page
          .getByRole("button", { name: PROPERTIES_BUTTON_NAME, exact: true })
          .locator("visible=true")
          .click();
        await expect(
          visible(page, PROPERTY_LABEL_SELECTOR).filter({
            hasText: SYNC_LABEL_RE,
          })
        ).toBeVisible();

        // Both nullable TTL columns must survive the SQLite-to-IPC projection.
        await expect(
          visible(page, PROPERTY_LABEL_SELECTOR)
            .filter({ hasText: CACHE_WRITE_LABEL_RE })
            .locator("xpath=..")
        ).toContainText(CACHE_WRITE_VALUE);

        expect(pageErrors).toEqual([]);
      } finally {
        await cleanup();
      }
    } finally {
      fs.rmSync(userDataDir, { force: true, recursive: true });
      fs.rmSync(claudeHome, { force: true, recursive: true });
      fs.rmSync(codexHome, { force: true, recursive: true });
    }
  });
});

/**
 * Scopes a selector to the on-screen instance. The renderer keeps prior views
 * mounted-but-hidden for instant back-navigation, so an unscoped locator can
 * resolve a stale copy of the same class from a screen the user left.
 */
function visible(page: Page, selector: string) {
  return page.locator(selector).locator("visible=true");
}
