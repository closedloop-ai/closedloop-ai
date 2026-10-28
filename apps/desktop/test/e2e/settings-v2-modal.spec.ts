/**
 * ISS-8370 M4/M6 (desktop) — Settings v2 mounted through the desktop root
 * selector and the workspace menu mounted in the sidebar header, driven through
 * the LAUNCHED app with the program key seeded on the harness assignment.
 *
 * Every E2E profile is signed out, so the menu walked here is the GUEST arm of
 * the desktop item set; the signed-in set (Settings · Diagnostics · Log out) is
 * pinned by `sidebar-workspace-experience.test.tsx`, which can fake an identity.
 * What only a booted Electron app can prove is the chain assignment file →
 * main → IPC → root resolver → shell, and that the flag OFF — re-seeded on the
 * same profile and reloaded — puts the legacy tabs back: the rollback
 * procedure is the flag flip, so that case is the rollback evidence.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop build`
 *   - Run via: CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  SETTINGS_PANEL_LABEL,
  SettingsPanelId,
} from "@repo/api/src/types/settings-panel.ts";
import {
  WORKSPACE_MENU_ENTRY_LABEL,
  WORKSPACE_MENU_TRIGGER_LABEL,
  WorkspaceMenuEntryId,
} from "@repo/api/src/types/workspace-menu.ts";
import {
  activeNavPanel,
  breadcrumbNav,
  launchDesktopApp,
} from "./helpers/desktop-app";

const STEP_BUDGET_MS = 30_000;
const SPEC_TIMEOUT_MS = 300_000;
const SIDEBAR_TOGGLE_LABELS = /^(Expand|Collapse) sidebar$/;
const SHELL_TEST_ID = "settings-shell";
const SETTINGS_HASH = "#/settings";
const DASHBOARD_HASH = "#/dashboard";
const DASHBOARD_NAV_ID = "dashboard";
const DASHBOARD_CRUMB = "Dashboard";
const HEADER_REGION = '[data-sidebar="header"]';
const FOOTER_REGION = '[data-sidebar="footer"]';

function shell(page: Page) {
  return page.getByTestId(SHELL_TEST_ID);
}

function menuTrigger(page: Page, region: string) {
  return page
    .locator(region)
    .getByRole("button", { name: WORKSPACE_MENU_TRIGGER_LABEL });
}

test.describe("settings v2 modal (desktop)", () => {
  test("the sidebar header carries the workspace menu with the desktop guest set, Settings opens the modal over Dashboard on Connected Devices, and Escape returns to Dashboard", async () => {
    test.setTimeout(SPEC_TIMEOUT_MS);

    const userDataDir = await seedOnboardedProfile("desktop-settings-v2-e2e-");
    try {
      const launched = await launchDesktopApp({
        keepUserDataDir: true,
        userDataDir,
      });
      try {
        const { page } = launched;
        await expectLanding(page);

        // Common placement (operator ruling 2026-09-03): the trigger sits in
        // the sidebar HEADER, and the legacy footer account menu is gone.
        const trigger = menuTrigger(page, HEADER_REGION);
        await expect(trigger).toBeVisible({ timeout: STEP_BUDGET_MS });
        await expect(menuTrigger(page, FOOTER_REGION)).toHaveCount(0);

        await trigger.click();
        const menu = page.getByRole("menu");
        await expect(menu).toBeVisible();
        // The DESKTOP guest set: the account door, Settings and Diagnostics
        // present; Members, the org-switching pair and the download entry
        // absent — not disabled.
        for (const entry of [
          WorkspaceMenuEntryId.CreateAccount,
          WorkspaceMenuEntryId.Settings,
          WorkspaceMenuEntryId.Diagnostics,
        ]) {
          await expect(
            menu.getByRole("menuitem", {
              exact: true,
              name: WORKSPACE_MENU_ENTRY_LABEL[entry],
            })
          ).toBeVisible();
        }
        for (const entry of [
          WorkspaceMenuEntryId.Members,
          WorkspaceMenuEntryId.SwitchWorkspace,
          WorkspaceMenuEntryId.CreateWorkspace,
          WorkspaceMenuEntryId.DownloadDesktop,
        ]) {
          await expect(
            menu.getByText(WORKSPACE_MENU_ENTRY_LABEL[entry])
          ).toHaveCount(0);
        }

        await menu
          .getByRole("menuitem", {
            exact: true,
            name: WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.Settings],
          })
          .click();

        await expect
          .poll(() => page.evaluate(() => window.location.hash), {
            timeout: STEP_BUDGET_MS,
          })
          .toBe(SETTINGS_HASH);
        await expect(shell(page)).toBeVisible({ timeout: STEP_BUDGET_MS });
        // D8: a plain visit lands on the first panel this host offers. The
        // harness is signed out, so the capability read behind the panel fails
        // and the shell reports exactly that (the CapabilityError state, never
        // a denial): the entry is listed non-navigable and the body names the
        // panel it could not check, which is still the landing D8 chose.
        const connectedDevices =
          SETTINGS_PANEL_LABEL[SettingsPanelId.ConnectedDevices];
        await expect(
          shell(page)
            .getByRole("navigation", { name: "Settings" })
            .getByText(connectedDevices, { exact: true })
        ).toBeVisible({ timeout: STEP_BUDGET_MS });
        await expect(
          shell(page).getByRole("heading", {
            level: 2,
            name: new RegExp(connectedDevices),
          })
        ).toBeVisible({ timeout: STEP_BUDGET_MS });
        // D6: the page underneath is still the committed nav view — mounted,
        // never a Settings page in the keep-alive map.
        await expect(activeNavPanel(page, DASHBOARD_NAV_ID)).toBeAttached();
        await expect(page.locator('[data-nav-panel="settings"]')).toHaveCount(
          0
        );

        await page.keyboard.press("Escape");

        await expect
          .poll(() => page.evaluate(() => window.location.hash), {
            timeout: STEP_BUDGET_MS,
          })
          .toBe(DASHBOARD_HASH);
        await expect(shell(page)).toHaveCount(0);
        await expect(activeNavPanel(page, DASHBOARD_NAV_ID)).toBeVisible();
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
    await expect(
      launched.page.getByRole("button", { name: SIDEBAR_TOGGLE_LABELS })
    ).toBeVisible({ timeout: STEP_BUDGET_MS });
    return userDataDir;
  } catch (error) {
    fs.rmSync(userDataDir, { force: true, recursive: true });
    throw error;
  } finally {
    await launched.cleanup();
  }
}

/** Desktop lands on Dashboard (`DEFAULT_NAV_ID`), whatever the experience. */
async function expectLanding(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.location.hash), {
      timeout: STEP_BUDGET_MS,
    })
    .toBe(DASHBOARD_HASH);
  await expect(
    breadcrumbNav(page).getByText(DASHBOARD_CRUMB, { exact: true })
  ).toBeVisible({ timeout: STEP_BUDGET_MS });
  await expect(activeNavPanel(page, DASHBOARD_NAV_ID)).toBeVisible({
    timeout: STEP_BUDGET_MS,
  });
}
