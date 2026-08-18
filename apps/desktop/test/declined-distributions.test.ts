/**
 * FEA-4050: durable persistence of a declined org-distributed opt-in pack.
 *
 * Covers the SettingsStore side of the fix — the durable decline record that
 * lets the main-process reconcile suppress an already-declined pack across app
 * restarts (before this, the decline lived only in the banner's in-memory
 * `handledIds` and the reconcile re-pushed the pack on every launch).
 *
 * The restart is simulated the way the other settings-store tests do it:
 * construct a fresh `SettingsStore` over the SAME `cwd` (electron-store persists
 * to disk there), so the second instance reads what the first wrote — exactly
 * what happens when the desktop app is quit and relaunched.
 *
 * Behavior asserted (store/state, no logs, no timing):
 *   - decline a pack → it is persisted and reads back as declined;
 *   - simulate restart (fresh store over the same cwd) → still declined;
 *   - a genuinely-new/updated pack (different distribution id) is NOT declined;
 *   - a repeated decline upserts in place (no duplicate rows);
 *   - a fresh install reads an empty declined list (default).
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { SettingsStore } from "../src/main/settings/settings-store.js";
import { DEFAULT_DESKTOP_SETTINGS } from "../src/shared/contracts.js";

let tempRoot = "";

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "declined-distributions-test-")
  );
});

afterEach(async () => {
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

const STORE_NAME = "declined-distributions";

describe("FEA-4050: DEFAULT_DESKTOP_SETTINGS", () => {
  test("declinedDistributions defaults to an empty list", () => {
    assert.deepEqual(DEFAULT_DESKTOP_SETTINGS.declinedDistributions, []);
  });
});

describe("FEA-4050: SettingsStore declined-distribution persistence", () => {
  test("a fresh install reports no declines", () => {
    const store = new SettingsStore({ cwd: tempRoot, name: STORE_NAME });
    assert.deepEqual(store.getDeclinedDistributions(), []);
    assert.equal(store.isDistributionDeclined("dist-opt-001"), false);
  });

  test("recording a decline persists it and reads back as declined", () => {
    const store = new SettingsStore({ cwd: tempRoot, name: STORE_NAME });
    store.recordDeclinedDistribution({
      distributionId: "dist-opt-001",
      catalogItemId: "ci-opt-001",
      organizationId: "org-001",
      declinedAt: "2026-07-24T00:00:00.000Z",
    });

    assert.equal(store.isDistributionDeclined("dist-opt-001"), true);
    const declined = store.getDeclinedDistributions();
    assert.equal(declined.length, 1);
    assert.deepEqual(declined[0], {
      distributionId: "dist-opt-001",
      catalogItemId: "ci-opt-001",
      organizationId: "org-001",
      declinedAt: "2026-07-24T00:00:00.000Z",
    });
  });

  test("a declined pack STAYS declined across a simulated restart", () => {
    // First launch: user declines the pack.
    const first = new SettingsStore({ cwd: tempRoot, name: STORE_NAME });
    first.recordDeclinedDistribution({
      distributionId: "dist-opt-001",
      catalogItemId: "ci-opt-001",
      organizationId: "org-001",
    });
    assert.equal(first.isDistributionDeclined("dist-opt-001"), true);

    // Restart: a fresh store over the same on-disk cwd reads what launch 1 wrote.
    const afterRestart = new SettingsStore({ cwd: tempRoot, name: STORE_NAME });
    assert.equal(
      afterRestart.isDistributionDeclined("dist-opt-001"),
      true,
      "the declined pack must remain suppressed after restart"
    );
  });

  test("a genuinely-new offer (different distribution id) is NOT declined", () => {
    const store = new SettingsStore({ cwd: tempRoot, name: STORE_NAME });
    store.recordDeclinedDistribution({
      distributionId: "dist-opt-001",
      catalogItemId: "ci-opt-001",
      organizationId: "org-001",
    });

    // An admin re-share mints a NEW distribution id — it must not inherit the
    // old decline, even for the same catalog item + org.
    assert.equal(store.isDistributionDeclined("dist-opt-002"), false);
    const afterRestart = new SettingsStore({ cwd: tempRoot, name: STORE_NAME });
    assert.equal(afterRestart.isDistributionDeclined("dist-opt-002"), false);
  });

  test("re-declining the same distribution upserts in place (no duplicate rows)", () => {
    const store = new SettingsStore({ cwd: tempRoot, name: STORE_NAME });
    store.recordDeclinedDistribution({
      distributionId: "dist-opt-001",
      catalogItemId: "ci-opt-001",
      organizationId: "org-001",
      declinedAt: "2026-07-24T00:00:00.000Z",
    });
    store.recordDeclinedDistribution({
      distributionId: "dist-opt-001",
      catalogItemId: "ci-opt-001",
      organizationId: "org-001",
      declinedAt: "2026-07-25T00:00:00.000Z",
    });

    const declined = store.getDeclinedDistributions();
    assert.equal(declined.length, 1, "a repeat decline must not duplicate");
    assert.equal(
      declined[0].declinedAt,
      "2026-07-25T00:00:00.000Z",
      "the record is refreshed in place"
    );
  });

  test("multiple distinct declines accumulate independently", () => {
    const store = new SettingsStore({ cwd: tempRoot, name: STORE_NAME });
    store.recordDeclinedDistribution({
      distributionId: "dist-opt-001",
      catalogItemId: "ci-opt-001",
      organizationId: "org-001",
    });
    store.recordDeclinedDistribution({
      distributionId: "dist-opt-002",
      catalogItemId: "ci-opt-002",
      organizationId: "org-001",
    });

    assert.equal(store.isDistributionDeclined("dist-opt-001"), true);
    assert.equal(store.isDistributionDeclined("dist-opt-002"), true);
    assert.equal(store.getDeclinedDistributions().length, 2);
  });

  // FEA-4050: a distribution id is an org-level assignment shared across every
  // user/compute target. A decline recorded under one compute target must NOT
  // suppress the same distribution for a different compute target (profile /
  // account switch).
  test("a compute-target-scoped decline only suppresses that compute target", () => {
    const store = new SettingsStore({ cwd: tempRoot, name: STORE_NAME });
    store.recordDeclinedDistribution({
      distributionId: "dist-opt-001",
      catalogItemId: "ci-opt-001",
      organizationId: "org-001",
      computeTargetId: "ct-user-a",
    });

    // Same compute target → suppressed.
    assert.equal(
      store.isDistributionDeclined("dist-opt-001", "ct-user-a"),
      true
    );
    // Different compute target (another user/profile) → NOT suppressed.
    assert.equal(
      store.isDistributionDeclined("dist-opt-001", "ct-user-b"),
      false,
      "one profile's decline must not suppress another's offer"
    );
  });

  test("distinct compute targets keep separate decline records for the same distribution", () => {
    const store = new SettingsStore({ cwd: tempRoot, name: STORE_NAME });
    store.recordDeclinedDistribution({
      distributionId: "dist-opt-001",
      catalogItemId: "ci-opt-001",
      organizationId: "org-001",
      computeTargetId: "ct-user-a",
    });
    store.recordDeclinedDistribution({
      distributionId: "dist-opt-001",
      catalogItemId: "ci-opt-001",
      organizationId: "org-001",
      computeTargetId: "ct-user-b",
    });

    // Different compute targets do NOT upsert over each other.
    assert.equal(store.getDeclinedDistributions().length, 2);
    assert.equal(
      store.isDistributionDeclined("dist-opt-001", "ct-user-a"),
      true
    );
    assert.equal(
      store.isDistributionDeclined("dist-opt-001", "ct-user-b"),
      true
    );
  });

  // Legacy / offline id-only records carry no computeTargetId and must remain
  // installation-global so no decline persisted before the scope existed is lost.
  test("a legacy unscoped decline matches any compute target", () => {
    const store = new SettingsStore({ cwd: tempRoot, name: STORE_NAME });
    store.recordDeclinedDistribution({
      distributionId: "dist-opt-001",
      catalogItemId: "",
      organizationId: "",
    });

    assert.equal(
      store.isDistributionDeclined("dist-opt-001", "ct-anything"),
      true
    );
    assert.equal(store.isDistributionDeclined("dist-opt-001"), true);
  });
});
