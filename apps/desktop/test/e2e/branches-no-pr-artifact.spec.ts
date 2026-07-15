/**
 * E2E proof (FEA-2528): a Branches row can come from the real local branch
 * artifact path without any `pull_requests` row.
 *
 * The durable local branch identity is:
 * `sessions` -> `session_artifact_links` -> `artifacts(kind='branch')`.
 * This spec boots the real Electron app once to create/migrate the SQLite
 * store, seeds only those three rows while the app is closed, then relaunches
 * and asserts the Branches table lists the net-new branch with no PR chip.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";
import {
  seedNoPullRequestBranch,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

const SEED = {
  repoFullName: "acme/frontend",
  branchName: "fea-2528-no-pr-local-branch",
  sessionId: "branches-no-pr-e2e-session",
  activityAt: "2026-05-20T12:00:00.000Z",
} as const;

const PR_NUMBER_TEXT_RE = /#\d+/;

test.describe("Branches no-PR local artifact (FEA-2528)", () => {
  test("lists a linked branch artifact without a pull_request row", async () => {
    test.setTimeout(180_000);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-branches-no-pr-claude-")
    );
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-branches-no-pr-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-branches-no-pr-udd-")
    );

    try {
      // Launch 1: create + migrate the SQLite schema, then close before seed.
      const firstLaunch = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });
      try {
        await waitForBranchesSchema(userDataDir);
      } finally {
        await firstLaunch.cleanup();
      }

      await seedNoPullRequestBranch(userDataDir, SEED);

      // Launch 2: the real Branches IPC source reads the seeded local corpus.
      const { page, pageErrors, cleanup } = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });

      try {
        await gotoNav(page, "branches");
        await expect(
          page.locator("header").getByText("Branches", { exact: true })
        ).toBeVisible({ timeout: 30_000 });
        await expect(page.getByText("AI spend", { exact: true })).toBeVisible({
          timeout: 30_000,
        });

        // The seeded activity is fixed in the past for deterministic fixtures.
        // Widen the list window so the assertion is independent of run date.
        await page.locator('[aria-label="All time"]:visible').click();

        const branchLink = page
          .locator('a[href^="#/branches/"]')
          .filter({ hasText: SEED.branchName });
        const branchRow = page.locator("div.grid.h-11").filter({
          has: branchLink,
        });

        await expect(branchRow).toBeVisible({ timeout: 30_000 });
        await expect(
          branchRow.getByText("frontend", { exact: true })
        ).toBeVisible();
        await expect(
          branchRow.getByText("Draft", { exact: true })
        ).toBeVisible();

        // A no-PR branch should render the PR cell as missing data, not as a PR
        // chip or external PR link accidentally synthesized from another table.
        await expect(branchRow.getByText(PR_NUMBER_TEXT_RE)).toHaveCount(0);
        await expect(branchRow.locator('a[href*="/pull/"]')).toHaveCount(0);

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
