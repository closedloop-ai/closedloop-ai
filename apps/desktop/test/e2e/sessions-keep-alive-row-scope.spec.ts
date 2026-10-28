/**
 * ISS-9817 — the deterministic form of a race that cost `desktop-e2e` 35-50% of
 * its runs.
 *
 * Sessions specs asserted their seeded rows with a page-global
 * `getByText(slug).first()`. Keep-alive (`App.tsx`) leaves every visited view
 * mounted in a `display:none` panel, Dashboard is the landing view and therefore
 * FIRST in DOM order, and its Recent Sessions grid links the very same sessions.
 * So `.first()` could resolve the Dashboard's parked copy — an element whose
 * every ancestor box is 0x0 — and `toBeVisible()` reported `hidden` for the full
 * budget while the real row sat on screen the whole time. Whether the parked copy
 * existed yet was a race with the local import landing, which is the entire
 * source of the intermittency; nothing about the Sessions grid's own layout was
 * ever involved.
 *
 * This case removes the race instead of waiting it out: it proves the Dashboard's
 * copy is on the page BEFORE navigating, so the duplicate is present by
 * construction and the page-global locator is wrong 100% of the time. It is the
 * standing proof that `activeNavPanel` scoping — not `.first()`, not `:visible`,
 * not a longer timeout — is what makes a Sessions row assertion mean the Sessions
 * row.
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
  gotoNavSettled,
  launchDesktopApp,
  widenToAllTime,
} from "./helpers/desktop-app";
import { type SeedSession, seedClaudeTranscripts } from "./helpers/seed";
import {
  SEEDED_SESSION_GATE_TIMEOUT_MS,
  waitForSeededSession,
} from "./helpers/seeded-session-readiness";

const SEEDED: SeedSession = {
  sessionId: "sessions-keep-alive-scope",
  slug: "sessions-keep-alive-scope",
};

const ROW_VISIBLE_TIMEOUT_MS = 25_000;
const NAV_SETTLE_TIMEOUT_MS = 15_000;

/**
 * Budget for the three closing assertions, stated explicitly because the
 * runner's 15s CI default is invisible at the call site and therefore invisible
 * to the sum below.
 *
 * Small because the waits above have made the two locators these assertions read
 * STABLE, which is a narrower claim than a settled page: the store gate proves
 * only that this session has landed, and `gotoNavSettled` proves only that the
 * shell committed the Sessions panel. Neither retires the Dashboard's own
 * polling, and work unrelated to these locators may still be in flight. What
 * they do pin is the two things being counted — the seeded row is rendered in
 * both the parked Dashboard panel and the committed Sessions panel, and no
 * further nav transition is pending — so the counts are not still moving. If
 * that turns out to be false the assertions fail loudly on the count rather than
 * passing vacuously.
 */
const SETTLED_ASSERTION_TIMEOUT_MS = 5000;

/**
 * Derived from the steps, not chosen — the same construction
 * `sessions-flow.spec.ts` uses, so adding a wait cannot silently leave the outer
 * bound under the sum of the inner ones: two nav settles, one store gate, two
 * row waits, three settled assertions, plus the launch/seed/teardown allowance
 * that carries no budget of its own.
 */
const UNBUDGETED_STEPS_ALLOWANCE_MS = 90_000;
const SPEC_TIMEOUT_MS =
  2 * NAV_SETTLE_TIMEOUT_MS +
  SEEDED_SESSION_GATE_TIMEOUT_MS +
  2 * ROW_VISIBLE_TIMEOUT_MS +
  3 * SETTLED_ASSERTION_TIMEOUT_MS +
  UNBUDGETED_STEPS_ALLOWANCE_MS;

const rowLinkSelector = `a[href="#/sessions/${SEEDED.sessionId}"]`;

test.describe("Sessions row locators and keep-alive", () => {
  test("a parked Dashboard copy cannot answer a Sessions row query", async () => {
    test.setTimeout(SPEC_TIMEOUT_MS);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-keepalive-claude-")
    );
    const harnessHomesRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-keepalive-homes-")
    );
    seedClaudeTranscripts(claudeHome, [SEEDED]);

    const { page, cleanup } = await launchDesktopApp({
      userDataPrefix: "desktop-keepalive-e2e-",
      env: {
        ...isolatedHarnessHomes(harnessHomesRoot),
        CLAUDE_HOME: claudeHome,
      },
    });

    try {
      // Waiting for the Dashboard's own copy of the row is what converts the CI
      // race into a certainty: from here the Dashboard panel holds a link to this
      // session no matter how the import raced.
      const dashboardPanel = await gotoNavSettled(
        page,
        "dashboard",
        NAV_SETTLE_TIMEOUT_MS
      );
      await widenToAllTime(page);
      await waitForSeededSession(page, SEEDED.sessionId);
      await expect(dashboardPanel.locator(rowLinkSelector).first()).toBeVisible(
        {
          timeout: ROW_VISIBLE_TIMEOUT_MS,
        }
      );

      // Keep-alive parks the Dashboard rather than unmounting it, so its link
      // stays in the document, ahead of the Sessions list.
      //
      // `gotoNavSettled` — not a bare `gotoNav` — because the shell commits the
      // body on a DEFERRED render: for the frames between the hash change and
      // that commit the Dashboard panel is still the active, VISIBLE one, so a
      // page-global assertion made in that window passes against the copy this
      // case exists to disqualify. Gating on the committed panel is what puts
      // every assertion below on the far side of the transition.
      const sessionsPanel = await gotoNavSettled(
        page,
        "sessions",
        NAV_SETTLE_TIMEOUT_MS
      );
      await expect(sessionsPanel.locator(rowLinkSelector).first()).toBeVisible({
        timeout: ROW_VISIBLE_TIMEOUT_MS,
      });

      // The scoped query resolves exactly ONE row link — the visible one. This
      // is the positive half of the negative assertion below: the same selector,
      // same page, opposite state, decided only by the scope.
      await expect(sessionsPanel.locator(rowLinkSelector)).toHaveCount(1, {
        timeout: SETTLED_ASSERTION_TIMEOUT_MS,
      });

      // The page-global query resolves TWO, and its `.first()` is the parked
      // Dashboard copy. Asserting the count rather than only the visibility is
      // deliberate: it fails loudly if keep-alive ever stops parking the
      // Dashboard, instead of leaving the case below passing vacuously.
      await expect(page.locator(rowLinkSelector)).toHaveCount(2, {
        timeout: SETTLED_ASSERTION_TIMEOUT_MS,
      });
      await expect(page.locator(rowLinkSelector).first()).not.toBeVisible({
        timeout: SETTLED_ASSERTION_TIMEOUT_MS,
      });
    } finally {
      await cleanup();
      fs.rmSync(claudeHome, { recursive: true, force: true });
      fs.rmSync(harnessHomesRoot, { recursive: true, force: true });
    }
  });
});
