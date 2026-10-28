import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  breadcrumbNav,
  launchDesktopApp,
  seedDesktopFeatureFlags,
} from "./helpers/desktop-app";

const STEP_BUDGET_MS = 30_000;
const SHELL_ENTRY_TIMEOUT_MS = 240_000;
const SIDEBAR_TOGGLE_LABELS = /^(Expand|Collapse) sidebar$/;

/**
 * Empty-hash startup lands on Dashboard, whatever the workspace experience.
 *
 * Both launches below are kept deliberately: the v2 assignment used to be what
 * decided the landing (present -> Dashboard, absent -> Sessions), so running
 * the flag both ways is what proves it no longer moves the destination.
 */
test.describe("workspace-experience shell entry", () => {
  test("empty-hash startup routes to Dashboard without the v2 assignment", async () => {
    test.setTimeout(SHELL_ENTRY_TIMEOUT_MS);

    const userDataDir = await seedOnboardedProfile(
      "desktop-shell-entry-legacy-e2e-"
    );
    try {
      const launched = await launchDesktopApp({
        keepUserDataDir: true,
        userDataDir,
      });
      try {
        await expectShellEntry(launched.page, "#/dashboard", "Dashboard");
        expect(launched.pageErrors).toEqual([]);
      } finally {
        await launched.cleanup();
      }
    } finally {
      fs.rmSync(userDataDir, { force: true, recursive: true });
    }
  });

  test("empty-hash startup still routes to Dashboard with the v2 assignment", async () => {
    test.setTimeout(SHELL_ENTRY_TIMEOUT_MS);

    const userDataDir = await seedOnboardedProfile(
      "desktop-shell-entry-v2-e2e-"
    );
    try {
      const launched = await launchDesktopApp({
        beforeLaunch: (dir) => {
          seedDesktopFeatureFlags(dir, {});
        },
        keepUserDataDir: true,
        userDataDir,
      });
      try {
        await expectShellEntry(launched.page, "#/dashboard", "Dashboard");
        expect(launched.pageErrors).toEqual([]);
      } finally {
        await launched.cleanup();
      }
    } finally {
      fs.rmSync(userDataDir, { force: true, recursive: true });
    }
  });
});

async function seedOnboardedProfile(prefix: string): Promise<string> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const launched = await launchDesktopApp({
    keepUserDataDir: true,
    userDataDir,
  });
  try {
    await expectShellMounted(launched.page);
    return userDataDir;
  } catch (error) {
    fs.rmSync(userDataDir, { force: true, recursive: true });
    throw error;
  } finally {
    await launched.cleanup();
  }
}

async function expectShellEntry(
  page: Page,
  expectedHash: string,
  breadcrumb: string
): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.location.hash), {
      timeout: STEP_BUDGET_MS,
    })
    .toBe(expectedHash);
  await expect(
    breadcrumbNav(page).getByText(breadcrumb, { exact: true })
  ).toBeVisible({ timeout: STEP_BUDGET_MS });
}

async function expectShellMounted(page: Page): Promise<void> {
  await expect(
    page.getByRole("button", { name: SIDEBAR_TOGGLE_LABELS })
  ).toBeVisible({ timeout: STEP_BUDGET_MS });
}
