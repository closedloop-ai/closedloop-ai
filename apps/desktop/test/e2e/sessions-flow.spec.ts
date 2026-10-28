/**
 * E2E deep flow: Sessions — the primary user surface.
 *
 * Seeds real Claude transcripts into a temp CLAUDE_HOME, lets the app's
 * historical importer ingest them across the utility-process boundary, then
 * exercises the list → detail → back navigation the way a user would:
 *   1. the seeded sessions appear in the Sessions list,
 *   2. clicking a row opens the session detail (shared detail view), and
 *   3. the Topbar breadcrumb's "Sessions" parent link returns to the list.
 *
 * Was quarantined (ISS-5717) since the FEA-1791 store rewrite. A re-measurement
 * on 2026-08-22, after the ISS-7654 teardown fix removed the harness crash the
 * old header blamed, still lost 3 of 24 executions: each timed out at 25s
 * waiting for the FIRST seeded row. That failure could not distinguish a slow
 * cross-process import from a read-your-writes visibility gap from a list that
 * never rendered — one budget on one UI locator was standing in for all three.
 * This case is live because those causes are now separated rather than because
 * the flake was re-measured away: `waitForSeededSession` gates on the store
 * before the list is asserted at all, and every collector home is isolated so a
 * loaded box's real agent history is not part of what the import has to settle.
 *
 * Machine load is what those two runs disagreed on, and it is why the isolation
 * is load-bearing rather than hygiene: an earlier pre-fix run on 2026-08-21
 * (macOS, `--repeat-each=20` across this case and the historical-import one)
 * passed this body 20 of 20, its only failure being the teardown `TypeError`
 * ISS-7654 has since removed. Same body, same seeds, opposite verdicts — the
 * difference being how much foreign history the boot had to import first.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { isolatedHarnessHomes } from "../helpers/isolated-harness-homes";
import {
  activeNavPanel,
  breadcrumbParentLink,
  gotoNav,
  launchDesktopApp,
  widenToAllTime,
} from "./helpers/desktop-app";
import { type SeedSession, seedClaudeTranscripts } from "./helpers/seed";
import {
  SEEDED_SESSION_GATE_TIMEOUT_MS,
  waitForSeededSession,
} from "./helpers/seeded-session-readiness";

const SEEDED: SeedSession[] = [
  { sessionId: "sessions-e2e-alpha", slug: "sessions-e2e-alpha" },
  { sessionId: "sessions-e2e-bravo", slug: "sessions-e2e-bravo" },
  { sessionId: "sessions-e2e-charlie", slug: "sessions-e2e-charlie" },
];

const ROW_VISIBLE_TIMEOUT_MS = 25_000;
const NAV_TIMEOUT_MS = 15_000;

/**
 * The steps that carry no budget of their own: Electron launch, seeding, hash
 * navigation, the overlay dismissal, `widenToAllTime` (15s to become visible
 * plus 15s to settle) and teardown. The only term below that is an allowance
 * rather than a sum of stated budgets.
 */
const UNBUDGETED_STEPS_ALLOWANCE_MS = 90_000;

/**
 * Derived, not chosen. Every wait in this spec is sequential, so its worst case
 * is their SUM — 3×30s store gates + 3×25s row waits + 2×15s navigation = 195s
 * — and the flat 180_000 this replaces sat UNDER that: a slow-but-passing run
 * hit the outer timeout first and reported a generic "Test timeout exceeded" in
 * place of whichever per-step budget was actually losing, which is the specific
 * message those budgets exist to produce. Computing it from the same constants
 * the steps use keeps the outer bound above the sum by construction, so adding
 * a seeded session or widening a step cannot silently reintroduce the inversion.
 */
const SPEC_TIMEOUT_MS =
  SEEDED.length * SEEDED_SESSION_GATE_TIMEOUT_MS +
  SEEDED.length * ROW_VISIBLE_TIMEOUT_MS +
  2 * NAV_TIMEOUT_MS +
  UNBUDGETED_STEPS_ALLOWANCE_MS;

test.describe("Sessions flow", () => {
  test("seeded sessions list, open detail, and navigate back", async () => {
    test.setTimeout(SPEC_TIMEOUT_MS);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-sessions-claude-")
    );
    // ISS-7697: `launchDesktopApp` inherits `process.env`, so pinning only
    // CLAUDE_HOME leaves Cursor, Copilot and OpenCode resolving under
    // `os.homedir()` — this spec's Sessions population would then contain the
    // OPERATOR'S REAL local sessions alongside SEEDED, and the waits below would
    // be measured against a list nobody controls.
    //
    // EVERY other collector home is thrown away, not just Codex: a spec that
    // isolates one or two still imports the operator's real Cursor/Copilot
    // stores and their whole `opencode.db` — a batch source holding an unbounded
    // number of sessions. Those rows land in the population this case widens to
    // "All time" over, and the import they add is what the store gate below then
    // has to wait out.
    const harnessHomesRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-sessions-homes-")
    );
    seedClaudeTranscripts(claudeHome, SEEDED);

    const { page, pageErrors, cleanup } = await launchDesktopApp({
      userDataPrefix: "desktop-sessions-e2e-",
      env: {
        ...isolatedHarnessHomes(harnessHomesRoot),
        // …except Claude's, which IS the seeded corpus this spec reads.
        CLAUDE_HOME: claudeHome,
      },
    });

    try {
      await gotoNav(page, "sessions");
      // ISS-9817: every row query below is scoped to the COMMITTED Sessions
      // panel. Keep-alive leaves the Dashboard mounted and first in DOM order,
      // and its Recent Sessions grid links the same seeded sessions — so
      // `page.getByText(slug).first()` resolves the Dashboard's copy, which sits
      // in a `display:none` panel and is therefore permanently `hidden`. Whether
      // that duplicate exists at assertion time is a race with the import
      // landing, which is what made this spec lose ~35-50% of CI runs.
      const sessionsPanel = activeNavPanel(page, "sessions");
      // Seeds are timestamped a minute back, so they already fall inside the
      // default 7d window; widening to "All time" keeps the row set independent
      // of that window rather than being what puts the rows on screen. The
      // shared helper is the hardened form — it skips the click when the range
      // is already "All time", which is the race a bare click here reintroduces.
      await widenToAllTime(page);

      // Gate on the import having actually landed each session in the local
      // store. Previously this step was folded into the row locator's budget,
      // which made the spec race the utility-process importer and reported a
      // lost race as "the list never rendered the row".
      for (const session of SEEDED) {
        await waitForSeededSession(page, session.sessionId);
      }

      // The Sessions view is a full-width, table-led page: its title shows only
      // in the Topbar breadcrumb, with no in-body <h1>. Assert the seeded rows
      // themselves. The slug renders inside a larger row label (e.g.
      // "e2e-project (sessions-e2e-alpha)"), so match it as a substring.
      //
      // The budget stays generous, but it now measures only the list catching
      // up with a store the gate above proved already holds the session — the
      // list picks the row up on its own refetch cadence, which was measured
      // overrunning the 8s default. It is no longer standing in for the import.
      for (const session of SEEDED) {
        await expect(sessionsPanel.getByText(session.slug).first()).toBeVisible(
          {
            timeout: ROW_VISIBLE_TIMEOUT_MS,
          }
        );
      }

      // Open the first session's detail by clicking its row. The shared list
      // renders each row as a link to desktopSessionDetailHref; clicking
      // the slug text inside it triggers the hash navigation.
      await sessionsPanel.getByText(SEEDED[0].slug).first().click();

      // The breadcrumb's "Sessions" parent link is both the "detail mounted"
      // signal and the back affordance now that the in-page "Back to Sessions"
      // bar is gone.
      const backLink = breadcrumbParentLink(page, "Sessions");
      await expect(backLink).toBeVisible({ timeout: NAV_TIMEOUT_MS });

      // Clicking it returns to the list. Confirm we actually left the detail
      // view: the breadcrumb's "Sessions" link reverts to the current-page span
      // (so the link is gone), and the list rows are visible again.
      await backLink.click();
      await expect(backLink).toHaveCount(0, { timeout: NAV_TIMEOUT_MS });
      await expect(
        sessionsPanel.getByText(SEEDED[0].slug).first()
      ).toBeVisible();

      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
      fs.rmSync(claudeHome, { recursive: true, force: true });
      fs.rmSync(harnessHomesRoot, { recursive: true, force: true });
    }
  });
});
