/**
 * ISS-11345 launched-app regression: a signed-out Dashboard card's GitHub ask
 * must not sign Desktop in as whoever the browser holds. The click asks main to
 * hold the returned account, the user is shown who it is, and only their answer
 * decides — Cancel leaves them a guest, with no failure banner (Perrin Upcott's
 * ruling, 2026-10-02).
 *
 * Main's own half (nothing adopted before a confirm, a revoke on cancel) is
 * pinned by `test/desktop-session-manager-sign-in-confirmation.test.ts`. This
 * spec covers what that cannot: the real built app, the real preload bridge,
 * the real `DesktopAuthProvider`, and the real mounted Dashboard card, with
 * main's sign-in channels stood in by
 * `helpers/sign-in-account-confirmation-gate-preload.cjs` so no browser opens.
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
import { DESKTOP_SIGN_IN_ACCOUNT_CONFIRM_COPY } from "../../src/renderer/shared-agent-sessions/desktop-sign-in-copy";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";
import {
  seedClosedAtOnlySinglePrBranch,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";
import { readSignInAccountConfirmationCounter } from "./helpers/sign-in-account-confirmation-gate";

/** Re-typed as a trip-wire, like `github-connect-leg-outcome.spec.ts`. */
const CONNECT_GITHUB_LABEL = "Connect to GitHub";
/** Mirrors the preload's `HELD_ACCOUNT`. */
const HELD_EMAIL = "someone-else@iss-11345.test";
const HELD_ORGANIZATION = "Their Org";

const MOUNT_TIMEOUT_MS = 45_000;

/**
 * The Dashboard banner for a sign-in that did not complete. Re-typed, not
 * imported, for the reason `github-connect-leg-outcome.spec.ts` gives; the
 * Confirm step's presence assertion keeps this Cancel absence check honest.
 */
const SIGN_IN_REQUIRED_BANNER = "GitHub sign-up was not completed. Try again.";

const SEED = {
  repoFullName: "acme/web",
  branchName: "iss-11345-account-confirmation",
  sessionId: "iss-11345-account-confirmation-session",
  prNumber: 11_345,
  closedAt: "2026-07-07T12:00:00.000Z",
} as const;

test.describe("Desktop sign-in account confirmation (ISS-11345)", () => {
  test("Cancel leaves the user a guest; Confirm is what reaches main", async () => {
    test.setTimeout(240_000);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-account-confirm-claude-")
    );
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-account-confirm-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-account-confirm-udd-")
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

      // A merged branch so the Dashboard renders its gated KPI cards.
      await seedClosedAtOnlySinglePrBranch(userDataDir, SEED);

      const { app, page, pageErrors, cleanup } = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        signInAccountConfirmationGate: true,
        userDataDir,
      });

      try {
        await gotoNav(page, "dashboard");
        const connect = page
          .getByRole("button", { exact: true, name: CONNECT_GITHUB_LABEL })
          .first();
        await expect(connect).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });

        // Cancel.
        await connect.click();
        const dialog = await expectHeldAccount(page);
        await recordBanner(page);
        await dialog
          .getByRole("button", {
            name: DESKTOP_SIGN_IN_ACCOUNT_CONFIRM_COPY.cancelLabel,
          })
          .click();
        await expect(page.getByRole("alertdialog")).toHaveCount(0);
        await expect(connect).toBeVisible();
        expect(await readSignInAccountConfirmationCounter(app, "cancels")).toBe(
          1
        );
        expect(
          await readSignInAccountConfirmationCounter(app, "confirms")
        ).toBe(0);

        // Confirm. The gate settles it as not signed in, a sign-in that did not
        // complete, so the banner a Cancel must not show appears here.
        await connect.click();
        const second = await expectHeldAccount(page);
        // This dialog is pushed after the Cancel's sign-in result, so the page
        // has handled that result by now.
        expect(await bannerRendered(page)).toBe(false);
        await second
          .getByRole("button", {
            name: DESKTOP_SIGN_IN_ACCOUNT_CONFIRM_COPY.confirmLabel,
          })
          .click();
        await expect(page.getByRole("alertdialog")).toHaveCount(0);
        expect(
          await readSignInAccountConfirmationCounter(app, "confirms")
        ).toBe(1);
        expect(await readSignInAccountConfirmationCounter(app, "cancels")).toBe(
          1
        );
        expect(
          await readSignInAccountConfirmationCounter(
            app,
            "confirmationsRequested"
          )
        ).toBe(2);
        await expect(page.getByText(SIGN_IN_REQUIRED_BANNER)).toBeVisible();
        expect(await bannerRendered(page)).toBe(true);

        expect(pageErrors).toEqual([]);
      } finally {
        await cleanup();
      }
    } finally {
      for (const dir of [claudeHome, codexHome, userDataDir]) {
        fs.rmSync(dir, { force: true, recursive: true });
      }
    }
  });
});

async function expectHeldAccount(page: Page) {
  const dialog = page.getByRole("alertdialog", {
    name: DESKTOP_SIGN_IN_ACCOUNT_CONFIRM_COPY.title,
  });
  await expect(dialog).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
  await expect(dialog).toContainText(HELD_EMAIL);
  await expect(dialog).toContainText(HELD_ORGANIZATION);
  return dialog;
}

/** Where the page records whether the banner has rendered since `recordBanner`. */
const BANNER_RECORD_KEY = "__clE2eSignInRequiredBannerRendered";

/**
 * Starts recording, in the page, whether the sign-in banner ever renders. A
 * Cancel's banner would be replaced as soon as the next click goes pending, so
 * an absence check at any single instant could miss it.
 */
async function recordBanner(page: Page): Promise<void> {
  await page.evaluate(
    ([key, text]) => {
      const record = { rendered: false };
      Reflect.set(globalThis, key, record);
      new MutationObserver(() => {
        record.rendered ||= document.body.textContent?.includes(text) ?? false;
      }).observe(document.body, {
        characterData: true,
        childList: true,
        subtree: true,
      });
    },
    [BANNER_RECORD_KEY, SIGN_IN_REQUIRED_BANNER] as const
  );
}

function bannerRendered(page: Page): Promise<boolean> {
  return page.evaluate(
    (key) => Reflect.get(globalThis, key)?.rendered === true,
    BANNER_RECORD_KEY
  );
}
