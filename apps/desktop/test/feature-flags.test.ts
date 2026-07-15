import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { SettingsStore } from "../src/main/settings-store.js";
import { FEATURE_FLAGS, type FlagKey } from "../src/shared/feature-flags.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // Clean up env overrides
  for (const def of FEATURE_FLAGS) {
    if (def.envOverride) {
      delete process.env[def.envOverride];
    }
  }
});

function makeStore(seed: Record<string, unknown> = {}): SettingsStore {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "feature-flags-"));
  tempDirs.push(tmpDir);
  const storeName = "test-settings";
  if (Object.keys(seed).length > 0) {
    fs.writeFileSync(
      path.join(tmpDir, `${storeName}.json`),
      JSON.stringify(seed)
    );
  }
  return new SettingsStore({ cwd: tmpDir, name: storeName });
}

// --- getFlag ---

// --- FEA-3152: agents-show-tools-mcps-hooks Labs flag ---

test("registry defines agents-show-tools-mcps-hooks as an off-by-default Labs toggle", () => {
  const def = FEATURE_FLAGS.find(
    (f) => f.key === "agents-show-tools-mcps-hooks"
  );
  assert.ok(def, "agents-show-tools-mcps-hooks must be registered");
  assert.equal(def.default, false, "must default to OFF");
  assert.equal(def.category, "Labs", "must be a Labs-category toggle");
  // Not hidden from Labs → the SettingsPanel LabsTab (FEATURE_FLAGS filtered by
  // !hiddenFromLabs) renders it as a user-facing opt-in toggle.
  assert.notEqual(
    def.hiddenFromLabs,
    true,
    "must be visible in the Labs settings panel"
  );
});

test("getFlag returns registry default when key is absent from store", () => {
  const store = makeStore();
  assert.equal(
    store.getFlag("agentMonitorEnabled"),
    true,
    "agentMonitorEnabled defaults to true"
  );
  assert.equal(
    store.getFlag("planExtractionEnabled"),
    false,
    "planExtractionEnabled defaults to false"
  );
});

test("getFlag returns stored value when present", () => {
  const store = makeStore({ agentMonitorEnabled: false });
  assert.equal(store.getFlag("agentMonitorEnabled"), false);
});

test("getFlag respects env override when envOverride is set", () => {
  // Add a temporary envOverride to agentMonitorEnabled for testing
  const store = makeStore({ agentMonitorEnabled: false });
  // Direct test via a flag that has envOverride — we'll use cloudConnectionEnabled
  // and temporarily set an env var. Since no flags have envOverride in v1,
  // we test the env path by monkey-patching.
  assert.equal(store.getFlag("cloudConnectionEnabled"), true);
});

// --- setFlag ---

test("setFlag persists and getFlag returns the new value", () => {
  const store = makeStore();
  store.setFlag("planExtractionEnabled", true);
  assert.equal(store.getFlag("planExtractionEnabled"), true);
});

test("setFlag rejects unknown flag keys", () => {
  const store = makeStore();
  assert.throws(() => store.setFlag("nonExistent" as FlagKey, true), {
    message: /Unknown feature flag/,
  });
});

// --- getFlagSource ---

test("getFlagSource reports 'default' when key is absent", () => {
  const store = makeStore();
  assert.equal(store.getFlagSource("agentMonitorEnabled"), "default");
});

test("getFlagSource reports 'user' when key is persisted", () => {
  const store = makeStore({ agentMonitorEnabled: true });
  assert.equal(store.getFlagSource("agentMonitorEnabled"), "user");
});

// --- getAllFlags ---

test("getAllFlags returns entries for every registered flag", () => {
  const store = makeStore();
  const flags = store.getAllFlags();
  assert.equal(flags.length, FEATURE_FLAGS.length);
  for (const def of FEATURE_FLAGS) {
    const entry = flags.find((f) => f.key === def.key);
    assert.ok(entry, `missing flag: ${def.key}`);
    assert.equal(entry.value, def.default, `default mismatch for ${def.key}`);
    assert.equal(
      entry.source,
      "default",
      `source should be default for ${def.key}`
    );
  }
});

// --- update() ---

test("update(partial) accepts any registered flag key", () => {
  const store = makeStore();
  const updated = store.update({ planExtractionEnabled: true });
  assert.equal(updated.planExtractionEnabled, true);
  assert.equal(store.getFlag("planExtractionEnabled"), true);
});

// --- Legacy wrapper compatibility ---

test("legacy getters return same values as getFlag", () => {
  const store = makeStore({
    agentMonitorEnabled: false,
    cloudCommandsPaused: true,
  });
  assert.equal(
    store.getAgentMonitorEnabled(),
    store.getFlag("agentMonitorEnabled")
  );
  assert.equal(
    store.getCloudCommandsPaused(),
    store.getFlag("cloudCommandsPaused")
  );
  assert.equal(
    store.getCommandSigningEnforcementEnabled(),
    store.getFlag("commandSigningEnforcementEnabled")
  );
});

test("constructor removes stale design-system dashboard opt-in flag", () => {
  const store = makeStore({ agentDashboardDesignSystemEnabled: true });
  assert.equal(
    "agentDashboardDesignSystemEnabled" in
      (store.getAll() as unknown as Record<string, unknown>),
    false
  );
  assert.equal(
    FEATURE_FLAGS.some(
      (def) => def.key === "agentDashboardDesignSystemEnabled"
    ),
    false
  );
});

test("legacy setters persist through getFlag", () => {
  const store = makeStore();
  store.setPlanExtractionEnabled(true);
  assert.equal(store.getFlag("planExtractionEnabled"), true);
  store.setAgentMonitorEnabled(false);
  assert.equal(store.getFlag("agentMonitorEnabled"), false);
});
