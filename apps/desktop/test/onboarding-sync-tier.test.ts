import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { SettingsStore } from "../src/main/settings/settings-store.js";
import { normalizeSyncObservabilityTier } from "../src/shared/sync-observability-tier.js";

const tempDirs: string[] = [];
const INVALID_TIER_RE = /Invalid sync observability tier/;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeStore(seed: Record<string, unknown> = {}): SettingsStore {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-tier-"));
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

// --- PRD-532 (M4): syncObservabilityTier setting ---

test("getSyncObservabilityTier defaults to null before the user chooses", () => {
  const store = makeStore();
  assert.equal(
    store.getSyncObservabilityTier(),
    null,
    "no tier is persisted until the onboarding sync-consent step runs"
  );
});

test("setSyncObservabilityTier round-trips each of the three tiers", () => {
  const store = makeStore();
  for (const tier of ["full", "metadata", "local"] as const) {
    store.setSyncObservabilityTier(tier);
    assert.equal(
      store.getSyncObservabilityTier(),
      tier,
      `${tier} must persist and read back`
    );
  }
});

test("getSyncObservabilityTier reads a persisted value from the store", () => {
  const store = makeStore({ syncObservabilityTier: "metadata" });
  assert.equal(store.getSyncObservabilityTier(), "metadata");
});

// --- PRD-532 (M4): normalizeSyncObservabilityTier server-side validation ---
//
// The `desktop:set-sync-observability-tier` IPC handler validates the
// renderer-supplied tier through this pure helper before persisting it. FEA-4103:
// the handler is now thin over the CANONICAL path — assertTrustedSender →
// normalize → syncObservabilityTierToDataSyncLevel → applyDataSyncLevel — so it
// can no longer set the tier in isolation. The store's `setSyncObservabilityTier`
// accessor (round-tripped below) stays a low-level primitive; testing the
// validator + that accessor separately keeps this suite free of the `electron`
// import that the IPC module pulls in.

test("normalizeSyncObservabilityTier accepts each of the three literals", () => {
  for (const tier of ["full", "metadata", "local"] as const) {
    assert.equal(normalizeSyncObservabilityTier(tier), tier);
  }
});

test("normalizeSyncObservabilityTier rejects an out-of-contract string", () => {
  assert.throws(() => normalizeSyncObservabilityTier("everything"), {
    message: INVALID_TIER_RE,
  });
});

test("normalizeSyncObservabilityTier rejects a non-string payload", () => {
  assert.throws(() => normalizeSyncObservabilityTier(42), {
    message: INVALID_TIER_RE,
  });
  assert.throws(() => normalizeSyncObservabilityTier(null), {
    message: INVALID_TIER_RE,
  });
});
