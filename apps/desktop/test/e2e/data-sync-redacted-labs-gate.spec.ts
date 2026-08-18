/**
 * ISS-4779 (closed-by-default) — launched-Electron regression for the
 * "Redacted sessions" Labs gate on Settings → Data & Sync.
 *
 * The renderer unit suite (`data-sync-tab.test.tsx`) injects both
 * `window.desktopApi` and the feature-flag adapter directly, so it proves the
 * component's filter logic but NOT that a PERSISTED Labs value actually reaches
 * the picker through the real path: settings file → SettingsStore →
 * `getAllFlags` IPC → `DesktopFeatureFlagProvider` → `useFeatureFlagEnabledOptional`
 * (the same seam `labs-flag-seeding-contract.spec.ts` pins), and the persisted
 * data-sync level through `getDataSyncLevel` IPC. This spec closes that gap by
 * launching the app and reading the actual rendered option set (the launched-app
 * regression `apps/desktop/AGENTS.md` requires for a UI-flag fix).
 *
 * Three cases, none vacuous:
 *   - default-off: the flag is unseeded and the level is a non-Redacted one, so
 *     the Redacted option is ABSENT — while a sibling option (Full transcripts)
 *     IS visible, which is what proves the tab mounted and the absence is the
 *     gate, not an empty/crashed panel.
 *   - flag seeded ON: the Redacted option IS visible. This is the POSITIVE proof
 *     that the persisted Labs value travels the real IPC/provider path to the
 *     picker; it fails if the seam is broken.
 *   - persisted Redacted level, flag OFF: the option is STILL visible, because a
 *     level the user is already on must never be orphaned out of the picker. It
 *     behaves like Metadata only (the redaction lane is not plumbed yet); that
 *     boolean equivalence is covered by the `dataSyncLevelToBooleans` unit tests,
 *     while this asserts the launched picker keeps the persisted selection.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import { expect, type Page, test } from "@playwright/test";
import {
  gotoNav,
  launchDesktopApp,
  seedDesktopFeatureFlags,
  seedDesktopSyncSettings,
} from "./helpers/desktop-app";

/**
 * The desktop Labs key gating the Redacted option. Spelled as a LITERAL rather
 * than imported from `../../src/shared/feature-flags`: that module's
 * extension-less `@repo/api/src/types/...` specifiers do not resolve under
 * Playwright's ESM loader, and a spec-level import failure aborts the WHOLE
 * desktop-e2e suite at load time (see the same note in
 * `agents-source-provenance.spec.ts`). The copy is pinned against
 * `DESKTOP_SHOW_REDACTED_SYNC_LEVEL_FEATURE_FLAG_KEY` by
 * `apps/desktop/test/feature-flags.test.ts`, so a rename fails there rather than
 * silently leaving this spec seeding a key nothing reads.
 */
const SHOW_REDACTED_FLAG_KEY = "showRedactedSyncLevel";

/**
 * DataSyncLevel wire values (`src/shared/contracts.ts`), as literals for the
 * same loader reason. Persisted so the settings migration takes its early return
 * on a non-null `dataSyncLevel` instead of re-deriving one from the standard
 * seed's `cloudConnectionEnabled: false`.
 */
const METADATA_LEVEL = "metadata";
const REDACTED_LEVEL = "redacted";

// Radio-card titles come from DATA_SYNC_LEVEL_COPY. Regexes match against the
// radio's full accessible name (title + description + data lines).
const REDACTED_OPTION_RE = /Redacted sessions/i;
const FULL_TRANSCRIPTS_OPTION_RE = /Full transcripts/i;

const MOUNT_TIMEOUT_MS = 30_000;

test.describe("Settings Data & Sync Redacted Labs gate (ISS-4779)", () => {
  test("default-off: the Redacted option is hidden while sibling levels render", async () => {
    test.setTimeout(120_000);
    const { page, cleanup, pageErrors } = await launchDesktopApp({
      userDataPrefix: "data-sync-redacted-off-e2e-",
      beforeLaunch: (userDataDir) => {
        seedDesktopSyncSettings(userDataDir, { dataSyncLevel: METADATA_LEVEL });
      },
    });
    try {
      const fullOption = await openDataSyncTab(page);
      // The gate is closed: Redacted is absent, but a peer option is present, so
      // the absence is the flag and not a panel that failed to render.
      await expect(fullOption).toBeVisible();
      await expect(
        page.getByRole("radio", { name: REDACTED_OPTION_RE })
      ).toHaveCount(0);
      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("flag seeded ON: the persisted Labs value reaches the picker and shows Redacted", async () => {
    test.setTimeout(120_000);
    const { page, cleanup, pageErrors } = await launchDesktopApp({
      userDataPrefix: "data-sync-redacted-on-e2e-",
      beforeLaunch: (userDataDir) => {
        seedDesktopSyncSettings(userDataDir, { dataSyncLevel: METADATA_LEVEL });
        seedDesktopFeatureFlags(userDataDir, {
          [SHOW_REDACTED_FLAG_KEY]: true,
        });
      },
    });
    try {
      const fullOption = await openDataSyncTab(page);
      await expect(fullOption).toBeVisible();
      // POSITIVE assertion: only a seeded flag that travelled the real IPC →
      // provider → picker path can make this option appear over a Metadata level.
      await expect(
        page.getByRole("radio", { name: REDACTED_OPTION_RE })
      ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("persisted Redacted level stays in the picker even with the flag off", async () => {
    test.setTimeout(120_000);
    const { page, cleanup, pageErrors } = await launchDesktopApp({
      userDataPrefix: "data-sync-redacted-persisted-e2e-",
      beforeLaunch: (userDataDir) => {
        // `getDataSyncLevel` RECONCILES the persisted level against the live
        // connectivity flags at read time (`reconcileDataSyncLevel`): a level
        // whose derived booleans disagree with the seeded flags is discarded and
        // re-derived away. The standard E2E seed writes `cloudConnectionEnabled:
        // false`, so persisting the level ALONE reconciles Redacted back to a
        // non-Redacted level and the option is (correctly) filtered out. Seed a
        // COHERENT persisted-Redacted state — these literals mirror
        // `dataSyncLevelToBooleans(Redacted)` — so the read returns `redacted`
        // and the picker keeps the user's current selection.
        seedDesktopSyncSettings(userDataDir, {
          dataSyncLevel: REDACTED_LEVEL,
          cloudConnectionEnabled: true,
          cloudCommandsPaused: false,
          transcriptSyncEnabled: false,
          // The `SyncObservabilityTier` wire value (not a DataSyncLevel); it
          // happens to spell "metadata" too. Inlined for the same ESM-loader
          // reason as the level literals above.
          syncObservabilityTier: "metadata",
        });
      },
    });
    try {
      const fullOption = await openDataSyncTab(page);
      await expect(fullOption).toBeVisible();
      // A migrated/persisted Redacted selection read over getDataSyncLevel must
      // never be orphaned out of the picker, flag off or not.
      await expect(
        page.getByRole("radio", { name: REDACTED_OPTION_RE })
      ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});

/**
 * Navigate to Settings, open the always-visible Data & Sync tab, and return the
 * Full-transcripts radio once it is present. Returning a settled peer option is
 * the mount proof: the tab reads its level over `getDataSyncLevel` IPC before it
 * renders any radio, so asserting a peer visible first keeps a Redacted
 * presence/absence check from passing against a still-loading skeleton.
 */
async function openDataSyncTab(page: Page) {
  await gotoNav(page, "settings");
  await expect(page.locator("header").getByText("Settings")).toBeVisible({
    timeout: MOUNT_TIMEOUT_MS,
  });
  await page.getByRole("tab", { name: "Data & Sync" }).click();
  const fullOption = page.getByRole("radio", {
    name: FULL_TRANSCRIPTS_OPTION_RE,
  });
  await expect(fullOption).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
  return fullOption;
}
