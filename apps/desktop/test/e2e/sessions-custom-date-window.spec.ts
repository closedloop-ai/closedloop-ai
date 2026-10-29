/**
 * E2E: the Sessions explicit from/to date window, driven through the real
 * Electron window (FEA-4201).
 *
 * The shared control is mounted by BOTH shells; the web twin is
 * `e2e/sessions-custom-date-window.spec.ts`. This is the desktop half, and it is
 * not redundant with it: the two shells reach the same URL through different
 * adapters — the web page reads an App Router snapshot and refetches over HTTP,
 * the renderer reads a hash-router snapshot and re-queries local SQLite over
 * IPC. A window that reaches the query on one says nothing about the other.
 *
 * The assertion is on the ROWS, not the URL. A URL assertion alone stays green
 * while the renderer ignores the params entirely, which is exactly the
 * drill-down failure the feature exists to prevent — so the corpus is seeded
 * with one session INSIDE the selected window and one OUTSIDE it, and the spec
 * requires the outside row to disappear and come back.
 *
 * The seeds and clicked cells are intentionally wall-clock-relative: both use
 * the PREVIOUS calendar month, and the calendar is paged back before selection.
 * They only agree because the app is launched on TZ=UTC — see LAUNCH_ENV below.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  clickDesktopDateRange,
  DesktopDateRangeLabel,
  gotoNav,
  launchDesktopApp,
  seedDesktopFeatureFlags,
} from "./helpers/desktop-app";
import { hashQuery } from "./helpers/hash-router-query";
import {
  capturePreviousMonthDays,
  type PreviousMonthDays,
} from "./helpers/previous-month-days";
import {
  type SessionListSeed,
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

const DESKTOP_VIEWPORT = { height: 900, width: 1400 };

/**
 * The desktop Labs key gating this pass. Spelled as a LITERAL rather than
 * imported from `../../src/shared/feature-flags-labs-detail`: that module's
 * extension-less `@repo/api/src/types/...` imports do not resolve under
 * Playwright's ESM loader, and a spec-level import failure aborts the WHOLE
 * desktop-e2e suite at load time.
 * Drift is caught first by the `test:node` pins in
 * `apps/desktop/test/feature-flags.test.ts`.
 */
const CUSTOM_DATE_WINDOW_FLAG_KEY = "sessions-custom-date-window";

const CUSTOM_TRIGGER_NAME = "Custom";
const APPLY_NAME = "Apply";
const PREVIOUS_MONTH_NAME = /Go to the Previous Month/;
const CLEAR_CONTROL_NAME = /^Clear custom date range/;
const APPLIED_TRIGGER_NAME = /^Custom date range: /;

const INSIDE_ROW_NAME = "Custom window inside session";
const OUTSIDE_ROW_NAME = "Custom window outside session";

// The window this spec selects, as days of the previous month. Both the seeds
// and the calendar clicks are placed from these, so the two cannot drift.
const WINDOW_FROM_DAY = 2;
const WINDOW_TO_DAY = 10;
const INSIDE_DAY = 5;
const OUTSIDE_DAY = 20;

test.describe("Sessions custom from/to date window (FEA-4201)", () => {
  test("filters the list to an explicit window and hands it back on clear", async () => {
    test.setTimeout(180_000);

    // One clock reading for the seeds, the clicked cells and the URL
    // expectations. This test spans two launches and a migration, so re-reading
    // it per value is what lets them disagree.
    const days = capturePreviousMonthDays();

    // Empty CLAUDE_HOME/CODEX_HOME so the boot collectors ingest nothing and the
    // only rows are the seeded ones.
    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-custom-window-claude-")
    );
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-custom-window-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-custom-window-udd-")
    );
    const seedGates = (dir: string) =>
      seedDesktopFeatureFlags(dir, { [CUSTOM_DATE_WINDOW_FLAG_KEY]: true });

    // TZ is load-bearing, not hygiene. The seeds, the clicked cells and the URL
    // assertions all come from one `capturePreviousMonthDays()` reading, whose
    // fields are UTC;
    // the control passes no `defaultMonth` when nothing is selected, so the
    // picker opens on the app's LOCAL month. Unpinned, the two disagree for the
    // hours when the local and UTC month differ — the first hours of a month
    // east of UTC, the last hours west of it — and the single back click then
    // shows the month BEFORE the seeded one, where the in-month cell this spec
    // clicks does not exist at all. Pinning the app to UTC makes both anchors
    // the same calendar by construction. Same lever as
    // iss6980-sidecar-rebuild.spec.ts, which passes TZ through this env.
    const LAUNCH_ENV = {
      CLAUDE_HOME: claudeHome,
      CODEX_HOME: codexHome,
      TZ: "UTC",
    };

    try {
      // Launch 1 — create + migrate the SQLite schema, then close so the seed
      // writes without cross-process WAL contention.
      const first = await launchDesktopApp({
        beforeLaunch: seedGates,
        env: LAUNCH_ENV,
        keepUserDataDir: true,
        userDataDir,
      });
      try {
        await waitForBranchesSchema(userDataDir);
      } finally {
        await first.cleanup();
      }

      await seedSessionsList(userDataDir, seededSessions(days));

      // Launch 2 — the real Sessions IPC source reads the seeded corpus at boot.
      const { page, cleanup } = await launchDesktopApp({
        beforeLaunch: seedGates,
        env: LAUNCH_ENV,
        keepUserDataDir: true,
        userDataDir,
      });

      try {
        await page.setViewportSize(DESKTOP_VIEWPORT);
        await gotoNav(page, "sessions");
        // Widen the preset so BOTH seeded rows are in range before the explicit
        // window narrows them.
        await clickDesktopDateRange(page, DesktopDateRangeLabel.AllTime);

        const insideRow = page.getByRole("link", { name: INSIDE_ROW_NAME });
        const outsideRow = page.getByRole("link", { name: OUTSIDE_ROW_NAME });

        // Not vacuous: both rows are on screen BEFORE the window is applied, so
        // the disappearance below is attributable to the window and not to a
        // corpus that never had the row.
        await expect(insideRow).toBeVisible({ timeout: 30_000 });
        await expect(outsideRow).toBeVisible();

        // The TZ pin is the precondition the day locator below rests on, so it
        // is asserted rather than trusted: dropping it fails HERE, on any
        // non-UTC runner, instead of as an unexplained locator timeout on the
        // two days a month when the local and UTC calendars disagree.
        await expect
          .poll(() => page.evaluate(() => new Date().getTimezoneOffset()))
          .toBe(0);

        await page
          .getByRole("button", { name: CUSTOM_TRIGGER_NAME })
          .locator("visible=true")
          .click();
        // One page back, so the days clicked below are the seeded month's.
        await page.getByRole("button", { name: PREVIOUS_MONTH_NAME }).click();
        const dayButton = (day: number) =>
          page.locator(
            `td[data-day="${days.isoDay(day)}"]:not([data-outside]) button`
          );
        await dayButton(WINDOW_FROM_DAY).click();
        await dayButton(WINDOW_TO_DAY).click();
        await page.getByRole("button", { name: APPLY_NAME }).click();

        // The window reached the URL...
        await expect
          .poll(() => hashQuery(page.url()).get("from"))
          .toBe(days.isoDay(WINDOW_FROM_DAY));
        expect(hashQuery(page.url()).get("to")).toBe(
          days.isoDay(WINDOW_TO_DAY)
        );

        // ...and the renderer re-queried on it. The outside row leaving is the
        // assertion a URL check cannot make.
        await expect(outsideRow).toBeHidden();
        await expect(insideRow).toBeVisible();

        // The active window is stated in WORDS on the trigger, so which control
        // decides the rows never depends on colour alone (WCAG 1.4.1).
        await expect(
          page.getByRole("button", { name: APPLIED_TRIGGER_NAME }).first()
        ).toBeVisible();

        await page
          .getByRole("button", { name: CLEAR_CONTROL_NAME })
          .first()
          .click();

        // Clearing hands the listing back to the preset: both bounds leave the
        // URL together, and the row the window excluded returns. A clear that
        // stripped only one bound would parse back to a half-window and leave
        // the listing silently narrowed.
        await expect.poll(() => hashQuery(page.url()).get("from")).toBeNull();
        expect(hashQuery(page.url()).get("to")).toBeNull();
        await expect(outsideRow).toBeVisible();
      } finally {
        await cleanup();
      }
    } finally {
      fs.rmSync(claudeHome, { force: true, recursive: true });
      fs.rmSync(codexHome, { force: true, recursive: true });
      fs.rmSync(userDataDir, { force: true, recursive: true });
    }
  });
});

function seededSessions(days: PreviousMonthDays): SessionListSeed[] {
  return [
    {
      at: `${days.isoDay(INSIDE_DAY)}T09:00:00.000Z`,
      lastActivityAt: `${days.isoDay(INSIDE_DAY)}T09:30:00.000Z`,
      name: INSIDE_ROW_NAME,
      sessionId: "custom-window-inside",
    },
    {
      at: `${days.isoDay(OUTSIDE_DAY)}T09:00:00.000Z`,
      lastActivityAt: `${days.isoDay(OUTSIDE_DAY)}T09:30:00.000Z`,
      name: OUTSIDE_ROW_NAME,
      sessionId: "custom-window-outside",
    },
  ];
}
