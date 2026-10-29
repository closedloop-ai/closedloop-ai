/**
 * @file userdata-migration.test.ts
 * @description Unit tests for the brand-rename (FEA-2101) userData directory
 * migration, src/main/lifecycle/userdata-migration.ts.
 *
 * Reviewed invariants: (1) on case-sensitive volumes where the legacy
 * `<appData>/ClosedLoop` and new `<appData>/Closedloop` paths are distinct and
 * only the legacy exists, the directory is renamed to the new path so persisted
 * data follows the app; (2) on case-insensitive volumes (default macOS) where
 * the two paths resolve to the SAME directory, nothing is moved — the existing
 * data is already the active userData; (3) a genuine fresh install at the new
 * path is never overwritten; (4) when no legacy dir exists, nothing happens.
 * These four inject the filesystem entirely, so they are platform-independent.
 *
 * (5) ISS-8955: an explicitly-redirected `userData` is never migrated INTO, on
 * any of the three target shapes. That block runs against a real filesystem
 * under `mkdtemp` — see its own comment for why a double cannot make the claim.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, test } from "vitest";
import {
  LEGACY_DESKTOP_USER_DATA_DIR_NAME,
  migrateLegacyUserDataDirectory,
} from "../src/main/lifecycle/userdata-migration.js";
import {
  createSyntheticInstall,
  DEFAULT_USER_DATA_DIR_NAME,
  INTACT_LIVE_PROFILE,
  LIVE_PROFILE_FILE,
  LIVE_PROFILE_MOVED,
  liveProfileState,
  removeSyntheticInstalls,
} from "./helpers/synthetic-user-data-install.js";

const APP_DATA = "/home/user/.config";
const NEW_USER_DATA = path.join(APP_DATA, DEFAULT_USER_DATA_DIR_NAME);
const LEGACY_USER_DATA = path.join(APP_DATA, LEGACY_DESKTOP_USER_DATA_DIR_NAME);

type Harness = {
  renames: Array<{ from: string; to: string }>;
  removed: string[];
  run: (
    existing: Set<string>,
    opts?: { sameFile?: boolean; emptyDirs?: Set<string> }
  ) => string;
};

function makeHarness(): Harness {
  const renames: Array<{ from: string; to: string }> = [];
  const removed: string[] = [];
  return {
    renames,
    removed,
    run(existing, opts = {}) {
      const { sameFile = false, emptyDirs = new Set<string>() } = opts;
      return migrateLegacyUserDataDirectory({
        appDataPath: APP_DATA,
        userDataPath: NEW_USER_DATA,
        appName: DEFAULT_USER_DATA_DIR_NAME,
        exists: (target) => existing.has(target),
        sameFile: () => sameFile,
        isEmptyDir: (target) => emptyDirs.has(target),
        removeEmptyDir: (target) => {
          removed.push(target);
          existing.delete(target);
        },
        rename: (from, to) => {
          renames.push({ from, to });
        },
      });
    },
  };
}

test("renames the legacy dir on case-sensitive volumes when only it exists", () => {
  const harness = makeHarness();
  const result = harness.run(new Set([LEGACY_USER_DATA]));
  assert.equal(result, "migrated");
  assert.deepEqual(harness.renames, [
    { from: LEGACY_USER_DATA, to: NEW_USER_DATA },
  ]);
});

test("does not move data on case-insensitive volumes (legacy and new are the same dir)", () => {
  const harness = makeHarness();
  // Both paths "exist" because they are the same directory entry, and sameFile
  // confirms it via dev/ino equality.
  const result = harness.run(new Set([LEGACY_USER_DATA, NEW_USER_DATA]), {
    sameFile: true,
  });
  assert.equal(result, "skipped-target-exists");
  assert.deepEqual(harness.renames, []);
  assert.deepEqual(harness.removed, []);
});

test("never overwrites a distinct new dir that already holds real data", () => {
  const harness = makeHarness();
  // Distinct dirs (sameFile=false), new dir is NOT empty → must not clobber.
  const result = harness.run(new Set([LEGACY_USER_DATA, NEW_USER_DATA]), {
    sameFile: false,
    emptyDirs: new Set(),
  });
  assert.equal(result, "skipped-target-has-data");
  assert.deepEqual(harness.renames, []);
  assert.deepEqual(harness.removed, []);
});

test("migrates legacy data into a distinct but EMPTY new dir (partial/fresh shell)", () => {
  const harness = makeHarness();
  // Case-sensitive volume or a prior failed launch created an empty <appData>/
  // Closedloop. Remove the empty shell and migrate the legacy data so the user
  // keeps their state instead of booting fresh.
  const result = harness.run(new Set([LEGACY_USER_DATA, NEW_USER_DATA]), {
    sameFile: false,
    emptyDirs: new Set([NEW_USER_DATA]),
  });
  assert.equal(result, "migrated-replaced-empty-target");
  assert.deepEqual(harness.removed, [NEW_USER_DATA]);
  assert.deepEqual(harness.renames, [
    { from: LEGACY_USER_DATA, to: NEW_USER_DATA },
  ]);
});

test("does nothing when there is no legacy directory", () => {
  const harness = makeHarness();
  const result = harness.run(new Set([NEW_USER_DATA]));
  assert.equal(result, "skipped-no-legacy-dir");
  assert.deepEqual(harness.renames, []);
});

test("does nothing on a clean install with neither directory present", () => {
  const harness = makeHarness();
  const result = harness.run(new Set());
  assert.equal(result, "skipped-no-legacy-dir");
  assert.deepEqual(harness.renames, []);
});

/**
 * ISS-8955 — the guard that stops a chosen profile being treated as a fresh
 * install to migrate INTO.
 *
 * Driven against a REAL filesystem, not the injected doubles above, because the
 * claim under test is about what survives on disk: the acceptance criterion is
 * that the source profile still exists and still holds its data, and a `rename`
 * double that only records its arguments cannot answer that. Everything here
 * lives under one `mkdtemp` root — the legacy directory is synthesized by the
 * test, so no installed profile is named, read, or reachable.
 *
 * The mutation each case kills is the removal of the redirect check: without it
 * the absent-target case renames the source away, the empty-target case rmdirs
 * and then renames it away, and the non-empty case reports the OTHER skip. The
 * last case matters because it is the branch that was already safe by accident
 * — it is what the e2e suite happens to hit, and on its own it proves nothing.
 */
describe("a redirected userData is never a migration target (ISS-8955)", () => {
  /** Distinct from "Closedloop" on case-INSENSITIVE volumes too, so the
   * positive control below grades the guard rather than the volume. */
  const DISTINCT_LEGACY_DIR_NAME = "PriorProfile";
  const roots: string[] = [];

  afterAll(() => {
    removeSyntheticInstalls(roots);
  });

  const makeInstall = (legacyDirName?: string) =>
    createSyntheticInstall(roots, legacyDirName);

  test("an ABSENT redirect target leaves the installed profile where it was", () => {
    const { appData, legacy, root } = makeInstall();
    const chosen = path.join(root, "chosen-profile");

    const result = migrateLegacyUserDataDirectory({
      appDataPath: appData,
      userDataPath: chosen,
      appName: DEFAULT_USER_DATA_DIR_NAME,
    });

    assert.deepEqual(
      liveProfileState(legacy),
      INTACT_LIVE_PROFILE,
      LIVE_PROFILE_MOVED
    );
    assert.equal(result, "skipped-user-data-redirected");
    assert.equal(
      fs.existsSync(chosen),
      false,
      "the migration created the chosen profile it was told to leave alone"
    );
  });

  test("an EMPTY redirect target is neither removed nor filled with the installed profile", () => {
    const { appData, legacy, root } = makeInstall();
    const chosen = path.join(root, "chosen-profile");
    fs.mkdirSync(chosen);

    const result = migrateLegacyUserDataDirectory({
      appDataPath: appData,
      userDataPath: chosen,
      appName: DEFAULT_USER_DATA_DIR_NAME,
    });

    assert.deepEqual(
      liveProfileState(legacy),
      INTACT_LIVE_PROFILE,
      LIVE_PROFILE_MOVED
    );
    assert.equal(result, "skipped-user-data-redirected");
    assert.deepEqual(
      fs.readdirSync(chosen),
      [],
      "the empty chosen profile was rmdir'd and replaced with the installed one"
    );
  });

  test("a NON-EMPTY redirect target is refused for being redirected, not merely for holding data", () => {
    const { appData, legacy, root } = makeInstall();
    const chosen = path.join(root, "chosen-profile");
    fs.mkdirSync(chosen);
    fs.writeFileSync(path.join(chosen, "desktop-settings.json"), "{}");

    const result = migrateLegacyUserDataDirectory({
      appDataPath: appData,
      userDataPath: chosen,
      appName: DEFAULT_USER_DATA_DIR_NAME,
    });

    // `skipped-target-has-data` here would mean the redirect check is gone and
    // this launch is safe only because something wrote into the target first.
    assert.equal(result, "skipped-user-data-redirected");
    assert.deepEqual(
      liveProfileState(legacy),
      INTACT_LIVE_PROFILE,
      LIVE_PROFILE_MOVED
    );
    assert.deepEqual(fs.readdirSync(chosen), ["desktop-settings.json"]);
  });

  test("a DEFAULT userData path still migrates, so the guard has not disabled the migration", () => {
    const { appData, legacy } = makeInstall(DISTINCT_LEGACY_DIR_NAME);
    const target = path.join(appData, DEFAULT_USER_DATA_DIR_NAME);

    const result = migrateLegacyUserDataDirectory({
      appDataPath: appData,
      userDataPath: target,
      appName: DEFAULT_USER_DATA_DIR_NAME,
      legacyDirName: DISTINCT_LEGACY_DIR_NAME,
    });

    assert.equal(result, "migrated");
    assert.equal(
      fs.existsSync(legacy),
      false,
      "the legacy directory was left behind, so nothing was migrated"
    );
    assert.deepEqual(fs.readdirSync(target), [LIVE_PROFILE_FILE]);
  });
});
