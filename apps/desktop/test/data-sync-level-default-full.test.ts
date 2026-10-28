import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import type { SettingsMigrationTarget } from "../src/main/settings/settings-migrations.js";
import { runSettingsMigrations } from "../src/main/settings/settings-migrations.js";
import { SettingsStore } from "../src/main/settings/settings-store.js";
import { DEFAULT_DESKTOP_SETTINGS } from "../src/shared/contracts.js";

/** The stand-in target's crash marker — hoisted per `useTopLevelRegex`. */
const SIMULATED_CRASH = /simulated crash/;

/**
 * ISS-10554 — a NEW install defaults to full sync, and no EXISTING install is
 * widened to get there.
 *
 * Every expected level here is written as a bare string literal rather than read
 * from `DataSyncLevel` / `RECOMMENDED_DATA_SYNC_LEVEL`: the whole subject of these
 * tests is which level the store settles on, so an expectation imported from the
 * constant that decides it would agree with any change to that constant.
 *
 * Kept out of `settings-migration.test.ts`, which is already past the 500-line
 * smell, per `test/AGENTS.md`.
 */

const STORE_NAME = "desktop-settings";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeStoreDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iss10554-"));
  tempDirs.push(dir);
  return dir;
}

function seedStoreFile(dir: string, contents: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(dir, `${STORE_NAME}.json`),
    JSON.stringify(contents)
  );
}

function readStoreFile(dir: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(dir, `${STORE_NAME}.json`), "utf8")
  ) as Record<string, unknown>;
}

test("ISS-10554: a first launch (nothing ever persisted) settles on full", () => {
  const dir = makeStoreDir();

  const store = new SettingsStore({ cwd: dir, name: STORE_NAME });

  assert.equal(store.getDataSyncLevel(), "full");
  assert.equal(store.getAll().dataSyncLevel, "full");
});

test("ISS-10554: the first-launch seed grants NO consent", () => {
  const dir = makeStoreDir();

  const store = new SettingsStore({ cwd: dir, name: STORE_NAME });

  assert.equal(
    store.getSyncObservabilityTier(),
    null,
    "the consent VALUE is what every gate reads, and it must be not-consented"
  );
  // The key is written, as an explicit null. Absence is the signal every build —
  // including an older one that cannot know about this seed — reads as "never
  // chose, infer from behavior", and the seeded transcript flag is exactly the
  // behavior `grandfatherConsentTier` would read as a full-sync grant.
  assert.equal(store.hasSyncObservabilityTierBeenSet(), true);
  assert.equal(readStoreFile(dir).syncObservabilityTier, null);
});

test("ISS-10554: a second boot of a seeded install does not grandfather a consent tier", () => {
  const dir = makeStoreDir();

  new SettingsStore({ cwd: dir, name: STORE_NAME });
  const secondBoot = new SettingsStore({ cwd: dir, name: STORE_NAME });

  assert.equal(
    secondBoot.getSyncObservabilityTier(),
    null,
    "the seeded transcript flag must not be read back as evidence the user consented to full sync"
  );
  assert.equal(secondBoot.getDataSyncLevel(), "full");
});

/**
 * The consent contract: a store that already carries a level keeps it, whichever
 * one it is. A single-fixture test here could not tell a per-install migration
 * from a blanket overwrite, so every persisted level gets its own row, each
 * written as the install would really hold it (level plus the booleans
 * `setDataSyncLevel` derives for it).
 */
const EXISTING_INSTALLS = [
  {
    level: "off",
    persisted: {
      dataSyncLevel: "off",
      cloudConnectionEnabled: false,
      cloudCommandsPaused: true,
      transcriptSyncEnabled: false,
      syncObservabilityTier: "local",
    },
  },
  {
    level: "metadata",
    persisted: {
      dataSyncLevel: "metadata",
      cloudConnectionEnabled: true,
      cloudCommandsPaused: false,
      transcriptSyncEnabled: false,
      syncObservabilityTier: "metadata",
    },
  },
  {
    level: "redacted",
    persisted: {
      dataSyncLevel: "redacted",
      cloudConnectionEnabled: true,
      cloudCommandsPaused: false,
      transcriptSyncEnabled: false,
      syncObservabilityTier: "metadata",
    },
  },
  {
    level: "full",
    persisted: {
      dataSyncLevel: "full",
      cloudConnectionEnabled: true,
      cloudCommandsPaused: false,
      transcriptSyncEnabled: true,
      syncObservabilityTier: "full",
    },
  },
] as const;

for (const install of EXISTING_INSTALLS) {
  test(`ISS-10554: an existing install on ${install.level} is left on ${install.level}`, () => {
    const dir = makeStoreDir();
    seedStoreFile(dir, install.persisted);

    const store = new SettingsStore({ cwd: dir, name: STORE_NAME });

    assert.equal(store.getDataSyncLevel(), install.level);
    assert.equal(store.getAll().dataSyncLevel, install.level);
    assert.equal(
      readStoreFile(dir).dataSyncLevel,
      install.level,
      "the persisted choice itself must survive the boot migration"
    );
  });
}

test("ISS-10554: an existing install that never chose is not widened to full", () => {
  const dir = makeStoreDir();
  // Booted before (it carries the saved-config keys every first boot writes) but
  // never touched sync and never finished onboarding: no level, no legacy
  // connectivity flags, no consent tier. It chose nothing, so the new default
  // must not choose for it.
  seedStoreFile(dir, {
    dataSyncLevel: null,
    savedConfigs: [],
    activeConfigId: null,
  });

  const store = new SettingsStore({ cwd: dir, name: STORE_NAME });

  assert.equal(store.getDataSyncLevel(), "metadata");
  assert.equal(store.getAll().dataSyncLevel, "metadata");
  assert.equal(store.hasSyncObservabilityTierBeenSet(), true);
  assert.equal(store.getSyncObservabilityTier(), null);
});

test("ISS-10554: an existing legacy install reconciles from its flags, not from the new default", () => {
  const dir = makeStoreDir();
  // Pre-FEA-3907: connected, transcripts off, no level and no tier ever written.
  seedStoreFile(dir, {
    cloudConnectionEnabled: true,
    transcriptSyncEnabled: false,
  });

  const store = new SettingsStore({ cwd: dir, name: STORE_NAME });

  assert.equal(store.getDataSyncLevel(), "metadata");
  assert.equal(
    store.getSyncObservabilityTier(),
    null,
    "legacy flags preserve the effective level but never imply an explicit choice"
  );
});

test("ISS-10554: an out-of-domain persisted level falls back to the flag derivation, not to full", () => {
  const dir = makeStoreDir();
  // A downgrade from a newer build: a level string this build has no mapping for.
  seedStoreFile(dir, {
    dataSyncLevel: "ultra",
    cloudConnectionEnabled: true,
    transcriptSyncEnabled: false,
    syncObservabilityTier: "metadata",
  });

  const store = new SettingsStore({ cwd: dir, name: STORE_NAME });

  assert.equal(store.getDataSyncLevel(), "metadata");
});

test("ISS-10554: the declared DesktopSettings default states full sync", () => {
  // The literal is deliberate: reading the expectation from
  // `RECOMMENDED_DATA_SYNC_LEVEL` would let this agree with any change to it.
  assert.equal(DEFAULT_DESKTOP_SETTINGS.dataSyncLevel, "full");
});

/**
 * The seed writes the level, its marker, and its derived flags in ONE store
 * write. electron-store persists the whole config file per `set`, so separate
 * calls can be torn by a crash — and a tear that landed the level WITHOUT the
 * marker leaves the next boot reading the seeded transcript flag as legacy
 * evidence and grandfathering a `full` consent tier nobody agreed to.
 *
 * Driven through `runSettingsMigrations` (the production entry point) against a
 * recording target, because that is the only way to observe write GROUPING —
 * the resulting store file looks identical either way.
 */
function makeRecordingTarget(options?: {
  /**
   * Simulate a crash: the first `set` whose payload this returns true for LANDS,
   * and then the process dies. Landing it first is the faithful and the dangerous
   * model — electron-store persists the whole config file synchronously per `set`,
   * so a killed process leaves every completed write on disk, and it is precisely
   * a survivor that carries an unrelated key but not the seed that makes the next
   * boot stop looking like a first launch.
   */
  readonly crashOnWrite?: (values: Record<string, unknown>) => boolean;
}): {
  target: SettingsMigrationTarget;
  writes: Record<string, unknown>[];
  backing: Record<string, unknown>;
} {
  const backing: Record<string, unknown> = {};
  const writes: Record<string, unknown>[] = [];
  const record = (values: Record<string, unknown>) => {
    writes.push(values);
    Object.assign(backing, values);
    if (options?.crashOnWrite?.(values)) {
      throw new Error("simulated crash mid-migration");
    }
  };
  const rawStore = {
    get store() {
      return { ...backing };
    },
    get(key: string, defaultValue?: unknown) {
      return key in backing ? backing[key] : defaultValue;
    },
    set(keyOrValues: string | Record<string, unknown>, value?: unknown) {
      if (typeof keyOrValues === "string") {
        record({ [keyOrValues]: value });
        return;
      }
      record(keyOrValues);
    },
    delete(key: string) {
      Reflect.deleteProperty(backing, key);
    },
  };
  const target = {
    rawStore,
    getFlag: (key: string) =>
      (key in backing
        ? backing[key]
        : DEFAULT_DESKTOP_SETTINGS[
            key as keyof typeof DEFAULT_DESKTOP_SETTINGS
          ]) === true,
    setFlag: (key: string, flagValue: boolean) => record({ [key]: flagValue }),
    getFlagSource: (key: string) => (key in backing ? "user" : "default"),
    getSyncObservabilityTier: () => null,
    getSavedConfigs: () => [],
    setSavedConfigs: () => {
      // The saved-config migration is not under test here.
    },
  } as unknown as SettingsMigrationTarget;
  return { target, writes, backing };
}

test("ISS-10554: the first-launch seed is one atomic store write", () => {
  const { target, writes } = makeRecordingTarget();

  runSettingsMigrations(target);

  const levelWrites = writes.filter((w) => "dataSyncLevel" in w);
  assert.equal(levelWrites.length, 1, "the level must be written exactly once");
  const seedWrite = levelWrites[0];
  assert.equal(seedWrite.dataSyncLevel, "full");
  assert.equal(
    "syncObservabilityTier" in seedWrite &&
      seedWrite.syncObservabilityTier === null,
    true,
    "the explicit not-consented tier must ride the SAME write as the level — a torn seed grandfathers a consent tier nobody agreed to"
  );
  assert.equal(
    seedWrite.transcriptSyncEnabled,
    true,
    "the derived transcript flag must ride the same write as the level it derives from"
  );
  assert.equal(
    writes.some((w) => w.syncObservabilityTier != null),
    false,
    "the seed must never write a non-null consent tier"
  );
});

/**
 * davetho (PR #7567) — the crash window. The seed is not merely ordered before
 * the other migrations for tidiness: several of them write unconditionally on a
 * first launch (`removeRetiredKeys` sets `agentCollaborationNetworkResidueCleared`),
 * and a process killed between such a write and the seed would boot next time into
 * a store that is no longer empty. `firstLaunch` would then be false forever, the
 * seed would never run, and the install would reconcile down to the metadata floor
 * — the new-install default lost permanently, to a crash, with nothing to say so.
 *
 * Driven through `runSettingsMigrations`, the production entry point, and asserted
 * on the surviving state rather than on the call order, so it pins the property
 * (the default survives an interrupted first launch) and not the implementation.
 */
const isSeedWrite = (values: Record<string, unknown>): boolean =>
  "dataSyncLevel" in values;

test("ISS-10554: a first launch interrupted by a crash has already persisted the seed", () => {
  const { target, backing } = makeRecordingTarget({
    crashOnWrite: (values) => !isSeedWrite(values),
  });

  assert.throws(() => runSettingsMigrations(target), SIMULATED_CRASH);

  assert.equal(
    backing.dataSyncLevel,
    "full",
    "the seed must land before any other migration can persist a key"
  );
  assert.equal(
    backing.agentCollaborationNetworkResidueCleared,
    true,
    "and the crash must really have been taken after an unrelated key was persisted, or this case proves nothing"
  );
  assert.equal(backing.syncObservabilityTier, null);
  assert.equal("syncObservabilityTier" in backing, true);
});

test("ISS-10554: restarting after an interrupted first launch still settles on full", () => {
  const { target, backing } = makeRecordingTarget({
    crashOnWrite: (values) => !isSeedWrite(values),
  });
  assert.throws(() => runSettingsMigrations(target), SIMULATED_CRASH);

  // Exactly what the killed process left on disk — every `set` before the crash,
  // and nothing after it.
  const dir = makeStoreDir();
  assert.equal(
    Object.keys(backing).length > 0,
    true,
    "the survivor must be non-empty — an empty one would boot as a fresh first launch and prove nothing"
  );
  seedStoreFile(dir, backing);

  const restarted = new SettingsStore({ cwd: dir, name: STORE_NAME });

  assert.equal(
    restarted.getDataSyncLevel(),
    "full",
    "a crash during the first launch must not downgrade the install to the metadata floor"
  );
  assert.equal(restarted.getAll().dataSyncLevel, "full");
  assert.equal(
    restarted.getSyncObservabilityTier(),
    null,
    "and the restart must still not manufacture consent"
  );
});
