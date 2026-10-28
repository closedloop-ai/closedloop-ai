import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import { SettingsStore } from "../src/main/settings/settings-store.js";
import { syncTierAllowsSessionMetadata } from "../src/shared/contracts.js";
import { consentTierForOrg } from "../src/shared/sync-consent.js";
import { E2E_DESKTOP_SETTINGS_SEED } from "./e2e/helpers/e2e-desktop-settings-seed.js";

/**
 * The standard Electron-E2E settings seed, run through the REAL boot migrations.
 *
 * Every cloud-read spec depends on one non-obvious property of
 * `E2E_DESKTOP_SETTINGS_SEED`: it records a sync-consent answer
 * (`syncObservabilityTier: "full"`) while leaving the upload lanes shut
 * (`cloudConnectionEnabled: false`) and persisting no `dataSyncLevel`. That
 * combination is exactly the input `migrateDataSyncLevel` treats as a legacy
 * profile — it derives a level from the legacy flags and re-persists the derived
 * connectivity booleans — so whether the seeded consent survives boot is a
 * property of the migration, not of the seed alone. If it does not survive, the
 * launched app resolves every surface to the LOCAL read source and the cloud-read
 * specs pass against local data, for the wrong reason and without failing.
 *
 * These tests drive `SettingsStore` over a real store file on a temp dir, which
 * is the same constructor path the app takes at boot, and assert the consent
 * state a launched renderer would observe through `getSyncConsentRecord()`.
 *
 * Kept in a focused sibling of `settings-migration.test.ts` (already past the
 * 500-line smell) per `test/AGENTS.md`.
 */

/** electron-store `name` — the file is `<name>.json` in `cwd`. */
const STORE_NAME = "desktop-settings";

/** A spec signs into an org; the seed deliberately binds its answer to none. */
const SPEC_ORGANIZATION_ID = "org_e2e_spec";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the E2E seed's consent answer survives the boot migrations and permits a cloud read", () => {
  const store = bootStoreWithE2eSeed();

  const record = store.getSyncConsentRecord();
  assert.equal(
    record.tier,
    "full",
    "the seeded consent tier must survive the legacy-profile re-derivation"
  );
  assert.equal(
    record.bound,
    false,
    "the seed writes no syncConsentOrganizationId, so the answer stays unbound and covers any org"
  );

  // The same two predicates `resolveDesktopAppCoreMode` composes, so this asserts
  // the launched app's read source rather than a raw persisted value.
  assert.equal(
    syncTierAllowsSessionMetadata(
      consentTierForOrg(record, SPEC_ORGANIZATION_ID)
    ),
    true,
    "an authenticated, online spec must resolve to the cloud read source"
  );
});

test("the E2E seed keeps the upload lanes shut after the boot migrations", () => {
  const store = bootStoreWithE2eSeed();

  assert.equal(
    store.getFlag("cloudConnectionEnabled"),
    false,
    "the seed permits the cloud READ; it must not open the upload connection"
  );
  assert.equal(
    store.getFlag("transcriptSyncEnabled"),
    false,
    "no transcript lane may open from a seed that never asked for one"
  );
  // The level the migration derives from `cloudConnectionEnabled: false`. Pinned
  // because it is the value the Data & Sync tab renders: a seed whose recorded
  // consent and displayed level disagreed about egress would be the defect.
  assert.equal(store.getDataSyncLevel(), "off");
});

/**
 * A SECOND launch against the same profile — the `userDataDir` reuse flow — now
 * reads a persisted `dataSyncLevel`, which takes `migrateDataSyncLevel`'s early
 * return instead of the legacy-profile path. Both paths must leave the answer
 * alone, or a spec that seeds, closes, and relaunches would silently drop to the
 * local read source on the launch that matters.
 */
test("relaunching against the migrated profile leaves the consent answer intact", () => {
  const userDataDir = makeUserDataDir();
  writeE2eSeed(userDataDir);
  new SettingsStore({ cwd: userDataDir, name: STORE_NAME });

  const relaunched = new SettingsStore({ cwd: userDataDir, name: STORE_NAME });
  assert.equal(relaunched.getSyncConsentRecord().tier, "full");
  assert.equal(relaunched.getFlag("cloudConnectionEnabled"), false);
});

/**
 * The negative half: the guard under test is key ABSENCE, not a null read. An
 * explicit `null` is the SyncConsent UI's "not consented yet", and grandfathering
 * a tier over it would manufacture consent nobody gave — so the same seed shape
 * with a null tier must stay null and hold the reader local.
 */
test("an explicitly null tier is not grandfathered into consent by the same seed shape", () => {
  const userDataDir = makeUserDataDir();
  writeSettings(userDataDir, {
    ...E2E_DESKTOP_SETTINGS_SEED,
    syncObservabilityTier: null,
  });
  const store = new SettingsStore({ cwd: userDataDir, name: STORE_NAME });

  const record = store.getSyncConsentRecord();
  assert.equal(record.tier, null);
  assert.equal(
    syncTierAllowsSessionMetadata(
      consentTierForOrg(record, SPEC_ORGANIZATION_ID)
    ),
    false
  );
});

function makeUserDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-seed-consent-"));
  tempDirs.push(dir);
  return dir;
}

function writeSettings(
  userDataDir: string,
  settings: Record<string, unknown>
): void {
  fs.writeFileSync(
    path.join(userDataDir, `${STORE_NAME}.json`),
    JSON.stringify(settings),
    "utf8"
  );
}

function writeE2eSeed(userDataDir: string): void {
  writeSettings(userDataDir, E2E_DESKTOP_SETTINGS_SEED);
}

/** Write the seed to a fresh profile and run the boot migrations over it. */
function bootStoreWithE2eSeed(): SettingsStore {
  const userDataDir = makeUserDataDir();
  writeE2eSeed(userDataDir);
  return new SettingsStore({ cwd: userDataDir, name: STORE_NAME });
}
