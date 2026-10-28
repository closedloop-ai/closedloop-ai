/** Native flag assignment reaches Connected Devices; persisted Redacted remains selectable. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { SettingsPanelId } from "@repo/api/src/types/settings-panel.ts";
import { SHOW_REDACTED_SYNC_LEVEL_FLAG_KEY } from "@repo/api/src/types/show-redacted-sync-level-flag.ts";
import { launchAuthenticatedDesktopApp } from "./helpers/authenticated-desktop-app";
import {
  AUTHENTICATED_GATEWAY_ID,
  createAuthenticatedDesktopSessionRecord,
  startAuthenticatedBranchCloudServer,
} from "./helpers/branch-details-authenticated-cloud";
import {
  drainedCloudReadReadiness,
  openSettingsPanel,
  seedDesktopFeatureFlags,
  seedDesktopSettings,
} from "./helpers/desktop-app";
import {
  routeConnectedDevicesRequest,
  SETTINGS_DEVICE_PANELS_FLAG_KEY,
} from "./helpers/settings-v2-connected-devices-cloud";

/**
 * DataSyncLevel wire values (`src/shared/contracts.ts`), as literals for the
 * same loader reason. Persisted so the settings migration takes its early return
 * on a non-null `dataSyncLevel` instead of re-deriving one from the standard
 * seed's `cloudConnectionEnabled: false`.
 */
const REDACTED_LEVEL = "redacted";

// Radio-card titles come from DATA_SYNC_LEVEL_COPY, and since ISS-6147 the
// shared picker labels each radio with that title, so the accessible name IS the
// title — not the whole card body.
const REDACTED_OPTION_RE = /Redacted sessions/i;
const FULL_TRANSCRIPTS_OPTION_RE = /Full transcripts/i;
/** The sync section's handle inside the Connected Devices panel body. */
const SYNC_SECTION_SELECTOR = "[data-this-device-sync-policy]";

const MOUNT_TIMEOUT_MS = 30_000;
const E2E_BUDGET_MS = 180_000;

test.describe("Settings Data & Sync Redacted Labs gate (ISS-4779)", () => {
  test("enabled Desktop assignment offers Redacted from Metadata", async () => {
    test.setTimeout(E2E_BUDGET_MS);
    await withConnectedDevicesDesktop(
      "iss-4779-redacted-on",
      { dataSyncLevel: "metadata" },
      { [SHOW_REDACTED_SYNC_LEVEL_FLAG_KEY]: true },
      async ({ page, pageErrors }) => {
        const syncSection = await openSyncPolicySection(page);
        await expect(
          syncSection.getByRole("radio", { name: REDACTED_OPTION_RE })
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        expect(pageErrors).toEqual([]);
      }
    );
  });

  test("persisted Redacted level stays in the picker even with the flag off", async () => {
    test.setTimeout(E2E_BUDGET_MS);
    await withConnectedDevicesDesktop(
      "iss-4779-redacted-persisted",
      {
        // `getDataSyncLevel` RECONCILES the persisted level against the live
        // connectivity flags at read time (`reconcileDataSyncLevel`): a level
        // whose derived booleans disagree with the seeded flags is discarded and
        // re-derived away. Seed a COHERENT persisted-Redacted state — these
        // literals mirror `dataSyncLevelToBooleans(Redacted)` — so the read
        // returns `redacted` and the picker keeps the user's current selection.
        cloudCommandsPaused: false,
        cloudConnectionEnabled: true,
        dataSyncLevel: REDACTED_LEVEL,
        // The `SyncObservabilityTier` wire value (not a DataSyncLevel); it
        // happens to spell "metadata" too. Inlined for the same ESM-loader
        // reason as the level literals above.
        syncObservabilityTier: "metadata",
        transcriptSyncEnabled: false,
      },
      {},
      async ({ page, pageErrors }) => {
        const syncSection = await openSyncPolicySection(page);
        // A migrated/persisted Redacted selection read over getDataSyncLevel must
        // never be orphaned out of the picker, flag off or not.
        await expect(
          syncSection.getByRole("radio", { name: REDACTED_OPTION_RE })
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        expect(pageErrors).toEqual([]);
      }
    );
  });
});

/**
 * Launch the signed-in app against the Connected Devices cloud stand-in, run
 * `body`, and tear the whole fixture down. Two launches, as the authenticated
 * fixture requires: the first exists only to encrypt a session through Electron
 * `safeStorage`, the second is the one under test.
 */
async function withConnectedDevicesDesktop(
  label: string,
  syncSettings: Record<string, unknown>,
  flags: Record<string, boolean>,
  body: (fixture: { page: Page; pageErrors: Error[] }) => Promise<void>
): Promise<void> {
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-claude-`));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-codex-`));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-udd-`));
  const server = await startAuthenticatedBranchCloudServer({
    extraRoutes: routeConnectedDevicesRequest,
  });

  try {
    const { page, pageErrors, cleanup } = await launchAuthenticatedDesktopApp({
      sameProcessSessionSeed: createAuthenticatedDesktopSessionRecord(),
      beforeLaunch: (launchUserDataDir) => {
        seedDesktopSettings(launchUserDataDir, {
          ...cloudProfileSettings(label, server.origin),
          ...syncSettings,
        });
        seedDesktopFeatureFlags(launchUserDataDir, {
          ...flags,
          [SETTINGS_DEVICE_PANELS_FLAG_KEY]: true,
        });
      },
      cloudReadReadiness: drainedCloudReadReadiness(),
      env: {
        CLAUDE_HOME: claudeHome,
        CL_AUTH_API_ORIGIN: server.origin,
        CODEX_HOME: codexHome,
      },
      userDataDir,
    });

    try {
      await body({ page, pageErrors });
    } finally {
      await cleanup();
    }
  } finally {
    await server.close();
    fs.rmSync(userDataDir, { force: true, recursive: true });
    fs.rmSync(claudeHome, { force: true, recursive: true });
    fs.rmSync(codexHome, { force: true, recursive: true });
  }
}

function cloudProfileSettings(
  label: string,
  origin: string
): Record<string, unknown> {
  return {
    activeConfigId: `${label}-profile`,
    apiOrigin: origin,
    cloudConnectionEnabled: true,
    savedConfigs: [
      {
        apiOrigin: origin,
        gatewayId: AUTHENTICATED_GATEWAY_ID,
        id: `${label}-profile`,
        name: "ISS-4779 Cloud E2E",
        relayOrigin: "http://127.0.0.1:9",
        webAppOrigin: "http://127.0.0.1:3000",
      },
    ],
  };
}

/**
 * Open Settings v2 on Connected Devices and settle on this device's sync
 * section, returning it once a real option has rendered. Returning a settled
 * peer option is the mount proof: the section reads its level over
 * `getDataSyncLevel` IPC before it renders any radio, so asserting a peer
 * visible first keeps a Redacted presence/absence check from passing against a
 * still-loading skeleton.
 */
async function openSyncPolicySection(page: Page): Promise<Locator> {
  const shell = await openSettingsPanel(page, {
    panel: SettingsPanelId.ConnectedDevices,
    timeoutMs: MOUNT_TIMEOUT_MS,
  });
  const syncSection = shell.locator(SYNC_SECTION_SELECTOR);
  await expect(
    syncSection.getByRole("radio", { name: FULL_TRANSCRIPTS_OPTION_RE })
  ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
  return syncSection;
}
