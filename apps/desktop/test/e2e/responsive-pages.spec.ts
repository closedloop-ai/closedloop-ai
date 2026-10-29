/**
 * E2E responsive smoke: dashboard, sessions, and branches — both the LIST and
 * the DETAIL pages — stay inside the narrow desktop viewport.
 *
 * Unit tests pin the class contracts, but FEA-2511 is a rendered layout issue.
 * This launches the built Electron app with a disposable profile, seeds the
 * local SQLite store, resizes to a small viewport, and asserts the real pages do
 * not create document-level horizontal overflow.
 *
 * FEA-2511 specifically fixed the shared session/branch DETAIL properties and
 * comments rails at narrow widths, but the original spec only drove the
 * dashboard and the sessions/branches LIST pages — so a regression of the
 * `.sd3` narrow-stacking or a fixed-width element in the properties rail would
 * go uncaught on desktop. This also navigates into a seeded session detail and
 * branch detail at 390px and asserts no horizontal overflow there.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
// ISS-10314: the 390px band check and its floor, shared with the root `e2e/`
// specs rather than re-spelled here. That helper imports nothing but
// `@playwright/test`, so it crosses this runner's loader the same way
// `critical-wcag-aa` and `sessions-list-fixtures` already do for its siblings.
import {
  clickRowLinkInScrollBand,
  NARROW_VIEWPORT_390,
} from "../../../../e2e/helpers/list-surface-row-link";
// Explicit `.ts`: `@repo/app` publishes no `exports` map, so this Electron
// runner resolves the subpath straight through the node_modules symlink and
// needs the extension (as the sibling `@repo/api/src/types/*.ts` imports do).
import {
  dashboardOnboardedStorageKey,
  dashboardTourSeenStorageKey,
} from "../../src/renderer/components/dashboard/dashboard-storage-keys";
import { DASHBOARD_HEADING } from "./helpers/dashboard-header-copy";
import { expectFixtureInsideDefaultDateWindow } from "./helpers/date-window-fixture-guard";
import {
  activeNavPanel,
  breadcrumbParentLink,
  gotoNav,
  launchDesktopApp,
  widenToAllTime,
} from "./helpers/desktop-app";
import {
  type SessionListSeed,
  seedClosedAtOnlySinglePrBranch,
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The scroll band each surface publishes. Sessions takes
 * `GridTableListSurface`'s default; Branches overrides `tableScrollTestId` on
 * BOTH shells (`apps/app/.../branches/page.tsx`,
 * `apps/desktop/src/renderer/components/branches/branches-view.tsx`), so the
 * Sessions id does not match a Branches row and cannot be reused for it.
 *
 * Both are literals rather than imports, and the Sessions one deliberately does
 * not import `GRID_TABLE_SCROLL_BAND_TEST_ID` the way the root `e2e/` specs do:
 * its home is a component module, and pulling a React runtime through THIS spec
 * loader is the load-time abort `./helpers/seeded-sessions-v2-list.ts`
 * documents. That constraint binds the test IDs only — the check itself is
 * imported from the root helper above.
 */
const SESSIONS_SCROLL_BAND_TEST_ID = "grid-table-scroll-band";
const SESSIONS_NAV_ID = "sessions";
const BRANCHES_NAV_ID = "branches";
const BRANCHES_SCROLL_BAND_TEST_ID = "branches-scroll-container";

/**
 * ISS-8066: the seeded PR's `closed_at` instant, derived from the run clock.
 *
 * It was pinned to `2026-07-14T12:00:00.000Z`, and it is the field the Branches
 * window actually reads — `seedClosedAtOnlySinglePrBranch` writes it to
 * `pull_requests.closed_at`, and `projectDesktopBranchLastActive`
 * takes PR lifecycle instants as canonical Last-active evidence. So the branch
 * had a KNOWN out-of-window timestamp and only the "All time" widening below kept
 * it on screen — a widening that, until this change, was performed by a helper
 * that swallowed a failed click.
 *
 * A day back keeps it in the past on any clock and inside the default window.
 * Do NOT re-pin it to a newer literal; that re-arms the bomb on a later date.
 */
const RESPONSIVE_BRANCH_CLOSED_AT = new Date(Date.now() - DAY_MS).toISOString();
const RESPONSIVE_BRANCH_SEED = {
  repoFullName: "closedloop-ai/responsive-desktop-check",
  branchName: "feature/fea-2511-small-resolution-responsive-branch",
  sessionId: "fea-2511-dashboard-branch-session",
  prNumber: 2511,
  closedAt: RESPONSIVE_BRANCH_CLOSED_AT,
} as const;
const RESPONSIVE_SESSIONS: SessionListSeed[] = Array.from(
  { length: 30 },
  (_value, index) => ({
    sessionId: `fea-2511-session-${String(index + 1).padStart(2, "0")}`,
    name: `FEA-2511 narrow sessions ${String(index + 1).padStart(2, "0")}`,
  })
);

test.describe("Responsive desktop pages", () => {
  test("dashboard, sessions, and branches list + detail do not overflow at 390px", async () => {
    test.setTimeout(180_000);
    expectSeedInsideDefaultWindow();

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-responsive-claude-")
    );
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-responsive-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-responsive-udd-")
    );

    try {
      const first = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });
      try {
        await waitForBranchesSchema(userDataDir);
        await first.page.evaluate(
          ([onboardedKey, tourSeenKey]) => {
            localStorage.setItem(onboardedKey, "1");
            localStorage.setItem(tourSeenKey, "1");
          },
          [dashboardOnboardedStorageKey, dashboardTourSeenStorageKey]
        );
      } finally {
        await first.cleanup();
      }

      await seedClosedAtOnlySinglePrBranch(userDataDir, RESPONSIVE_BRANCH_SEED);
      await seedSessionsList(userDataDir, RESPONSIVE_SESSIONS);

      const { page, pageErrors, cleanup } = await launchDesktopApp({
        // ISS-5828 (from main): the branch detail this spec opens resolves its
        // repository defaults through the GitHub authority, so the launch points
        // at a fake local authority server rather than the network.
        env: {
          CLAUDE_HOME: claudeHome,
          CODEX_HOME: codexHome,
        },
        keepUserDataDir: true,
        userDataDir,
      });

      try {
        await page.setViewportSize(NARROW_VIEWPORT_390);

        await gotoNav(page, "dashboard");
        await expect(
          page.getByRole("heading", {
            exact: true,
            level: 1,
            name: DASHBOARD_HEADING,
          })
        ).toBeVisible({ timeout: 30_000 });
        await widenToAllTime(page);
        await expectNoHorizontalOverflow(page, "dashboard");

        await gotoNav(page, SESSIONS_NAV_ID);
        await expectNavViewMounted(page, "Sessions");
        await widenToAllTime(page);
        // ISS-9817: scoped to the COMMITTED panel, not `visible=true` + `.first()`.
        // Keep-alive leaves Dashboard mounted in a `display:none` panel and its
        // Recent Sessions grid links this same seeded session, so a page-global
        // `getByText` resolves two. `activeNavPanel` is this suite's standing
        // answer to that — see `sessions-keep-alive-row-scope.spec.ts`.
        await expect(
          activeNavPanel(page, SESSIONS_NAV_ID).getByText(
            "FEA-2511 narrow sessions 30"
          )
        ).toBeVisible({ timeout: 30_000 });
        await expect(
          page.getByRole("navigation", { name: "pagination" })
        ).toBeVisible();
        await expectNoHorizontalOverflow(page, "sessions");

        // Session DETAIL — FEA-2511 fixed the shared detail properties/comments
        // rails at narrow widths, verified only in Storybook. Drive the real
        // detail page on desktop so a regression is caught here.
        // Scoped to the COMMITTED Sessions panel, not to the page. Keep-alive
        // leaves Dashboard mounted-but-hidden and it renders a Recent Sessions
        // link for this same seeded session, so a page-wide locator resolves
        // two elements. `activeNavPanel` — not `.first()`, not `:visible` — is
        // this suite's answer to that, and it is what keeps the locator
        // singular for the shared helper's strict-mode contract.
        const sessionLink = activeNavPanel(page, SESSIONS_NAV_ID).getByRole(
          "link",
          { exact: true, name: "FEA-2511 narrow sessions 30" }
        );
        await clickRowLinkInScrollBand(
          sessionLink,
          SESSIONS_SCROLL_BAND_TEST_ID
        );
        await expect(
          page
            .locator("header")
            .getByRole("link", { name: "Sessions", exact: true })
        ).toBeVisible();
        await expectNoHorizontalOverflow(page, "session detail");

        await gotoNav(page, BRANCHES_NAV_ID);
        await expectNavViewMounted(page, "Branches");
        await widenToAllTime(page);
        await expect(
          activeNavPanel(page, BRANCHES_NAV_ID)
            .getByText(RESPONSIVE_BRANCH_SEED.branchName)
            .first()
        ).toBeVisible({ timeout: 30_000 });
        await expectNoHorizontalOverflow(page, "branches");

        // Branch DETAIL — the other half of the FEA-2511 shared-detail fix.
        // ISS-10314: reached by the same real pointer click as the session row,
        // NOT through `openDetailFromList`. That helper falls back to a
        // programmatic `element.click()` when the real one throws, which is
        // precisely what absorbs a starved scroll band — so the Branches half of
        // this spec could not witness the defect the Sessions half now pins.
        const branchLink = activeNavPanel(page, BRANCHES_NAV_ID)
          .locator('a[href^="#/branches/"]')
          .filter({ hasText: RESPONSIVE_BRANCH_SEED.branchName });
        await clickRowLinkInScrollBand(
          branchLink,
          BRANCHES_SCROLL_BAND_TEST_ID
        );
        await expect(breadcrumbParentLink(page, "Branches")).toBeVisible({
          timeout: 30_000,
        });
        await expectNoHorizontalOverflow(page, "branch detail");

        expect(pageErrors).toEqual([]);
      } finally {
        await cleanup();
      }
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
      fs.rmSync(claudeHome, { recursive: true, force: true });
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });
});

/**
 * `gotoNav` only assigns `window.location.hash` and returns -- it does NOT wait,
 * so the OUTGOING view is still mounted when it resolves. Synchronize on the
 * INCOMING route before driving any of its controls, otherwise a page-wide
 * locator can match (and click) the outgoing view's control, leaving the
 * incoming list unfiltered. The route title lives only in the Topbar
 * breadcrumb, so scope to <header> to avoid matching the sidebar nav button.
 * Mirrors branches-median-pr-size.spec.ts and branch-updatedat.spec.ts.
 */
async function expectNavViewMounted(page: Page, title: string): Promise<void> {
  await expect(
    page.locator("header").getByText(title, { exact: true })
  ).toBeVisible({ timeout: 30_000 });
}

/**
 * ISS-8066: the branch seed is inside the default window before anything widens
 * the range, so this file no longer leans on the widening for its rows to exist.
 *
 * The PR `closed_at` instant is checked because that is what reaches the Branches
 * window field: `projectDesktopBranchLastActive` folds PR lifecycle instants
 * into the canonical Last-active, and `filterBranchItemsByWindow` drops a row
 * whose value is KNOWN and out of window. The 30 seeded sessions carry no
 * explicit timestamps at all — `SessionListSeed` defaults `last_activity_at` to
 * now — so there is nothing there to age out and nothing to check.
 *
 * A precondition only. This spec's expectations are overflow geometry and scroll
 * behavior; none of them is derived from the window helper.
 */
function expectSeedInsideDefaultWindow(): void {
  expectFixtureInsideDefaultDateWindow(
    RESPONSIVE_BRANCH_CLOSED_AT,
    "Seeded branch PR closedAt"
  );
}

async function expectNoHorizontalOverflow(
  page: Page,
  pageName: string
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const maxScrollWidth = Math.max(
            document.documentElement.scrollWidth,
            document.body.scrollWidth
          );
          return maxScrollWidth - document.documentElement.clientWidth;
        }),
      { message: `${pageName} should not overflow horizontally` }
    )
    .toBeLessThanOrEqual(1);
}
