/** Branch Detail shows the locally selected PR, with Checks Unavailable. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  gotoNav,
  launchDesktopApp,
  widenToAllTime,
} from "./helpers/desktop-app";
import {
  seedClosedAtOnlySinglePrBranch,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

test("shows the locally selected PR 7 with Checks Unavailable in Branch Detail", async () => {
  test.setTimeout(180_000);

  const localSeed = {
    repoFullName: "acme/iss-6975-local-pr",
    branchName: "feature/local-7",
    sessionId: "iss-6975-local-pr-session",
    prNumber: 7,
    closedAt: "2026-08-11T12:00:00.000Z",
  } as const;
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-iss-6975-local-pr-claude-")
  );
  const codexHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-iss-6975-local-pr-codex-")
  );
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-iss-6975-local-pr-udd-")
  );
  const env = {
    CLAUDE_HOME: claudeHome,
    CODEX_HOME: codexHome,
  };

  try {
    const firstLaunch = await launchDesktopApp({
      env,
      keepUserDataDir: true,
      revealWindow: false,
      userDataDir,
    });
    try {
      await waitForBranchesSchema(userDataDir);
    } finally {
      await firstLaunch.cleanup();
    }
    await seedClosedAtOnlySinglePrBranch(userDataDir, localSeed);

    const { page, pageErrors, cleanup } = await launchDesktopApp({
      env,
      keepUserDataDir: true,
      revealWindow: false,
      userDataDir,
    });
    try {
      await gotoNav(page, "branches");
      await widenToAllTime(page);
      const branchLink = page
        .locator('a[href^="#/branches/"]')
        .filter({ hasText: localSeed.branchName });
      await expect(branchLink).toBeVisible({ timeout: 30_000 });
      await branchLink.click();
      await expect(
        page.getByRole("tab", { name: "Branch details" })
      ).toBeVisible({ timeout: 30_000 });

      const selector = page.getByRole("combobox", { name: "Pull request" });
      await expect(selector).toContainText("#7");
      const selectedPullRequest = page.locator(".bq-ctx-pr");
      await expect(
        selectedPullRequest.getByText("#7", { exact: true })
      ).toBeVisible({ timeout: 30_000 });
      const checks = page.locator("section.mt-2").filter({
        hasText: "Checks & review",
      });
      await expect(
        checks.getByText("Unavailable", { exact: true })
      ).toBeVisible();
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
