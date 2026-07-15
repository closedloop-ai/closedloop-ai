/**
 * E2E proof (FEA-2939): the Branches "Pull request" chip is a working external
 * link to the branch's GitHub PR. The chip label is truncated at all widths and
 * had no test asserting where it points.
 *
 * For a merged single-PR branch the chip renders as an anchor to the canonical
 * GitHub PR URL (`<a href="https://github.com/<repo>/pull/<n>" target="_blank"
 * rel="noreferrer">`, see branch-pr-badge.tsx). In Electron a click on that
 * anchor is routed to `shell.openExternal` and returns `{action:"deny"}`, so it
 * opens the OS browser without changing the renderer — there is no in-page
 * navigation to assert. The robust, deterministic guard is therefore the
 * anchor's href/target/rel and its visible (truncated) label, which this spec
 * asserts against exactly what the seed inserts into `pull_requests`.
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
  seedMergedUnenrichedSinglePrBranch,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

const SEED = {
  repoFullName: "acme/web",
  branchName: "fea-2939-branch-pr-link",
  sessionId: "fea-2939-branch-pr-link-session",
  prNumber: 2941,
  mergedAt: "2026-05-18T12:00:00.000Z",
} as const;

// The seed inserts pr_url = https://github.com/<repo>/pull/<n>. The chip label
// is `<repoShort>#<n>` (repoShort = "web" for "acme/web").
const PR_URL = `https://github.com/${SEED.repoFullName}/pull/${SEED.prNumber}`;
const PR_CHIP_LABEL = `web#${SEED.prNumber}`;

test.describe("Branches PR link chip (FEA-2939)", () => {
  test("renders the PR chip as an external link to the GitHub PR", async () => {
    test.setTimeout(180_000);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-branch-pr-link-claude-")
    );
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-branch-pr-link-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-branch-pr-link-udd-")
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

      await seedMergedUnenrichedSinglePrBranch(userDataDir, SEED);

      // Launch 2: the real Branches source reads the seeded merged single-PR branch.
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

        await page.locator('[aria-label="All time"]:visible').click();

        const branchLink = page
          .locator('a[href^="#/branches/"]')
          .filter({ hasText: SEED.branchName });
        const branchRow = page.locator("div.grid.h-11").filter({
          has: branchLink,
        });
        await expect(branchRow).toBeVisible({ timeout: 30_000 });

        // The PR chip is an external anchor to the canonical GitHub PR URL.
        const prLink = branchRow.locator(`a[href="${PR_URL}"]`);
        await expect(prLink).toBeVisible({ timeout: 30_000 });
        await expect(prLink).toHaveAttribute("target", "_blank");
        await expect(prLink).toHaveAttribute("rel", "noreferrer");
        // The (truncated) chip label shows the repo-scoped PR number.
        await expect(prLink).toContainText(PR_CHIP_LABEL);

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
