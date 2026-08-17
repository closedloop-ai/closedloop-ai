import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { SettingsStore } from "../src/main/settings/settings-store.js";
import {
  DEFAULT_AUTH_API_ORIGIN,
  DEFAULT_DESKTOP_SETTINGS,
  syncTierAllowsSessionMetadata,
  syncTierAllowsTranscripts,
} from "../src/shared/contracts.js";
import { DESKTOP_ROUTINES_FEATURE_FLAG_KEY } from "../src/shared/feature-flags.js";

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

test("constructor deletes stale read-source-indicator key from persisted store", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-migration-"));
  tempDirs.push(tmpDir);

  // Pre-seed a JSON file with the retired Labs feature-flag key. electron-store
  // spreads raw persisted data in getAll(), so without the migration delete this
  // stale key would bleed through into IPC responses.
  const storeName = "test-settings-read-source";
  fs.writeFileSync(
    path.join(tmpDir, `${storeName}.json`),
    JSON.stringify({
      "read-source-indicator": true,
      sandboxBaseDirectory: "/Users/test/Source",
    })
  );

  const store = new SettingsStore({ cwd: tmpDir, name: storeName });
  const all = store.getAll();

  assert.equal(
    "read-source-indicator" in all,
    false,
    "read-source-indicator should be removed from getAll()"
  );
  assert.equal(
    all.sandboxBaseDirectory,
    "/Users/test/Source",
    "other settings should be preserved"
  );
});

test("constructor deletes the removed branches-hide-cruft key from persisted store (FEA-4004)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-migration-"));
  tempDirs.push(tmpDir);

  // FEA-4004 removed the "Hide Merged & Agent Branches" default-hide entirely,
  // dropping its `branches-hide-cruft` Labs toggle. An install that opted the
  // flag on/off still carries the persisted key; electron-store spreads raw
  // persisted data in getAll(), so without the migration delete this stale key
  // would bleed through into IPC responses.
  const storeName = "test-settings-branches-hide-cruft";
  fs.writeFileSync(
    path.join(tmpDir, `${storeName}.json`),
    JSON.stringify({
      "branches-hide-cruft": true,
      sandboxBaseDirectory: "/Users/test/Source",
    })
  );

  const store = new SettingsStore({ cwd: tmpDir, name: storeName });
  const all = store.getAll();

  assert.equal(
    "branches-hide-cruft" in all,
    false,
    "branches-hide-cruft should be removed from getAll()"
  );
  assert.equal(
    all.sandboxBaseDirectory,
    "/Users/test/Source",
    "other settings should be preserved"
  );
});

test("constructor deletes the retired desktopFirstPartyAuthEnabled key from persisted store (FEA-4133)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-migration-"));
  tempDirs.push(tmpDir);

  // FEA-4133 graduated first-party desktop Account Sign-In to always-on and
  // removed its `desktopFirstPartyAuthEnabled` Labs toggle from the type,
  // defaults, and registry. An install that persisted the flag (it defaulted
  // false) still carries the raw key; electron-store spreads raw persisted data
  // in getAll(), so without the migration delete this stale key would bleed
  // through into IPC responses and no longer conform to DesktopSettings.
  const storeName = "test-settings-first-party-auth";
  fs.writeFileSync(
    path.join(tmpDir, `${storeName}.json`),
    JSON.stringify({
      desktopFirstPartyAuthEnabled: false,
      sandboxBaseDirectory: "/Users/test/Source",
    })
  );

  const store = new SettingsStore({ cwd: tmpDir, name: storeName });
  const all = store.getAll();

  assert.equal(
    "desktopFirstPartyAuthEnabled" in all,
    false,
    "desktopFirstPartyAuthEnabled should be removed from getAll()"
  );
  assert.equal(
    all.sandboxBaseDirectory,
    "/Users/test/Source",
    "other settings should be preserved"
  );
});

test("constructor deletes the retired session-comments-rail-collapse key from persisted store (FEA-4002)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-migration-"));
  tempDirs.push(tmpDir);

  // FEA-4002 graduated the Collapsible Comments Rail to always-on and removed its
  // `session-comments-rail-collapse` flag from the type, defaults, and registry.
  // It was a persisted DesktopSettings field that defaulted true, so an existing
  // install still carries the raw key; electron-store spreads raw persisted data
  // in getAll(), so without the migration delete this stale key would bleed
  // through into IPC responses and no longer conform to DesktopSettings.
  const storeName = "test-settings-comments-rail-collapse";
  fs.writeFileSync(
    path.join(tmpDir, `${storeName}.json`),
    JSON.stringify({
      "session-comments-rail-collapse": true,
      sandboxBaseDirectory: "/Users/test/Source",
    })
  );

  const store = new SettingsStore({ cwd: tmpDir, name: storeName });
  const all = store.getAll();

  assert.equal(
    "session-comments-rail-collapse" in all,
    false,
    "session-comments-rail-collapse should be removed from getAll()"
  );
  assert.equal(
    all.sandboxBaseDirectory,
    "/Users/test/Source",
    "other settings should be preserved"
  );
});

test("constructor deletes the retired pack-extended-content-kinds key from persisted store (FEA-4132)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-migration-"));
  tempDirs.push(tmpDir);

  // FEA-4132 graduated Extended Pack Contents to always-on and removed its
  // `pack-extended-content-kinds` Labs toggle from the type, defaults, and
  // registry. An existing install that opted the Labs flag on (or off) still
  // carries the persisted key; electron-store spreads raw persisted data in
  // getAll(), so without the migration delete this stale key would bleed through
  // into IPC responses and no longer conform to DesktopSettings.
  const storeName = "test-settings-pack-extended-content-kinds";
  fs.writeFileSync(
    path.join(tmpDir, `${storeName}.json`),
    JSON.stringify({
      "pack-extended-content-kinds": true,
      sandboxBaseDirectory: "/Users/test/Source",
    })
  );

  const store = new SettingsStore({ cwd: tmpDir, name: storeName });
  const all = store.getAll();

  assert.equal(
    "pack-extended-content-kinds" in all,
    false,
    "pack-extended-content-kinds should be removed from getAll()"
  );
  assert.equal(
    all.sandboxBaseDirectory,
    "/Users/test/Source",
    "other settings should be preserved"
  );
});

test("constructor deletes the retired honest-sync-copy key from persisted store (ISS-5348)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-migration-"));
  tempDirs.push(tmpDir);

  // ISS-5348 shipped the honest import-splash sync footnote unconditionally and
  // removed its `honest-sync-copy` Labs toggle from the type, defaults, and
  // registry. The flag defaulted `false`, so an install that opted it on (or
  // off) still carries the persisted key; electron-store spreads raw persisted
  // data in getAll(), so without the migration delete this stale key would bleed
  // through into IPC responses and no longer conform to DesktopSettings.
  const storeName = "test-settings-honest-sync-copy";
  fs.writeFileSync(
    path.join(tmpDir, `${storeName}.json`),
    JSON.stringify({
      "honest-sync-copy": true,
      sandboxBaseDirectory: "/Users/test/Source",
    })
  );

  const store = new SettingsStore({ cwd: tmpDir, name: storeName });
  const all = store.getAll();

  assert.equal(
    "honest-sync-copy" in all,
    false,
    "honest-sync-copy should be removed from getAll()"
  );
  assert.equal(
    all.sandboxBaseDirectory,
    "/Users/test/Source",
    "other settings should be preserved"
  );
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

test("FEA-3462: stranded legacy install (onboarded, no tier) is reconciled to the SAFE 'metadata' floor — never 'full'", () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "settings-stranded-tier-")
  );
  tempDirs.push(tmpDir);

  const storeName = "test-stranded-tier";
  // Onboarding completed before the consent gate existed: tier key is ABSENT.
  fs.writeFileSync(
    path.join(tmpDir, `${storeName}.json`),
    JSON.stringify({ onboardingCompleted: true })
  );

  const store = new SettingsStore({ cwd: tmpDir, name: storeName });

  // The reconciliation restores the metadata (counts/aggregates) lane the
  // legacy install already had, without silently granting transcript sharing.
  assert.equal(
    store.getSyncObservabilityTier(),
    "metadata",
    "stranded legacy install should be reconciled to the safe 'metadata' floor"
  );

  // CONSENT SAFETY: the reconciliation must NEVER silently opt the user into the
  // full-transcript-upload tier without an explicit choice.
  assert.notEqual(
    store.getSyncObservabilityTier(),
    "full",
    "reconciliation must never auto-grant the 'full' (transcript-content) tier"
  );

  // The reconciled tier must be persisted, not merely defaulted at read time.
  const persisted = JSON.parse(
    fs.readFileSync(path.join(tmpDir, `${storeName}.json`), "utf-8")
  );
  assert.equal(
    persisted.syncObservabilityTier,
    "metadata",
    "reconciled tier should be persisted to disk"
  );
});

test("FEA-3462: explicit tier choice is never overridden by reconciliation", () => {
  for (const tier of ["local", "metadata", "full"] as const) {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `settings-explicit-tier-${tier}-`)
    );
    tempDirs.push(tmpDir);

    const storeName = "test-explicit-tier";
    fs.writeFileSync(
      path.join(tmpDir, `${storeName}.json`),
      JSON.stringify({ onboardingCompleted: true, syncObservabilityTier: tier })
    );

    const store = new SettingsStore({ cwd: tmpDir, name: storeName });
    assert.equal(
      store.getSyncObservabilityTier(),
      tier,
      `explicit '${tier}' choice must be preserved`
    );
  }
});

test("FEA-3462: an install with no prior sync state is not reconciled (tier stays null)", () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "settings-not-onboarded-tier-")
  );
  tempDirs.push(tmpDir);

  const storeName = "test-not-onboarded-tier";
  // No onboarding, no superseded sync flags — a non-sync setting must not trigger
  // grandfathering. (A not-yet-onboarded install that WAS syncing is a different
  // case: it is restored to its prior tier — see data-sync-level.test.ts.)
  fs.writeFileSync(
    path.join(tmpDir, `${storeName}.json`),
    JSON.stringify({ sandboxBaseDirectory: "/Users/test/Source" })
  );

  const store = new SettingsStore({ cwd: tmpDir, name: storeName });
  assert.equal(
    store.getSyncObservabilityTier(),
    null,
    "an install with no prior sync state must stay in the not-yet-consented gate"
  );
});

test("FEA-3462: the reconciled 'metadata' floor permits the metadata lane but keeps transcript CONTENTS local", () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "settings-stranded-tier-gate-")
  );
  tempDirs.push(tmpDir);

  const storeName = "test-stranded-tier-gate";
  fs.writeFileSync(
    path.join(tmpDir, `${storeName}.json`),
    JSON.stringify({ onboardingCompleted: true })
  );

  const store = new SettingsStore({ cwd: tmpDir, name: storeName });
  const tier = store.getSyncObservabilityTier();

  // Feed the reconciled tier through the PRD-532 §7 gate the sync services use.
  assert.equal(
    syncTierAllowsSessionMetadata(tier),
    true,
    "reconciled tier must restore the session-metadata (counts/aggregates) lane"
  );
  assert.equal(
    syncTierAllowsTranscripts(tier),
    false,
    "reconciled tier must NOT silently permit transcript CONTENTS to leave the machine"
  );
});

test("PRD-566/FEA-4348: a persisted 'scheduledTasks' opt-in migrates to 'routines' AND keeps the legacy shadow so a downgrade still reads it", () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "settings-routines-migrate-on-")
  );
  tempDirs.push(tmpDir);

  const storeName = "test-routines-migrate-on";
  // Simulate an install that opted into the pre-rename "Scheduled Tasks" Labs
  // flag (which booted the crewd scheduler daemon that owns the stored tasks).
  fs.writeFileSync(
    path.join(tmpDir, `${storeName}.json`),
    JSON.stringify({ scheduledTasks: true })
  );

  const store = new SettingsStore({ cwd: tmpDir, name: storeName });

  // The daemon boot reads `getFlag(routines)`; the opt-in must carry forward so
  // the scheduler still starts and its already-stored tasks are not stranded.
  assert.equal(
    store.getFlag(DESKTOP_ROUTINES_FEATURE_FLAG_KEY),
    true,
    "a legacy scheduledTasks=true opt-in must migrate to routines=true"
  );
  // The rename is not one-way: the legacy shadow is kept and mirrored so a
  // downgrade to a pre-rename build still reads the current value (wongk, #3896).
  assert.equal(
    store.getAll().scheduledTasks,
    true,
    "the legacy scheduledTasks shadow must be kept in sync for downgrades"
  );
});

test("PRD-566/FEA-4348: a legacy 'scheduledTasks=false' opt-OUT is preserved, not defaulted back on", () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "settings-routines-migrate-off-")
  );
  tempDirs.push(tmpDir);

  const storeName = "test-routines-migrate-off";
  fs.writeFileSync(
    path.join(tmpDir, `${storeName}.json`),
    JSON.stringify({ scheduledTasks: false })
  );

  const store = new SettingsStore({ cwd: tmpDir, name: storeName });

  // Mocks the OPPOSITE branch too: the registry default is also false, so the
  // false must have been carried by the copy path — assert both keys are false.
  assert.equal(
    store.getFlag(DESKTOP_ROUTINES_FEATURE_FLAG_KEY),
    false,
    "a legacy scheduledTasks=false opt-out must be preserved as routines=false"
  );
  assert.equal(
    store.getAll().scheduledTasks,
    false,
    "the false opt-out must be mirrored into the legacy shadow too"
  );
});

test("PRD-566/FEA-4348: when routines and the legacy shadow AGREE, routines wins and the shadow stays synced", () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "settings-routines-agree-")
  );
  tempDirs.push(tmpDir);

  const storeName = "test-routines-agree";
  fs.writeFileSync(
    path.join(tmpDir, `${storeName}.json`),
    JSON.stringify({ routines: true, scheduledTasks: true })
  );

  const store = new SettingsStore({ cwd: tmpDir, name: storeName });

  assert.equal(store.getFlag(DESKTOP_ROUTINES_FEATURE_FLAG_KEY), true);
  assert.equal(store.getAll().scheduledTasks, true);
});

test("PRD-566/FEA-4348: new→old→new — a diverging legacy shadow (old build re-toggled) wins over the frozen routines value", () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "settings-routines-downgrade-retoggle-")
  );
  tempDirs.push(tmpDir);

  const storeName = "test-routines-downgrade-retoggle";
  // The round-trip wongk called out: a new build set routines=true (+ shadow),
  // the user downgraded and turned Scheduled Tasks OFF on the old build (which
  // only writes `scheduledTasks`), leaving `routines` frozen at true. On the
  // next upgrade the newer opt-OUT — the diverging legacy value — must win, or
  // the migration would silently ignore the user's most recent choice.
  fs.writeFileSync(
    path.join(tmpDir, `${storeName}.json`),
    JSON.stringify({ routines: true, scheduledTasks: false })
  );

  const store = new SettingsStore({ cwd: tmpDir, name: storeName });

  assert.equal(
    store.getFlag(DESKTOP_ROUTINES_FEATURE_FLAG_KEY),
    false,
    "the diverging legacy value (the user's newer choice on the old build) must win"
  );
  assert.equal(
    store.getAll().scheduledTasks,
    false,
    "and the resolved value is mirrored back into the shadow"
  );
});

test("PRD-566/FEA-4348: setFlag('routines') dual-writes the legacy shadow so a later downgrade reads it", () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "settings-routines-setflag-shadow-")
  );
  tempDirs.push(tmpDir);

  const storeName = "test-routines-setflag-shadow";
  const store = new SettingsStore({ cwd: tmpDir, name: storeName });

  store.setFlag(DESKTOP_ROUTINES_FEATURE_FLAG_KEY, true);
  assert.equal(
    store.getAll().scheduledTasks,
    true,
    "toggling routines on must mirror into the legacy shadow"
  );

  store.setFlag(DESKTOP_ROUTINES_FEATURE_FLAG_KEY, false);
  assert.equal(
    store.getAll().scheduledTasks,
    false,
    "toggling routines off must mirror into the legacy shadow"
  );
});
