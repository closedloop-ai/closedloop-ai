/**
 * Native pageData timing regression: a settled empty SQLite date window becomes
 * a held zero-row placeholder with a mounted, disabled pager.
 */

import { expect, type Page, test } from "@playwright/test";
import {
  clickDesktopDateRange,
  DesktopDateRangeLabel,
  gotoNav,
  launchDesktopApp,
  seedDesktopFeatureFlags,
} from "./helpers/desktop-app";
import {
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";
import {
  cleanupSeededSessionsDirs,
  makeSeededSessionsDirs,
  seededSessionsEnv,
} from "./helpers/seeded-sessions-list";
import {
  holdPageDataReads,
  readGateDispatchCount,
  resumePageDataReads,
} from "./helpers/sessions-page-data-gate";

const SEEDED_SESSION_NAME = "iss-9216 placeholder footer session";

/** `Pagination`'s wrapper (`@closedloop-ai/design-system/components/ui/pagination`). */
const PAGER_SELECTOR = '[aria-label="pagination"]';

/** `PaginationLink` for the page the pager is currently on. */
const CURRENT_PAGE_SELECTOR =
  '[data-slot="pagination-link"][aria-current="page"]';

const MOUNT_TIMEOUT_MS = 30_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Outside both windows this spec narrows to (7 and 30 days) and INSIDE the 90-day
 * one. The upper bound is load-bearing: the boot retention sweep deletes a
 * terminal session whose last activity predates 90 days, so an older seed would
 * make every beat empty for the wrong reason.
 */
const SEEDED_SESSION_AGE_DAYS = 45;

test("the desktop Sessions footer stays mounted and pinned over a zero-row placeholder page", async () => {
  test.setTimeout(300_000);

  const dirs = makeSeededSessionsDirs("desktop-placeholder-footer");
  const env = seededSessionsEnv(dirs);

  try {
    // Launch 1 — create + migrate the SQLite schema, then close. The app must be
    // DOWN to seed: a running app does not observe another process's writes.
    const first = await launchDesktopApp({
      env,
      keepUserDataDir: true,
      userDataDir: dirs.userDataDir,
    });
    try {
      await waitForBranchesSchema(dirs.userDataDir);
    } finally {
      await first.cleanup();
    }

    const seededAt = new Date(
      Date.now() - SEEDED_SESSION_AGE_DAYS * DAY_MS
    ).toISOString();
    await seedSessionsList(dirs.userDataDir, [
      {
        at: seededAt,
        lastActivityAt: seededAt,
        name: SEEDED_SESSION_NAME,
        sessionId: "iss-9216-placeholder-footer",
      },
    ]);
    seedDesktopFeatureFlags(dirs.userDataDir, {});

    // Launch 2 — the same store, with the pageData gate installed but INERT, so
    // the first two beats settle against real reads.
    const app = await launchDesktopApp({
      env,
      keepUserDataDir: true,
      sessionsPageDataGate: true,
      userDataDir: dirs.userDataDir,
    });
    try {
      await gotoNav(app.page, "sessions");
      const seededRow = app.page.getByRole("link", {
        name: SEEDED_SESSION_NAME,
        exact: true,
      });

      // Beat 1 — settled WITH rows. The footer is present, which is what makes
      // its absence in beat 2 a rule firing rather than a list that never
      // rendered.
      await clickDesktopDateRange(app.page, DesktopDateRangeLabel.AllTime);
      await expect(seededRow).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
      await expect(pager(app.page)).toBeVisible();

      // Beat 2 — settled with NO rows. The row leaving is what proves this read
      // came back rather than still being in flight over beat 1's rows.
      await clickDesktopDateRange(app.page, DesktopDateRangeLabel.Last7Days);
      await expect(seededRow).toHaveCount(0, { timeout: MOUNT_TIMEOUT_MS });
      await expect(pager(app.page)).toHaveCount(0);

      // Beat 3 — the Last 30 days read is held, so `keepPreviousData` serves
      // beat 2's EMPTY result: zero rows, placeholder in flight.
      const dispatchedBefore = await readGateDispatchCount(app.app);
      await holdPageDataReads(app.app);
      await clickDesktopDateRange(app.page, DesktopDateRangeLabel.Last30Days);
      await expect
        .poll(() => readGateDispatchCount(app.app), {
          timeout: MOUNT_TIMEOUT_MS,
        })
        .toBeGreaterThan(dispatchedBefore);

      // Still no rows — beat 3 is the zero-row case, not beat 1 replayed.
      await expect(seededRow).toHaveCount(0);
      await expect(pager(app.page)).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
      await expect(
        app.page.locator(CURRENT_PAGE_SELECTOR).locator("visible=true").first()
      ).toHaveAttribute("aria-disabled", "true");

      // Let the held read through so the stall detector never fires and the
      // teardown is not racing an in-flight IPC.
      await resumePageDataReads(app.app);

      expect(app.pageErrors).toEqual([]);
    } finally {
      await app.cleanup();
    }
  } finally {
    cleanupSeededSessionsDirs(dirs);
  }
});

/** The visible view's pager — keep-alive views stay mounted but hidden. */
function pager(page: Page) {
  return page.locator(PAGER_SELECTOR).locator("visible=true").first();
}
