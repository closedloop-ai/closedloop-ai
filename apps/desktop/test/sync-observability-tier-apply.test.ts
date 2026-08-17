/**
 * @file sync-observability-tier-apply.test.ts
 * @description FEA-4103 — the legacy `desktop:set-sync-observability-tier` IPC
 * must no longer set the consent tier in isolation. Its core
 * (`applySyncObservabilityTier`, the electron-free helper the IPC handler
 * delegates to after the trusted-sender gate) maps each legacy tier to its
 * canonical {@link DataSyncLevel} and routes it through the ONE canonical
 * `applyDataSyncLevel` write path, echoing the tier the caller sent so the wire
 * contract stays compatible with older renderers.
 *
 * Two invariants are proven here:
 *  1. the tier → level → applyDataSyncLevel wiring (each of the three tiers maps
 *     to the correct level, the response still echoes `{ tier }`, and the
 *     re-discovery notification fires); and
 *  2. because the shim now routes through the level, the legacy `local` tier
 *     intentionally tears down cloud connectivity (level `off` disables the
 *     connection) — the behavior change the review flagged, asserted end-to-end
 *     against a real SettingsStore driven by the same `dataSyncLevelToBooleans`
 *     derivation `applyDataSyncLevel` uses in app.ts.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { applySyncObservabilityTier } from "../src/main/ipc/sync-observability-tier-apply.js";
import { SettingsStore } from "../src/main/settings/settings-store.js";
import type { SyncObservabilityTier } from "../src/shared/contracts.js";
import { DataSyncLevel } from "../src/shared/contracts.js";
import { dataSyncLevelToBooleans } from "../src/shared/data-sync-level.js";

const tempDirs: string[] = [];
const INVALID_TIER_RE = /Invalid sync observability tier/;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const TIER_TO_LEVEL: ReadonlyArray<
  readonly [SyncObservabilityTier, DataSyncLevel]
> = [
  ["local", DataSyncLevel.Off],
  ["metadata", DataSyncLevel.Metadata],
  ["full", DataSyncLevel.Full],
];

test("FEA-4103: each legacy tier maps to its canonical level and echoes the tier", () => {
  for (const [tier, expectedLevel] of TIER_TO_LEVEL) {
    const appliedLevels: DataSyncLevel[] = [];
    let notifications = 0;
    const result = applySyncObservabilityTier(
      {
        applyDataSyncLevel: (level) => {
          appliedLevels.push(level);
        },
        onSyncObservabilityTierChanged: () => {
          notifications += 1;
        },
      },
      tier
    );
    assert.deepEqual(
      appliedLevels,
      [expectedLevel],
      `${tier} must route through applyDataSyncLevel exactly once with ${expectedLevel}`
    );
    assert.equal(
      notifications,
      1,
      `${tier} must fire the re-discovery notification`
    );
    assert.deepEqual(
      result,
      { tier },
      `${tier} response must still echo the caller's tier (wire-compatible)`
    );
  }
});

test("FEA-4103: an out-of-contract tier is rejected before any write", () => {
  let applyCalls = 0;
  assert.throws(
    () =>
      applySyncObservabilityTier(
        {
          applyDataSyncLevel: () => {
            applyCalls += 1;
          },
        },
        "everything"
      ),
    { message: INVALID_TIER_RE }
  );
  assert.equal(applyCalls, 0, "no level is written for an invalid tier");
});

test("FEA-4103: the optional re-discovery notification is skipped when not wired", () => {
  const appliedLevels: DataSyncLevel[] = [];
  const result = applySyncObservabilityTier(
    {
      applyDataSyncLevel: (level) => {
        appliedLevels.push(level);
      },
    },
    "full"
  );
  assert.deepEqual(appliedLevels, [DataSyncLevel.Full]);
  assert.deepEqual(result, { tier: "full" });
});

test("FEA-4103: the legacy `local` tier now tears down cloud connectivity via the level", () => {
  const store = new SettingsStore({
    cwd: makeTempDir("sync-tier-apply-"),
    name: "settings",
  });
  // Start connected (Metadata default → connection on).
  assert.equal(store.getCloudConnectionEnabled(), true);
  assert.equal(store.getDataSyncLevel(), DataSyncLevel.Metadata);

  // A faithful stand-in for app.ts's `applyDataSyncLevel`: persist the level and
  // reconcile the derived connectivity flags from the SAME derivation.
  const applyDataSyncLevel = (level: DataSyncLevel) => {
    const derived = dataSyncLevelToBooleans(level);
    store.setDataSyncLevel(level);
    store.setCloudConnectionEnabled(derived.cloudConnectionEnabled);
  };

  applySyncObservabilityTier({ applyDataSyncLevel }, "local");

  assert.equal(
    store.getDataSyncLevel(),
    DataSyncLevel.Off,
    "local collapses to the Off level"
  );
  assert.equal(
    store.getCloudConnectionEnabled(),
    false,
    "the Off level disables cloud connectivity — the tier can no longer desync it"
  );
  assert.equal(
    store.getSyncObservabilityTier(),
    "local",
    "setDataSyncLevel derives the tier field so the UI reads it back"
  );
});
