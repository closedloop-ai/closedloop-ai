/**
 * E2E visual proof: the Desktop Dashboard gates GitHub-truth metrics when the
 * desktop GitHub data connection is disconnected.
 *
 * The regression this covers was mounted-surface-specific: the shared Insights
 * page had gating logic, but Desktop users see the Dashboard, whose local scope
 * previously forced GitHub-truth KPI tiles to Available. This test launches the
 * real built Electron app, seeds a real local session into the SQLite store so
 * the Dashboard renders rows instead of the empty state, then confirms the
 * visible Dashboard shows the shared Connect GitHub affordance.
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
  dashboardOnboardedStorageKey,
  dashboardTourSeenStorageKey,
} from "../../src/renderer/components/dashboard/dashboard-storage-keys";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";
import {
  seedMergedUnenrichedSinglePrBranch,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

const CONNECT_GITHUB_COPY = "Connect GitHub to light up this metric.";
const SEED = {
  repoFullName: "acme/web",
  branchName: "fea-2383-dashboard-gating-e2e",
  sessionId: "dashboard-github-gating-e2e-session",
  prNumber: 2383,
  mergedAt: "2026-07-07T12:00:00.000Z",
} as const;

test.describe("Dashboard GitHub metric gating", () => {
  test("renders the Connect GitHub affordance on the real Desktop Dashboard", async () => {
    test.setTimeout(180_000);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-dashboard-gating-claude-")
    );
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-dashboard-gating-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-dashboard-gating-udd-")
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

      await seedMergedUnenrichedSinglePrBranch(userDataDir, SEED);

      const { page, pageErrors, cleanup } = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });

      try {
        await gotoNav(page, "dashboard");

        await expect(
          page.getByRole("heading", {
            exact: true,
            level: 1,
            name: "Welcome to Closedloop",
          })
        ).toBeVisible({ timeout: 30_000 });
        await expect(page.getByText("No agent sessions yet")).toHaveCount(0);

        await expect(page.getByText(CONNECT_GITHUB_COPY)).toBeVisible({
          timeout: 45_000,
        });
        await expect(
          page.getByRole("button", { exact: true, name: "Connect GitHub" })
        ).toBeVisible();

        await page.screenshot({
          fullPage: true,
          path: test.info().outputPath("dashboard-github-gating.png"),
        });

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
