/**
 * E2E responsive smoke: dashboard, sessions, and branches stay inside the
 * narrow desktop viewport.
 *
 * Unit tests pin the class contracts, but FEA-2511 is a rendered layout issue.
 * This launches the built Electron app with a disposable profile, seeds the
 * local SQLite store, resizes to a small viewport, and asserts the real pages do
 * not create document-level horizontal overflow.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  dashboardOnboardedStorageKey,
  dashboardTourSeenStorageKey,
} from "../../src/renderer/components/dashboard/dashboard-storage-keys";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";
import {
  type SessionListSeed,
  seedMergedUnenrichedSinglePrBranch,
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

const NARROW_VIEWPORT = { height: 760, width: 390 };
const RESPONSIVE_BRANCH_SEED = {
  repoFullName: "closedloop-ai/responsive-desktop-check",
  branchName: "feature/fea-2511-small-resolution-responsive-branch",
  sessionId: "fea-2511-dashboard-branch-session",
  prNumber: 2511,
  mergedAt: "2026-07-14T12:00:00.000Z",
} as const;
const RESPONSIVE_SESSIONS: SessionListSeed[] = Array.from(
  { length: 30 },
  (_value, index) => ({
    sessionId: `fea-2511-session-${String(index + 1).padStart(2, "0")}`,
    name: `FEA-2511 narrow sessions ${String(index + 1).padStart(2, "0")}`,
  })
);

test.describe("Responsive desktop pages", () => {
  test("dashboard, sessions, and branches do not overflow at 390px", async () => {
    test.setTimeout(180_000);

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

      await seedMergedUnenrichedSinglePrBranch(
        userDataDir,
        RESPONSIVE_BRANCH_SEED
      );
      await seedSessionsList(userDataDir, RESPONSIVE_SESSIONS);

      const { page, pageErrors, cleanup } = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });

      try {
        await page.setViewportSize(NARROW_VIEWPORT);

        await gotoNav(page, "dashboard");
        await expect(
          page.getByRole("heading", {
            exact: true,
            level: 1,
            name: "Welcome to Closedloop",
          })
        ).toBeVisible({ timeout: 30_000 });
        await clickAllTimeIfPresent(page);
        await expectNoHorizontalOverflow(page, "dashboard");

        await gotoNav(page, "sessions");
        await clickAllTimeIfPresent(page);
        await expect(
          page.getByText("FEA-2511 narrow sessions 30").first()
        ).toBeVisible({ timeout: 30_000 });
        await expect(
          page.getByRole("navigation", { name: "pagination" })
        ).toBeVisible();
        await expectNoHorizontalOverflow(page, "sessions");

        await gotoNav(page, "branches");
        await clickAllTimeIfPresent(page);
        await expect(
          page.getByText(RESPONSIVE_BRANCH_SEED.branchName).first()
        ).toBeVisible({ timeout: 30_000 });
        await expectNoHorizontalOverflow(page, "branches");

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

async function clickAllTimeIfPresent(page: Page): Promise<void> {
  const allTime = page.locator('[aria-label="All time"]:visible').first();
  if ((await allTime.count()) > 0) {
    await allTime.click();
  }
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
