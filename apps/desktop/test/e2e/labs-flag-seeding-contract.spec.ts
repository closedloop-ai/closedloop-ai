/**
 * ISS-5145 — pin the desktop E2E feature-flag SEEDING SEAM itself.
 *
 * Every Labs-gated desktop spec depends on one unproven claim: that
 * `seedDesktopFeatureFlags` actually reaches the renderer's flag adapter.
 * Nothing in the suite proved that end to end.
 *
 * ISS-8753 changed WHICH write satisfies that claim. `seedDesktopFeatureFlags`
 * writes two files, and only one of them still reaches a renderer gate: the
 * harness ASSIGNMENT. The `desktop-settings.json` merge no longer feeds the flag
 * adapter at all — that registry path is deleted — so a positive case that seeds
 * both cannot tell the surviving path from the retired one. Hence the two
 * positives below: one through the helper every flag-seeding spec calls, and
 * one through the ASSIGNMENT ALONE, which fails if the provider ever reads the
 * registry again. The comparable spec asserted only a NEGATIVE — an outcome that
 * holds whether the flag is on or off — so the whole class of Labs-gated desktop
 * E2E coverage was vacuous by construction: if the seam were broken, every one
 * of those specs would still be green.
 *
 * This spec is the harness's own regression test, so it deliberately picks the
 * cheapest gated behavior in the app rather than an interesting one. TWO flags
 * decide the Help entry and they NEST in `useDesktopNavGates`: `labsNav`
 * (ISS-5037) is the container — off, it hides every `NavSection.Labs` id,
 * `NavId.Help` among them — and `docsHelp` (FEA-3843, closed if unassigned) is
 * the per-item gate inside it, which hides `NavId.Help` alone. The link needs
 * BOTH on.
 *
 * The container is not a variable here: the standard profile seed
 * (`E2E_DESKTOP_FEATURE_FLAG_SEED`) opens `labsNav` on every
 * `launchDesktopApp`, ahead of any per-spec `beforeLaunch`, so `docsHelp` is
 * the only input these cases vary. No database rows, no docs bundle, no
 * network, so a failure here can only mean the seeding seam broke.
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
import { mergeE2eFeatureFlagAssignment } from "./helpers/e2e-feature-flag-assignment-seed";

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
      // hold if the seeded value travelled assignment file →
      // `readE2eFeatureFlagAssignment` → `getE2eSeededFeatureFlags` IPC →
      // DesktopFeatureFlagProvider → `useDesktopNavGates`. With the seed inert
      // (the ISS-5145 hypothesis) `docsHelp` resolves to its closed default and
      // this fails.
      await expect(helpNavLink(page)).toBeVisible({ timeout: 30_000 });
    } finally {
      await cleanup();
    }
  });

  /**
   * ISS-8753 — the same positive through the ASSIGNMENT ALONE, which is what
   * pins WHICH path opened the gate.
   *
   * The case above calls `seedDesktopFeatureFlags`, which writes `docsHelp` to
   * BOTH `desktop-settings.json` and the assignment. That proves the shared
   * helper still works, but it cannot fail if the provider regresses to the
   * retired registry path — either write would satisfy it.
   *
   * So this launch seeds `docsHelp` into the assignment file ONLY, deliberately
   * leaving it absent from `desktop-settings.json` (the standard profile seed
   * writes `agentsNav` / `labsNav` there and never `docsHelp`). The
   * gate can therefore only open from the assignment, and a provider that reads
   * the registry again reddens this case rather than riding the other write.
   */
  test("a flag seeded ON through the assignment ALONE opens its gate", async () => {
    const { page, cleanup } = await launchDesktopApp({
      userDataPrefix: "desktop-labs-flag-seed-assignment-e2e-",
      beforeLaunch: (userDataDir) => {
        mergeE2eFeatureFlagAssignment(userDataDir, {
          [DESKTOP_DOCS_HELP_FEATURE_FLAG_KEY]: true,
        });
      },
    });

    try {
      await expandLabsSection(page);
      // Insights is a Labs destination with no per-item flag, so it rides the
      // container gate the standard profile seed opens — through the assignment
      // here, not the registry. Its visibility is what keeps the Help assertion
      // below from being satisfied by an empty or crashed sidebar.
      await expect(labsControlLink(page)).toBeVisible({ timeout: 30_000 });

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
