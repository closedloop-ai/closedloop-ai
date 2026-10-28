import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { resolveActiveGatewayId } from "../src/main/settings/active-gateway-id.js";
import { SettingsStore } from "../src/main/settings/settings-store.js";
import { DesktopAuthStatus } from "../src/shared/contracts.js";

test("guest gateway reads do not recreate sign-out-cleared profile metadata", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "gateway-id-guest-"));
  try {
    const settings = new SettingsStore({ cwd: root, name: "settings" });
    settings.setRelayOrigin("https://relay.example.test");
    settings.setApiOrigin("https://api.example.test");
    settings.setWebAppOrigin("https://app.example.test");
    const profile = settings.saveConfig("fixture");
    settings.setActiveConfigId(profile.id);

    assert.equal(
      resolveActiveGatewayId(
        settings,
        DesktopAuthStatus.Loading,
        false,
        "legacy"
      ),
      "legacy"
    );
    const previous = resolveActiveGatewayId(
      settings,
      DesktopAuthStatus.Loading,
      true,
      "legacy"
    );
    assert.notEqual(previous, "legacy");
    assert.equal(
      resolveActiveGatewayId(
        settings,
        DesktopAuthStatus.Authenticated,
        true,
        "legacy"
      ),
      previous
    );
    settings.clearAllConfigManagedMetadata();
    assert.equal(settings.getActiveConfig()?.gatewayId, undefined);

    assert.equal(
      resolveActiveGatewayId(
        settings,
        DesktopAuthStatus.SignedOut,
        false,
        "legacy"
      ),
      "legacy"
    );
    const relaunched = new SettingsStore({ cwd: root, name: "settings" });
    assert.equal(
      resolveActiveGatewayId(
        relaunched,
        DesktopAuthStatus.Loading,
        false,
        "legacy"
      ),
      "legacy"
    );
    assert.equal(relaunched.getActiveConfig()?.gatewayId, undefined);

    const fresh = resolveActiveGatewayId(
      relaunched,
      DesktopAuthStatus.OpeningBrowser,
      false,
      "legacy"
    );
    assert.notEqual(fresh, previous);
    assert.equal(relaunched.getActiveConfig()?.gatewayId, fresh);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
