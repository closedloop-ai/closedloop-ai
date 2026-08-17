/**
 * ISS-5309 / ISS-5310 (wongk cid 3726730882) — the launched-app regression for
 * the Labs gates.
 *
 * The E2E helper seeds `labsNav` and `agentsNav` ON for every launched app, so
 * every other spec in this suite exercises the gates OPEN and none of them would
 * notice if the gates stopped closing. The desktop renderer rule requires a
 * launched-app regression for a UI fix, so this spec turns the gates off through
 * the same `desktop-settings.json` seam the product reads at boot and proves the
 * surfaces are actually withdrawn from the real app.
 *
 * `beforeLaunch` runs AFTER `seedE2eDesktopSettings`, so these values overwrite
 * the harness defaults rather than racing them.
 *
 * Every "it is gone" assertion is paired with something that must still be there
 * — the Account tab, the Sessions nav — so a renderer that crashed outright, or
 * a Settings panel that rendered no tabs at all, cannot satisfy an absence.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import { expect, type Page, test } from "@playwright/test";
import {
  gotoHash,
  gotoNav,
  launchDesktopApp,
  seedDesktopFeatureFlags,
} from "./helpers/desktop-app";

/**
 * The flag keys are literals here, not registry imports, for the load hazard
 * documented in `test/AGENTS.md`: `src/shared/feature-flags.ts` pulls in
 * `@repo/api/src/types/*` subpaths that resolve in the app but NOT under the
 * Playwright spec loader, so importing it aborts the entire suite at collection
 * time with `Cannot find module` and zero `✘` lines. `helpers/desktop-app.ts`
 * seeds these same two keys as literals for the same reason. They are
 * `DESKTOP_LABS_NAV_FEATURE_FLAG_KEY` and `DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY`
 * in that registry, and the renderer suites assert against the constants.
 */
const LABS_NAV_FLAG_KEY = "labsNav";
const AGENTS_NAV_FLAG_KEY = "agentsNav";

const LABS_TAB_NAME = "Labs";
const ACCOUNT_TAB_NAME = "Account";

async function openSettings(page: Page): Promise<void> {
  await gotoNav(page, "settings");
  await expect(page.locator("header").getByText("Settings")).toBeVisible({
    timeout: 30_000,
  });
  // The tab list is what this spec measures, so wait for a tab that is ALWAYS
  // present before asserting any absence.
  await expect(page.getByRole("tab", { name: ACCOUNT_TAB_NAME })).toBeVisible({
    timeout: 30_000,
  });
}

test.describe("desktop Labs gating withdraws its surfaces", () => {
  test("withdraws the Settings Labs tab when Labs is off", async () => {
    const { page, pageErrors, cleanup } = await launchDesktopApp({
      beforeLaunch: (userDataDir) => {
        seedDesktopFeatureFlags(userDataDir, {
          [LABS_NAV_FLAG_KEY]: false,
        });
      },
      userDataPrefix: "desktop-labs-off-e2e-",
    });

    try {
      await openSettings(page);

      // The tab is ABSENT, not merely disabled — trigger and content both, the
      // same way the sidebar drops the whole Labs section rather than greying it
      // out. The Labs tab is the only in-app UI for the per-item Labs flags, so
      // leaving it listing and toggling them would defeat the gate.
      await expect(page.getByRole("tab", { name: LABS_TAB_NAME })).toHaveCount(
        0
      );
      await expect(
        page.getByRole("tabpanel", { name: LABS_TAB_NAME })
      ).toHaveCount(0);
      // The sidebar section goes with it.
      await expect(
        page.getByRole("button", { name: LABS_TAB_NAME })
      ).toHaveCount(0);
      // …while the rest of Settings is untouched.
      await expect(
        page.getByRole("tab", { name: "Relay / Gateway" })
      ).toBeVisible();

      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("keeps the Settings Labs tab when Labs is on", async () => {
    // The mirror of the case above. Without it, a regression that dropped the
    // Labs tab entirely would satisfy every absence assertion there.
    const { page, pageErrors, cleanup } = await launchDesktopApp({
      userDataPrefix: "desktop-labs-on-e2e-",
    });

    try {
      await openSettings(page);

      await expect(
        page.getByRole("tab", { name: LABS_TAB_NAME })
      ).toBeVisible();

      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("withdraws #/agents and #/agents/:slug when the Agents gate is off", async () => {
    const { page, pageErrors, cleanup } = await launchDesktopApp({
      beforeLaunch: (userDataDir) => {
        // Labs stays ON so this measures the PER-ITEM gate specifically, and so
        // the "turned off" copy under test is the in-app Settings variant.
        seedDesktopFeatureFlags(userDataDir, {
          [AGENTS_NAV_FLAG_KEY]: false,
          [LABS_NAV_FLAG_KEY]: true,
        });
      },
      userDataPrefix: "desktop-agents-nav-off-e2e-",
    });

    try {
      // The list tier.
      await gotoHash(page, "/agents");
      await expect(page.getByText("Agents is turned off")).toBeVisible({
        timeout: 30_000,
      });

      // …and the DETAIL tier, which is the bug this covers: the detail override
      // bypassed the list's gate, so a saved `#/agents/<slug>` still mounted the
      // full agent screen out of a section that had been switched off.
      await gotoHash(page, "/agents/reviewer-bot");
      await expect(page.getByText("Agents is turned off")).toBeVisible({
        timeout: 30_000,
      });
      await expect(
        page.getByRole("link", { name: "Open settings" })
      ).toBeVisible();

      // The shell is healthy — this is a withdrawn destination, not a dead app.
      await expect(page.getByRole("link", { name: "Sessions" })).toBeVisible();

      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});
