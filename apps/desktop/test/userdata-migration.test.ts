/**
 * @file userdata-migration.test.ts
 * @description Unit tests for the brand-rename (FEA-2101) userData directory
 * migration, src/main/userdata-migration.ts.
 *
 * Reviewed invariants: (1) on case-sensitive volumes where the legacy
 * `<appData>/ClosedLoop` and new `<appData>/Closedloop` paths are distinct and
 * only the legacy exists, the directory is renamed to the new path so persisted
 * data follows the app; (2) on case-insensitive volumes (default macOS) where
 * the two paths resolve to the SAME directory, nothing is moved — the existing
 * data is already the active userData; (3) a genuine fresh install at the new
 * path is never overwritten; (4) when no legacy dir exists, nothing happens. The
 * filesystem is fully injected so the tests are platform-independent.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  LEGACY_DESKTOP_USER_DATA_DIR_NAME,
  migrateLegacyUserDataDirectory,
} from "../src/main/userdata-migration.js";

const APP_DATA = "/home/user/.config";
const NEW_USER_DATA = path.join(APP_DATA, "Closedloop");
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
