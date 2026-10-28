/**
 * The legacy Settings subpath aliases (`/settings/account`, `/settings/security`,
 * `/settings/relay-gateway`, `/settings/cli-tools`), through the launched app.
 *
 * WHAT THIS ASSERTS. `normalizeRouteHref` rewrites each web-shaped subpath onto
 * the canonical `#/settings?…` — desktop has ONE Settings route and these paths
 * have no route-table entry of their own, so without that rewrite the
 * navigation is dropped entirely. Every case pins that the alias normalizes and
 * that Settings actually opens.
 *
 * WHY THE CASES DIFFER (ISS-10195, then ISS-10286). Retiring the
 * workspace-experience gate made Settings the v2 panel modal, which reads
 * `?panel=`, and the legacy `?tab=` has had no reader since. Three of the four
 * aliases now name the Labs → Desktop App panel, which owns their controls;
 * `/settings/account` does not, because the legacy Account tab was sign-in and
 * GitHub connection — account identity, owned by Profile on web — so it keeps
 * the unread `tab` spelling and claims NOTHING here about reaching a panel.
 * ISS-10246 deleted that tab; the alias and this case are unchanged by it.
 *
 * THE PANEL IS UNCONDITIONAL (operator ruling, 2026-09-17: "should be retired
 * enabled for everyone so we handle the default guest desktop offline case").
 * Its PostHog gate is retired, so this launch seeds no feature-flag assignment
 * at all — which is exactly the guest-offline state the ruling names — and the
 * last case asserts the panel mounts anyway. The closed-pole case that used to
 * sit beside it asserted the retired contract and went with it.
 *
 * THAT LAST CASE IS THE HALF `settings-v2/__tests__/desktop-settings-v2-root.test.tsx`
 * CANNOT BUY (whitlockk, #4032080284): it mocks `DesktopAppPanel`, so it proves the
 * id registers and never that the moved bodies render in the shipped shell.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import { expect, test } from "@playwright/test";
import {
  gotoHash,
  launchDesktopApp,
  SETTINGS_SHELL_TEST_ID,
} from "./helpers/desktop-app";

type SettingsSubpathCase = {
  hash: string;
  /** The query the alias normalizes to — the whole of what it still carries. */
  query: string;
};

const MOUNT_TIMEOUT_MS = 30_000;

/** The panel's own `SettingsPanelSection` heading. */
const DESKTOP_APP_HEADING = "Desktop App";

/**
 * A control the panel only has because the move happened: `SecurityTab`'s Auth
 * Mode row. Asserting the heading alone would pass on an empty mounted section.
 */
const DESKTOP_APP_LOCAL_CONTROL = "Auth Mode";

const CASES: SettingsSubpathCase[] = [
  { hash: "/settings/account", query: "tab=account" },
  { hash: "/settings/security", query: "panel=desktop-app" },
  { hash: "/settings/relay-gateway", query: "panel=desktop-app" },
  { hash: "/settings/cli-tools", query: "panel=desktop-app" },
];

test.describe("Settings subpath routes", () => {
  for (const { hash, query } of CASES) {
    test(`${hash} normalizes onto the canonical Settings route and opens Settings`, async () => {
      const launched = await launchDesktopApp();
      const { page, pageErrors, cleanup } = launched;
      try {
        await gotoHash(page, hash);

        await expect
          .poll(() => page.evaluate(() => window.location.hash))
          .toBe(`#/settings?${query}`);
        // Settings OPENED — the modal the shell presents, not a nav page. An
        // alias that normalized but landed nowhere would leave this absent.
        await expect(page.getByTestId(SETTINGS_SHELL_TEST_ID)).toBeVisible({
          timeout: MOUNT_TIMEOUT_MS,
        });
        expect(pageErrors).toEqual([]);
      } finally {
        await cleanup();
      }
    });
  }

  test("mounts Desktop App and its machine-local controls with no flag seeded", async () => {
    const { page, cleanup } = await launchDesktopApp();
    try {
      await gotoHash(page, "/settings/security");
      const shell = page.getByTestId(SETTINGS_SHELL_TEST_ID);
      await expect(shell).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });

      await expect(
        shell.getByRole("heading", { name: DESKTOP_APP_HEADING })
      ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
      await expect(shell.getByText(DESKTOP_APP_LOCAL_CONTROL)).toBeVisible({
        timeout: MOUNT_TIMEOUT_MS,
      });
    } finally {
      await cleanup();
    }
  });
});
