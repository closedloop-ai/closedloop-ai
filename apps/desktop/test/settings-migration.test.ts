import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { SettingsStore } from "../src/main/settings-store.js";
import {
  DEFAULT_AUTH_API_ORIGIN,
  DEFAULT_DESKTOP_SETTINGS,
} from "../src/shared/contracts.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("constructor deletes stale allowedDirectories key from persisted store", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-migration-"));
  tempDirs.push(tmpDir);

  // Pre-seed a JSON file with the stale key
  const storeName = "test-settings";
  fs.writeFileSync(
    path.join(tmpDir, `${storeName}.json`),
    JSON.stringify({
      allowedDirectories: ["/old/path"],
      sandboxBaseDirectory: "/Users/test/Source",
    })
  );

  const store = new SettingsStore({ cwd: tmpDir, name: storeName });
  const all = store.getAll();

  assert.equal(
    "allowedDirectories" in all,
    false,
    "allowedDirectories should be removed from getAll()"
  );
  assert.equal(
    all.sandboxBaseDirectory,
    "/Users/test/Source",
    "other settings should be preserved"
  );
});

test("constructor does not error when allowedDirectories key is absent", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-migration-"));
  tempDirs.push(tmpDir);

  const storeName = "test-settings-clean";
  fs.writeFileSync(
    path.join(tmpDir, `${storeName}.json`),
    JSON.stringify({ sandboxBaseDirectory: "/Users/test/Source" })
  );

  const store = new SettingsStore({ cwd: tmpDir, name: storeName });
  const all = store.getAll();

  assert.equal("allowedDirectories" in all, false);
  assert.equal(all.sandboxBaseDirectory, "/Users/test/Source");
});

// --- Origin migration tests ---

test("migration: pre-authApiOrigin install promotes apiOrigin → relayOrigin and sets default apiOrigin", () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "settings-migration-relay-")
  );
  tempDirs.push(tmpDir);

  const storeName = "test-settings-pre-auth";
  // Seed a file that only has the old apiOrigin (the relay URL), no authApiOrigin
  fs.writeFileSync(
    path.join(tmpDir, `${storeName}.json`),
    JSON.stringify({ apiOrigin: "https://relay.example.test" })
  );

  const store = new SettingsStore({ cwd: tmpDir, name: storeName });
  const all = store.getAll();

  assert.equal(
    all.relayOrigin,
    "https://relay.example.test",
    "relayOrigin should be the sentinel relay URL"
  );
  assert.equal(
    all.apiOrigin,
    DEFAULT_AUTH_API_ORIGIN,
    "apiOrigin should be the default REST API origin"
  );
  assert.equal(
    "authApiOrigin" in all,
    false,
    "authApiOrigin should not be present"
  );
});

test("migration: intermediate build promotes apiOrigin → relayOrigin and authApiOrigin → apiOrigin", () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "settings-migration-intermediate-")
  );
  tempDirs.push(tmpDir);

  const storeName = "test-settings-intermediate";
  // Seed a file with both old apiOrigin (relay URL) and authApiOrigin (REST API URL)
  fs.writeFileSync(
    path.join(tmpDir, `${storeName}.json`),
    JSON.stringify({
      apiOrigin: "https://relay.example.test",
      authApiOrigin: "https://api.example.test",
    })
  );

  const store = new SettingsStore({ cwd: tmpDir, name: storeName });
  const all = store.getAll();

  assert.equal(
    all.relayOrigin,
    "https://relay.example.test",
    "relayOrigin should be the sentinel relay URL"
  );
  assert.equal(
    all.apiOrigin,
    "https://api.example.test",
    "apiOrigin should be the sentinel REST API URL"
  );
  assert.equal(
    "authApiOrigin" in all,
    false,
    "authApiOrigin should be deleted after migration"
  );
});

test("migration: fresh install applies defaults", () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "settings-migration-fresh-")
  );
  tempDirs.push(tmpDir);

  const storeName = "test-settings-fresh";
  // Seed an empty file — no legacy keys
  fs.writeFileSync(path.join(tmpDir, `${storeName}.json`), JSON.stringify({}));

  const store = new SettingsStore({ cwd: tmpDir, name: storeName });
  const all = store.getAll();

  assert.equal(
    all.relayOrigin,
    DEFAULT_DESKTOP_SETTINGS.relayOrigin,
    "relayOrigin should be the default relay origin"
  );
  assert.equal(
    all.apiOrigin,
    DEFAULT_DESKTOP_SETTINGS.apiOrigin,
    "apiOrigin should be the default REST API origin"
  );
  assert.equal(
    all.agentMonitorEnabled,
    true,
    "Agent Dashboard should default on"
  );
  assert.equal(
    all.planExtractionEnabled,
    false,
    "plan extraction should default off"
  );
  assert.equal(
    all.commandSigningEnforcementEnabled,
    false,
    "command signing enforcement should default off"
  );
  assert.equal(
    "authApiOrigin" in all,
    false,
    "no stale authApiOrigin key should be present"
  );
});

test("command signing enforcement persists across settings store reloads", () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "settings-command-signing-")
  );
  tempDirs.push(tmpDir);

  const storeName = "test-command-signing";
  const store = new SettingsStore({ cwd: tmpDir, name: storeName });
  store.update({
    commandSigningEnforcementEnabled: true,
    sandboxBaseDirectory: "/Users/test/Source",
  });

  const reloaded = new SettingsStore({ cwd: tmpDir, name: storeName });
  const all = reloaded.getAll();

  assert.equal(all.commandSigningEnforcementEnabled, true);
  assert.equal(all.sandboxBaseDirectory, "/Users/test/Source");
});

test("agent monitor enablement persists across settings store reloads", () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "settings-agent-monitor-")
  );
  tempDirs.push(tmpDir);

  const storeName = "test-agent-monitor";
  const store = new SettingsStore({ cwd: tmpDir, name: storeName });
  store.update({
    agentMonitorEnabled: true,
    sandboxBaseDirectory: "/Users/test/Source",
  });

  const reloaded = new SettingsStore({ cwd: tmpDir, name: storeName });
  const all = reloaded.getAll();

  assert.equal(all.agentMonitorEnabled, true);
  assert.equal(all.sandboxBaseDirectory, "/Users/test/Source");
});

test("plan extraction enablement persists across settings store reloads", () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "settings-plan-extraction-")
  );
  tempDirs.push(tmpDir);

  const storeName = "test-plan-extraction";
  const store = new SettingsStore({ cwd: tmpDir, name: storeName });
  store.update({
    planExtractionEnabled: true,
    sandboxBaseDirectory: "/Users/test/Source",
  });

  const reloaded = new SettingsStore({ cwd: tmpDir, name: storeName });
  const all = reloaded.getAll();

  assert.equal(all.planExtractionEnabled, true);
  assert.equal(all.sandboxBaseDirectory, "/Users/test/Source");
});

test("partial settings update preserves command signing enforcement", () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "settings-command-signing-partial-")
  );
  tempDirs.push(tmpDir);

  const store = new SettingsStore({
    cwd: tmpDir,
    name: "test-command-signing-partial",
  });
  store.update({
    commandSigningEnforcementEnabled: true,
    sandboxBaseDirectory: "/Users/test/Source",
  });
  store.update({ verboseLogging: true });

  const all = store.getAll();

  assert.equal(all.commandSigningEnforcementEnabled, true);
  assert.equal(all.sandboxBaseDirectory, "/Users/test/Source");
  assert.equal(all.verboseLogging, true);
});

test("partial settings update preserves agent monitor enablement", () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "settings-agent-monitor-partial-")
  );
  tempDirs.push(tmpDir);

  const store = new SettingsStore({
    cwd: tmpDir,
    name: "test-agent-monitor-partial",
  });
  store.update({
    agentMonitorEnabled: true,
    sandboxBaseDirectory: "/Users/test/Source",
  });
  store.update({ verboseLogging: true });

  const all = store.getAll();

  assert.equal(all.agentMonitorEnabled, true);
  assert.equal(all.sandboxBaseDirectory, "/Users/test/Source");
  assert.equal(all.verboseLogging, true);
});

test("partial settings update preserves plan extraction enablement", () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "settings-plan-extraction-partial-")
  );
  tempDirs.push(tmpDir);

  const store = new SettingsStore({
    cwd: tmpDir,
    name: "test-plan-extraction-partial",
  });
  store.update({
    planExtractionEnabled: true,
    sandboxBaseDirectory: "/Users/test/Source",
  });
  store.update({ verboseLogging: true });

  const all = store.getAll();

  assert.equal(all.planExtractionEnabled, true);
  assert.equal(all.sandboxBaseDirectory, "/Users/test/Source");
  assert.equal(all.verboseLogging, true);
});

// --- Approval tier "auto" → "high" migration ---

test("migration: defaultApprovalTier 'auto' is rewritten to 'high'", () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "settings-migration-auto-tier-")
  );
  tempDirs.push(tmpDir);

  const storeName = "test-auto-tier";
  fs.writeFileSync(
    path.join(tmpDir, `${storeName}.json`),
    JSON.stringify({
      defaultApprovalTier: "auto",
      autoApprovalRules: { deploy: "auto", health_check: "low" },
    })
  );

  const store = new SettingsStore({ cwd: tmpDir, name: storeName });
  const all = store.getAll();

  assert.equal(
    all.defaultApprovalTier,
    "high",
    "defaultApprovalTier should be migrated to 'high'"
  );
  assert.equal(
    (all.autoApprovalRules as Record<string, string>).deploy,
    "high",
    "autoApprovalRules 'auto' entries should be migrated to 'high'"
  );
  assert.equal(
    (all.autoApprovalRules as Record<string, string>).health_check,
    "low",
    "non-auto autoApprovalRules entries should be preserved"
  );

  // Verify persisted JSON no longer contains "auto"
  const persisted = JSON.parse(
    fs.readFileSync(path.join(tmpDir, `${storeName}.json`), "utf-8")
  );
  assert.equal(
    persisted.defaultApprovalTier,
    "high",
    "persisted defaultApprovalTier should be 'high'"
  );
  assert.equal(
    persisted.autoApprovalRules?.deploy,
    "high",
    "persisted autoApprovalRules.deploy should be 'high'"
  );
});

test("migration: already migrated install is a no-op — both values preserved", () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "settings-migration-noop-")
  );
  tempDirs.push(tmpDir);

  const storeName = "test-settings-noop";
  // Seed a file that already has the new keys — migration should be a no-op
  fs.writeFileSync(
    path.join(tmpDir, `${storeName}.json`),
    JSON.stringify({
      relayOrigin: "https://relay.example.test",
      apiOrigin: "https://api.example.test",
    })
  );

  const store = new SettingsStore({ cwd: tmpDir, name: storeName });
  const all = store.getAll();

  assert.equal(
    all.relayOrigin,
    "https://relay.example.test",
    "relayOrigin should be preserved unchanged"
  );
  assert.equal(
    all.apiOrigin,
    "https://api.example.test",
    "apiOrigin should be preserved unchanged"
  );
  assert.equal(
    "authApiOrigin" in all,
    false,
    "no stale authApiOrigin key should be added"
  );
});

test("onboardingPopupDismissedPermanent defaults to false for existing installs", () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "settings-onboarding-popup-default-")
  );
  tempDirs.push(tmpDir);

  const storeName = "test-settings-popup-default";
  fs.writeFileSync(
    path.join(tmpDir, `${storeName}.json`),
    JSON.stringify({
      sandboxBaseDirectory: "/Users/test/Source",
      onboardingCompleted: true,
    })
  );

  const store = new SettingsStore({ cwd: tmpDir, name: storeName });

  assert.equal(store.getOnboardingPopupDismissedPermanent(), false);
  assert.equal(store.getAll().onboardingPopupDismissedPermanent, false);
});

test("setOnboardingPopupDismissedPermanent persists across new SettingsStore instances", () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "settings-onboarding-popup-persist-")
  );
  tempDirs.push(tmpDir);

  const storeName = "test-settings-popup-persist";
  const store = new SettingsStore({ cwd: tmpDir, name: storeName });
  store.setOnboardingPopupDismissedPermanent(true);

  const reopened = new SettingsStore({ cwd: tmpDir, name: storeName });
  assert.equal(reopened.getOnboardingPopupDismissedPermanent(), true);
});

// --- FEA-1333: dashboardWelcomeSeen flag ---

test("dashboardWelcomeSeen defaults to false for existing installs", () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "settings-dashboard-welcome-default-")
  );
  tempDirs.push(tmpDir);

  const storeName = "test-settings-dashboard-welcome-default";
  fs.writeFileSync(
    path.join(tmpDir, `${storeName}.json`),
    JSON.stringify({
      sandboxBaseDirectory: "/Users/test/Source",
      onboardingCompleted: true,
    })
  );

  const store = new SettingsStore({ cwd: tmpDir, name: storeName });

  assert.equal(store.getDashboardWelcomeSeen(), false);
  assert.equal(store.getAll().dashboardWelcomeSeen, false);
});

test("setDashboardWelcomeSeen persists across new SettingsStore instances", () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "settings-dashboard-welcome-persist-")
  );
  tempDirs.push(tmpDir);

  const storeName = "test-settings-dashboard-welcome-persist";
  const store = new SettingsStore({ cwd: tmpDir, name: storeName });
  store.setDashboardWelcomeSeen(true);

  const reopened = new SettingsStore({ cwd: tmpDir, name: storeName });
  assert.equal(reopened.getDashboardWelcomeSeen(), true);
});
