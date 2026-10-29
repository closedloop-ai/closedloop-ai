// ISS-10514: branch coverage for `SettingsStore` paths no neighbouring suite
// reaches: the default store name, a corrupt `savedConfigs` container, the
// not-found guards on each per-profile mutator, the "no active profile" early
// returns, the less-used `update` fields, and a persisted `null` declined list.
// Every case runs against a real electron-store file in a temp dir.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "vitest";
import { SettingsStore } from "../src/main/settings/settings-store.js";
import { SyncObservabilityTier } from "../src/shared/contracts.js";
import { createTempDirManager } from "./helpers/temp-dir.js";

const CONFIG_NOT_FOUND_ERROR = /Config not found: missing-id/;
const MISSING_ID = "missing-id";

const { makeTempDir } = createTempDirManager("settings-store-coverage-");

function makeStore(): { store: SettingsStore; dir: string } {
  const dir = makeTempDir();
  return { store: new SettingsStore({ cwd: dir, name: "settings" }), dir };
}

/** Writes a raw (possibly invalid) value straight into the store's JSON file. */
function writeRawKey(dir: string, key: string, value: unknown): void {
  const file = path.join(dir, "settings.json");
  const parsed: Record<string, unknown> = JSON.parse(
    fs.readFileSync(file, "utf-8")
  );
  parsed[key] = value;
  fs.writeFileSync(file, JSON.stringify(parsed));
}

describe("SettingsStore construction", () => {
  test("defaults the backing file name to desktop-settings when no name is given", () => {
    const dir = makeTempDir();
    const store = new SettingsStore({ cwd: dir });
    store.update({ onboardingCompleted: true });

    assert.equal(fs.existsSync(path.join(dir, "desktop-settings.json")), true);
    assert.equal(
      new SettingsStore({ cwd: dir }).getOnboardingCompleted(),
      true,
      "a second store with the default name reads the same file"
    );
  });
});

describe("SettingsStore flag source", () => {
  test("reports default until the flag is written, then user", () => {
    const { store } = makeStore();

    assert.equal(store.getFlagSource("collectCursorEnabled"), "default");
    store.setFlag("collectCursorEnabled", false);
    assert.equal(store.getFlagSource("collectCursorEnabled"), "user");
    assert.equal(store.getFlag("collectCursorEnabled"), false);
  });
});

describe("SettingsStore saved configs", () => {
  test("a non-array savedConfigs value reads as empty and is rewritten to []", () => {
    const { store, dir } = makeStore();
    writeRawKey(dir, "savedConfigs", "corrupt");

    assert.deepEqual(store.getSavedConfigs(), []);
    assert.deepEqual(store.rawStore.store.savedConfigs, []);
  });

  test("getActiveConfig returns null when the active id names no saved profile", () => {
    const { store } = makeStore();
    store.saveConfig("Work");
    store.setActiveConfigId(MISSING_ID);

    assert.equal(store.getActiveConfig(), null);
  });

  test("isGatewayIdReferenced is false for a blank or absent gateway id", () => {
    const { store } = makeStore();
    const saved = store.saveConfig("Work");
    store.updateConfigManagedMetadata(saved.id, { gatewayId: "   " });

    assert.equal(store.isGatewayIdReferenced("   "), false);
    assert.equal(store.isGatewayIdReferenced(null), false);
    assert.equal(store.isGatewayIdReferenced(undefined), false);
  });

  test("renameConfig throws for an unknown id and leaves configs unchanged", () => {
    const { store } = makeStore();
    const saved = store.saveConfig("Work");

    assert.throws(
      () => store.renameConfig(MISSING_ID, "Other"),
      CONFIG_NOT_FOUND_ERROR
    );
    assert.deepEqual(
      store.listConfigs().map((c) => c.name),
      [saved.name]
    );
  });

  test("updateConfigConnection throws for an unknown id", () => {
    const { store } = makeStore();
    const saved = store.saveConfig("Work");

    assert.throws(
      () => store.updateConfigConnection(MISSING_ID, { name: "Other" }),
      CONFIG_NOT_FOUND_ERROR
    );
    assert.equal(store.listConfigs()[0]?.name, saved.name);
  });

  test("ensureConfigGatewayId throws for an unknown id", () => {
    const { store } = makeStore();
    store.saveConfig("Work");

    assert.throws(
      () => store.ensureConfigGatewayId(MISSING_ID),
      CONFIG_NOT_FOUND_ERROR
    );
    assert.equal(store.listConfigs()[0]?.gatewayId, undefined);
  });

  test("updateConfigManagedMetadata throws for an unknown id", () => {
    const { store } = makeStore();
    store.saveConfig("Work");

    assert.throws(
      () =>
        store.updateConfigManagedMetadata(MISSING_ID, {
          apiKeySource: "DESKTOP_MANAGED",
        }),
      CONFIG_NOT_FOUND_ERROR
    );
    assert.equal(store.listConfigs()[0]?.apiKeySource, "USER_CREATED");
  });

  test("updateActiveConfigManagedMetadata returns null and writes nothing with no active profile", () => {
    const { store } = makeStore();
    store.saveConfig("Work");

    assert.equal(
      store.updateActiveConfigManagedMetadata({
        apiKeySource: "DESKTOP_MANAGED",
      }),
      null
    );
    assert.equal(store.listConfigs()[0]?.apiKeySource, "USER_CREATED");
  });

  test("updateActiveConfigManagedMetadata patches the active profile", () => {
    const { store } = makeStore();
    const saved = store.saveConfig("Work");
    store.setActiveConfigId(saved.id);

    const updated = store.updateActiveConfigManagedMetadata({
      apiKeySource: "DESKTOP_MANAGED",
    });

    assert.equal(updated?.apiKeySource, "DESKTOP_MANAGED");
    assert.equal(store.listConfigs()[0]?.apiKeySource, "DESKTOP_MANAGED");
  });

  test("updateActiveConfigOrigins returns null with no active profile", () => {
    const { store } = makeStore();
    const saved = store.saveConfig("Work");

    assert.equal(
      store.updateActiveConfigOrigins({
        relayOrigin: "https://relay.example.com",
        apiOrigin: "https://api.example.com",
        webAppOrigin: "https://app.example.com",
      }),
      null
    );
    assert.equal(store.listConfigs()[0]?.relayOrigin, saved.relayOrigin);
  });

  test("updateActiveConfigOrigins throws when the active id names no saved profile", () => {
    const { store } = makeStore();
    store.saveConfig("Work");
    store.setActiveConfigId(MISSING_ID);

    assert.throws(
      () =>
        store.updateActiveConfigOrigins({
          relayOrigin: "https://relay.example.com",
          apiOrigin: "https://api.example.com",
          webAppOrigin: "https://app.example.com",
        }),
      CONFIG_NOT_FOUND_ERROR
    );
  });
});

describe("SettingsStore.update less-used fields", () => {
  test("persists onboardingPopupDismissedPermanent, approval rules, and default tier", () => {
    const { store } = makeStore();

    const result = store.update({
      onboardingPopupDismissedPermanent: true,
      autoApprovalRules: { "op-a": "low" },
      defaultApprovalTier: "medium",
    });

    assert.equal(result.onboardingPopupDismissedPermanent, true);
    assert.deepEqual(result.autoApprovalRules, { "op-a": "low" });
    assert.equal(result.defaultApprovalTier, "medium");
    assert.equal(store.getOnboardingPopupDismissedPermanent(), true);
  });

  test("persists a tier string and an explicit null syncObservabilityTier", () => {
    const { store } = makeStore();

    const tiered = store.update({
      syncObservabilityTier: SyncObservabilityTier.Metadata,
    });
    assert.equal(tiered.syncObservabilityTier, SyncObservabilityTier.Metadata);

    const cleared = store.update({ syncObservabilityTier: null });
    assert.equal(cleared.syncObservabilityTier, null);
    assert.equal(store.rawStore.store.syncObservabilityTier, null);
  });

  test("an update without those fields leaves their stored values alone", () => {
    const { store } = makeStore();
    store.update({
      defaultApprovalTier: "low",
      syncObservabilityTier: SyncObservabilityTier.Full,
    });

    const result = store.update({ onboardingCompleted: true });

    assert.equal(result.defaultApprovalTier, "low");
    assert.equal(result.syncObservabilityTier, SyncObservabilityTier.Full);
  });
});

describe("SettingsStore declined distributions", () => {
  test("a persisted null declined list reads as empty", () => {
    const { store, dir } = makeStore();
    writeRawKey(dir, "declinedDistributions", null);

    assert.deepEqual(store.getDeclinedDistributions(), []);
    assert.equal(store.isDistributionDeclined("dist-1"), false);
  });
});
