/**
 * ISS-5145 — pin the desktop E2E feature-flag SEEDING SEAM itself.
 *
 * Every Labs-gated desktop spec depends on one unproven claim: that
 * `seedDesktopFeatureFlags` (a read-merge-write into the launch profile's
 * `desktop-settings.json`) actually reaches the renderer's flag adapter, which
 * reads its values from `window.desktopApi.getAllFlags()` over IPC. Nothing in
 * the suite proved that end to end. The comparable spec asserted only a
 * NEGATIVE — an outcome that holds whether the flag is on or off — so the whole
 * class of Labs-gated desktop E2E coverage was vacuous by construction: if the
 * seam were broken, every one of those specs would still be green.
 *
 * This spec is the harness's own regression test, so it deliberately picks the
 * cheapest gated behavior in the app rather than an interesting one:
 * `docsHelp` (FEA-3843, registry default OFF) is the only input to whether the
 * Help entry appears in the Labs sidebar section (`useDesktopNavGates` puts
 * `NavId.Help` in `hiddenNavIds` when it is off). No database rows, no docs
 * bundle, no network — the nav entry is a pure function of the flag, so a
 * failure here can only mean the seeding seam broke.
 *
 * BOTH directions are asserted, and neither test can pass vacuously:
 *   - seeded ON  → the Help link IS present. This is the POSITIVE assertion the
 *     ticket asks for: it fails when the gate is off, which is precisely what
 *     a broken seed produces.
 *   - not seeded → the Help link is absent, AND a peer Labs link (Insights) is
 *     visible in the same DOM. That sibling assertion is what stops the
 *     negative from being vacuous: without it, a Labs section that failed to
 *     expand — or a renderer that crashed outright — would satisfy "no Help
 *     link" just as well as a correctly closed gate.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import { expect, type Page, test } from "@playwright/test";
import { DESKTOP_DOCS_HELP_FEATURE_FLAG_KEY } from "../../src/shared/desktop-docs-help-flag";
import {
  launchDesktopApp,
  seedDesktopFeatureFlags,
} from "./helpers/desktop-app";

/**
 * The Labs sidebar section ships collapsed (ISS-4478), so its destinations are
 * not in the DOM until it is expanded. Expanding it first is what lets the
 * absence of a link mean "the gate hid it" rather than "the section was shut".
 */
async function expandLabsSection(page: Page): Promise<void> {
  const labsToggle = page.getByRole("button", { name: "Labs" });
  await expect(labsToggle).toBeVisible({ timeout: 30_000 });
  await labsToggle.click();
  await expect(labsToggle).toHaveAttribute("aria-expanded", "true");
}

/**
 * A Labs destination that is NOT gated on `docsHelp`. Its visibility proves the
 * section expanded and the shell is healthy, so the Help assertions on either
 * side are measuring the flag and nothing else.
 */
function labsControlLink(page: Page) {
  return page.getByRole("link", { name: "Insights", exact: true });
}

function helpNavLink(page: Page) {
  return page.getByRole("link", { name: "Help", exact: true });
}

test.describe("desktop Labs feature-flag seeding contract", () => {
  test("a flag seeded ON by seedDesktopFeatureFlags reaches the renderer and opens its gate", async () => {
    const { page, cleanup } = await launchDesktopApp({
      userDataPrefix: "desktop-labs-flag-seed-on-e2e-",
      beforeLaunch: (userDataDir) => {
        seedDesktopFeatureFlags(userDataDir, {
          [DESKTOP_DOCS_HELP_FEATURE_FLAG_KEY]: true,
        });
      },
    });

    try {
      await expandLabsSection(page);
      await expect(labsControlLink(page)).toBeVisible({ timeout: 30_000 });

      // The assertion this whole spec exists for. It is POSITIVE: it can only
      // hold if the seeded value travelled settings file → SettingsStore →
      // `getAllFlags` IPC → DesktopFeatureFlagProvider → `useDesktopNavGates`.
      // With the seed inert (the ISS-5145 hypothesis) `docsHelp` falls back to
      // its registry default of `false` and this fails.
      await expect(helpNavLink(page)).toBeVisible({ timeout: 30_000 });
    } finally {
      await cleanup();
    }
  });

  test("the same flag left unseeded keeps its gate closed", async () => {
    const { page, cleanup } = await launchDesktopApp({
      userDataPrefix: "desktop-labs-flag-seed-off-e2e-",
    });

    try {
      await expandLabsSection(page);
      // Pins the negative below: an expanded Labs section really is rendering
      // its destinations, so a missing Help link is the gate and not an empty
      // or crashed sidebar.
      await expect(labsControlLink(page)).toBeVisible({ timeout: 30_000 });

      await expect(helpNavLink(page)).toHaveCount(0);
    } finally {
      await cleanup();
    }
  });
});
