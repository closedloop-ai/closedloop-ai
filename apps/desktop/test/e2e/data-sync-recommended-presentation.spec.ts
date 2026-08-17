/**
 * ISS-5318 — launched-Electron regression for the Settings → Data & Sync level
 * presentation: one green "Recommended" pill on the most-permissive level, no
 * "Default"/"Elevated" chips, and the options rendered most-to-least exposure so
 * the recommended level leads.
 *
 * The renderer suite (`data-sync-tab.test.tsx`) injects `window.desktopApi`
 * directly, so it proves the component's chip and ordering logic but NOT that
 * the picker renders that way in the launched app, where the level arrives over
 * the real `getDataSyncLevel` IPC and the cards are laid out by the packaged
 * renderer. This spec closes that gap (the launched-app regression
 * `apps/desktop/AGENTS.md` requires for a UI change).
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import { expect, type Page, test } from "@playwright/test";
import {
  gotoNav,
  launchDesktopApp,
  seedDesktopSyncSettings,
} from "./helpers/desktop-app";

/**
 * DataSyncLevel wire value (`src/shared/contracts.ts`), spelled as a LITERAL
 * rather than imported: that module's extension-less `@repo/api/src/types/...`
 * specifiers do not resolve under Playwright's ESM loader, and a spec-level
 * import failure aborts the WHOLE desktop-e2e suite at load time (see the same
 * note in `data-sync-redacted-labs-gate.spec.ts`). Persisted so the settings
 * migration takes its early return on a non-null `dataSyncLevel` instead of
 * re-deriving one from the standard seed's `cloudConnectionEnabled: false`.
 */
const METADATA_LEVEL = "metadata";

// Radio-card titles come from DATA_SYNC_LEVEL_COPY. Regexes match against the
// radio's full accessible name (title + description + data lines).
const FULL_TRANSCRIPTS_OPTION_RE = /Full transcripts/i;
const LEVEL_GROUP_RE = /data & sync level/i;

const MOUNT_TIMEOUT_MS = 30_000;

test.describe("Settings Data & Sync level presentation (ISS-5318)", () => {
  test("the recommended level leads the picker and carries the only pill", async () => {
    test.setTimeout(120_000);
    const { page, cleanup, pageErrors } = await launchDesktopApp({
      userDataPrefix: "data-sync-presentation-e2e-",
      beforeLaunch: (userDataDir) => {
        seedDesktopSyncSettings(userDataDir, { dataSyncLevel: METADATA_LEVEL });
      },
    });
    try {
      await openDataSyncTab(page);
      await expect(page.getByText("Recommended", { exact: true })).toBeVisible({
        timeout: MOUNT_TIMEOUT_MS,
      });
      // The chips this presentation replaced. Asserting their absence is what
      // fails if the old badges survive a merge.
      await expect(page.getByText("Default", { exact: true })).toHaveCount(0);
      await expect(page.getByText("Elevated", { exact: true })).toHaveCount(0);
      // Most-to-least exposure: the recommended level leads. Order is the half a
      // presence check cannot see, since every option renders either way.
      await expect(
        page
          .getByRole("radiogroup", { name: LEVEL_GROUP_RE })
          .getByRole("radio")
          .first()
      ).toHaveAccessibleName(FULL_TRANSCRIPTS_OPTION_RE);
      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});

/**
 * Navigate to Settings, open the always-visible Data & Sync tab, and settle on a
 * rendered option. The tab reads its level over `getDataSyncLevel` IPC before it
 * renders any radio, so waiting for a real option first keeps a pill
 * presence/absence check from passing against a still-loading skeleton.
 */
async function openDataSyncTab(page: Page) {
  await gotoNav(page, "settings");
  await expect(page.locator("header").getByText("Settings")).toBeVisible({
    timeout: MOUNT_TIMEOUT_MS,
  });
  await page.getByRole("tab", { name: "Data & Sync" }).click();
  await expect(
    page.getByRole("radio", { name: FULL_TRANSCRIPTS_OPTION_RE })
  ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
}
