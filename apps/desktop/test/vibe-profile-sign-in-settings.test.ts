import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { afterEach, describe, it } from "vitest";
import { VIBE_UNROUTABLE_RELAY_ORIGIN } from "../scripts/vibe-profile/launch-env";
import { VibeOriginKind } from "../scripts/vibe-profile/origin-policy";
import { vibeDesktopSettings } from "../scripts/vibe-profile/sign-in";
import { SettingsStore } from "../src/main/settings/settings-store.js";
import { E2E_DESKTOP_SETTINGS_SEED } from "./e2e/helpers/e2e-desktop-settings-seed";

const GATEWAY_ID = "00000000-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "0192f0a0-0000-7000-8000-0000000000a1";

describe("vibeDesktopSettings", () => {
  it("keeps the local-stack saved config for loopback origins", () => {
    const origins = {
      apiOrigin: "http://localhost:3002",
      webOrigin: "http://localhost:3000",
      originKind: VibeOriginKind.Loopback,
    };
    assert.deepEqual(
      vibeDesktopSettings(origins, GATEWAY_ID, ORGANIZATION_ID),
      {
        ...E2E_DESKTOP_SETTINGS_SEED,
        activeConfigId: "vibe-local-stack",
        apiOrigin: origins.apiOrigin,
        cloudCommandsPaused: true,
        cloudConnectionEnabled: false,
        dataSyncLevel: DataSyncLevel.Off,
        inviteSpotlightAnsweredOrganizationIds: [ORGANIZATION_ID],
        relayOrigin: VIBE_UNROUTABLE_RELAY_ORIGIN,
        transcriptSyncEnabled: false,
        savedConfigs: [
          {
            apiOrigin: origins.apiOrigin,
            gatewayId: GATEWAY_ID,
            id: "vibe-local-stack",
            name: "Vibe local stack",
            relayOrigin: VIBE_UNROUTABLE_RELAY_ORIGIN,
            webAppOrigin: origins.webOrigin,
          },
        ],
      }
    );
  });

  it("saves a branch preview under its own config, relay still unroutable", () => {
    const origins = {
      apiOrigin: "https://api-stage-git-feat-x.preview.stage.example",
      webOrigin: "https://app-stage-git-feat-x.preview.stage.example",
      originKind: VibeOriginKind.BranchPreview,
    };
    assert.deepEqual(
      vibeDesktopSettings(origins, GATEWAY_ID, ORGANIZATION_ID),
      {
        ...E2E_DESKTOP_SETTINGS_SEED,
        activeConfigId: "vibe-branch-preview",
        apiOrigin: origins.apiOrigin,
        cloudCommandsPaused: true,
        cloudConnectionEnabled: false,
        dataSyncLevel: DataSyncLevel.Off,
        inviteSpotlightAnsweredOrganizationIds: [ORGANIZATION_ID],
        relayOrigin: VIBE_UNROUTABLE_RELAY_ORIGIN,
        transcriptSyncEnabled: false,
        savedConfigs: [
          {
            apiOrigin: origins.apiOrigin,
            gatewayId: GATEWAY_ID,
            id: "vibe-branch-preview",
            name: origins.apiOrigin,
            relayOrigin: VIBE_UNROUTABLE_RELAY_ORIGIN,
            webAppOrigin: origins.webOrigin,
          },
        ],
      }
    );
  });
});

/**
 * ISS-12135 bug 48: the patch through the REAL boot migrations, the way the
 * vibe Desktop starts. Before, the patch carried no top-level `relayOrigin`, so
 * the legacy origin-rename migration moved the preview's API origin into
 * `relayOrigin` and the cloud socket dialled the API (a Vercel function, which
 * holds no socket): the startup banner sat on a degraded cloud for good.
 */
describe("a vibe profile booted through the settings migrations", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function boot(userDataDir: string): SettingsStore {
    return new SettingsStore({ cwd: userDataDir, name: "desktop-settings" });
  }

  it("keeps the preview's API origin, points the relay nowhere, and leaves sync Off", () => {
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "vibe-settings-")
    );
    tempDirs.push(userDataDir);
    const origins = {
      apiOrigin: "https://api-stage-git-vibe-x.preview.stage.example",
      webOrigin: "https://app-stage-git-vibe-x.preview.stage.example",
      originKind: VibeOriginKind.BranchPreview,
    };
    fs.writeFileSync(
      path.join(userDataDir, "desktop-settings.json"),
      JSON.stringify(vibeDesktopSettings(origins, GATEWAY_ID, ORGANIZATION_ID))
    );

    for (const store of [boot(userDataDir), boot(userDataDir)]) {
      assert.equal(store.getApiOrigin(), origins.apiOrigin);
      assert.equal(store.getRelayOrigin(), VIBE_UNROUTABLE_RELAY_ORIGIN);
      assert.equal(store.getDataSyncLevel(), DataSyncLevel.Off);
      assert.equal(store.getFlag("cloudConnectionEnabled"), false);
      assert.equal(store.getSyncConsentRecord().tier, "full");
      assert.deepEqual(store.getAll().inviteSpotlightAnsweredOrganizationIds, [
        ORGANIZATION_ID,
      ]);
    }
  });
});
