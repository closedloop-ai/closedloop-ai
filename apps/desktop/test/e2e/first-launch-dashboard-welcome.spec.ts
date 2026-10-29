/**
 * E2E regression (ISS-10855): a clean first launch opens on the Dashboard with
 * the guided-onboarding welcome modal over it, and a returning install opens on
 * the Dashboard with no modal at all.
 *
 * Would fail before the change: a clean profile's first screen was a
 * full-window landing that REPLACED the shell, so there was no `main`, no
 * `#/dashboard` route behind it, and no welcome dialog until the landing was
 * clicked through.
 *
 * The clean-profile case takes NO action before its first assertions — no
 * `gotoNav`, no click — because the subject is the first frame the app settles
 * on by itself.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop build`
 *   - Run via: CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e
 */

import { expect, type Page, test } from "@playwright/test";
import { DESKTOP_WELCOME_CTA_LABEL } from "@repo/app/onboarding/components/guided-onboarding-welcome-copy.ts";
import {
  DASHBOARD_FLAG_SET,
  dashboardOnboardedStorageKey,
} from "../../src/renderer/components/dashboard/dashboard-storage-keys";
import { activeNavPanel, launchDesktopApp } from "./helpers/desktop-app";

const WELCOME_HEADING = "Discover how you (and your team) build with AI.";
/** The step Start lands a Desktop run on. */
const SESSION_DISCOVERY_EYEBROW = "Session discovery";
const ACCOUNT_MENU_TRIGGER = "Open account menu";
/** What the sidebar footer reads for a signed-out device. */
const GUEST_ACCOUNT_LABEL = "Guest";
const DASHBOARD_NAV_ID = "dashboard";
const DASHBOARD_HASH = "#/dashboard";
const STEP_BUDGET_MS = 30_000;

test("ISS-10855: a clean first launch opens on the Dashboard with the welcome modal over it", async () => {
  test.setTimeout(180_000);

  const launched = await launchDesktopApp({
    keepFirstRunState: true,
    userDataPrefix: "desktop-iss10855-first-",
  });

  try {
    const { page } = launched;
    const welcome = page.getByRole("dialog", { name: WELCOME_HEADING });
    await expect(welcome).toBeVisible({ timeout: STEP_BUDGET_MS });
    await expect(
      welcome.getByRole("button", { name: DESKTOP_WELCOME_CTA_LABEL })
    ).toBeVisible();

    // The Dashboard is BEHIND the modal, not replaced by it. By element: the
    // open modal `aria-hidden`s the shell, so its landmark is out of the
    // accessibility tree while it is mounted and on screen.
    await expectHash(page, DASHBOARD_HASH);
    await expect(page.locator("main")).toBeAttached();
    await expect(activeNavPanel(page, DASHBOARD_NAV_ID)).toBeAttached();

    // The primary action moves the run off Welcome, onto local analysis.
    await welcome
      .getByRole("button", { name: DESKTOP_WELCOME_CTA_LABEL })
      .click();
    await expect(page.getByText(SESSION_DISCOVERY_EYEBROW)).toBeVisible({
      timeout: STEP_BUDGET_MS,
    });
    expect(launched.pageErrors).toEqual([]);
  } finally {
    await launched.cleanup();
  }
});

test("ISS-10855: a returning install opens on the Dashboard with no welcome modal", async () => {
  test.setTimeout(180_000);

  // What an install upgrading from an earlier build carries: the first-launch
  // latch set and no guest-run record. `keepFirstRunState` skips the
  // launcher's own seed, which writes a settled guest-run record and leaves the
  // latch unset, so it models a first run with a finished run instead.
  const launched = await launchDesktopApp({
    keepFirstRunState: true,
    userDataPrefix: "desktop-iss10855-returning-",
  });

  try {
    const { app, page } = launched;
    await page.evaluate(
      ([key, value]) => {
        localStorage.setItem(key, value);
      },
      [dashboardOnboardedStorageKey, DASHBOARD_FLAG_SET] as const
    );
    // The guided run reads the latch once, at mount, so the write takes effect
    // on the next document. Its `domcontentloaded`, not `framenavigated`, which
    // a same-document hash write can also emit.
    await Promise.all([
      page.waitForEvent("domcontentloaded", { timeout: STEP_BUDGET_MS }),
      app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.webContents.reload();
      }),
    ]);
    await expectHash(page, DASHBOARD_HASH);
    await expect(activeNavPanel(page, DASHBOARD_NAV_ID)).toBeVisible({
      timeout: STEP_BUDGET_MS,
    });
    // The positive anchor for the absence below: the device has settled as a
    // signed-out guest, which is the one state the guest run arms in. Hidden
    // elements included, so an auto-armed tour callout cannot hide either.
    await expect(
      page.getByRole("button", {
        includeHidden: true,
        name: ACCOUNT_MENU_TRIGGER,
      })
    ).toContainText(GUEST_ACCOUNT_LABEL, { timeout: STEP_BUDGET_MS });
    await expect(
      page.getByRole("dialog", { includeHidden: true, name: WELCOME_HEADING })
    ).toHaveCount(0);
    expect(launched.pageErrors).toEqual([]);
  } finally {
    await launched.cleanup();
  }
});

async function expectHash(page: Page, hash: string): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.location.hash), {
      timeout: STEP_BUDGET_MS,
    })
    .toBe(hash);
}
