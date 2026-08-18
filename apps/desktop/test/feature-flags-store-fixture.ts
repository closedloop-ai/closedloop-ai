import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SettingsStore } from "../src/main/settings/settings-store.js";
import { FEATURE_FLAGS } from "../src/shared/feature-flags.js";

/**
 * Shared `SettingsStore` fixture for the desktop feature-flag registry suites.
 *
 * Extracted when `feature-flags.test.ts` crossed the 1,000-line ceiling and the
 * cross-surface parity guards (ISS-4866) and the shared web+desktop UI-flag
 * family (ISS-4898) each moved to their own file: every one of those suites
 * needs an isolated on-disk store per test, and a second copy of this helper is
 * exactly the duplication AGENTS.md forbids. The registry is append-only, so
 * these files only grow — the seam is per-responsibility, not per-line-count.
 */

const tempDirs: string[] = [];

/**
 * A `SettingsStore` backed by a throwaway temp dir, optionally pre-seeded with
 * persisted flag values. Every directory is tracked for
 * {@link cleanupFeatureFlagStores}.
 */
export function makeFeatureFlagStore(
  seed: Record<string, unknown> = {}
): SettingsStore {
  return openFeatureFlagStore(makeFeatureFlagStoreDir(seed));
}

/**
 * Remove every store directory created since the last call and clear any env
 * override a test set. Call from the suite's `afterEach` — `splice(0)` drains
 * the list, so a failed removal cannot make the next teardown retry a stale
 * path.
 */
export function cleanupFeatureFlagStores(): void {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  for (const def of FEATURE_FLAGS) {
    if (def.envOverride) {
      delete process.env[def.envOverride];
    }
  }
}

/** The on-disk store name every fixture store uses. */
const STORE_NAME = "test-settings";

/**
 * A throwaway store DIRECTORY, optionally pre-seeded with persisted values, and
 * tracked for {@link cleanupFeatureFlagStores}. Split out of
 * {@link makeFeatureFlagStore} so a test can open the same directory twice — the
 * in-process equivalent of restarting the app, which is the only way to observe
 * that a boot migration does (or does not) survive its own second run.
 */
export function makeFeatureFlagStoreDir(
  seed: Record<string, unknown> = {}
): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "feature-flags-"));
  tempDirs.push(tmpDir);
  if (Object.keys(seed).length > 0) {
    fs.writeFileSync(
      path.join(tmpDir, `${STORE_NAME}.json`),
      JSON.stringify(seed)
    );
  }
  return tmpDir;
}

/**
 * Open a `SettingsStore` over a directory from {@link makeFeatureFlagStoreDir}.
 * Constructing a second one over the same directory re-runs the boot migrations
 * against whatever the first instance persisted, i.e. simulates a relaunch.
 */
export function openFeatureFlagStore(dir: string): SettingsStore {
  return new SettingsStore({ cwd: dir, name: STORE_NAME });
}
