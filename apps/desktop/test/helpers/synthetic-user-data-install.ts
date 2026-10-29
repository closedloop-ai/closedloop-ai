/**
 * @file synthetic-user-data-install.ts
 * @description ISS-8955 — a throwaway stand-in for an installed app's live
 * userData profile, for the two suites that grade the migration's redirect
 * guard.
 *
 * Both of them need the same thing: an `<appData>/<legacy>` directory holding a
 * recognisable payload, somewhere no installed profile can be reached, plus the
 * cleanup that removes it. Sharing it here is what keeps the fixture from being
 * two copies that drift — and lets the legacy directory name come from the
 * production constant rather than a retyped `"ClosedLoop"` literal, so a rename
 * of that constant cannot leave the fixtures asserting against a name the
 * migration no longer looks for.
 *
 * Deliberately assertion-free: callers assert from their own case bodies, so no
 * expectation is buried in a helper a case could skip.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LEGACY_DESKTOP_USER_DATA_DIR_NAME } from "../../src/main/lifecycle/userdata-migration.js";

/**
 * The payload standing in for a real profile. Named after the store that makes
 * this defect expensive — the multi-GB local session database.
 */
export const LIVE_PROFILE_FILE = "agent-dashboard.sqlite";

/**
 * What `app.getName()` returns post-rename, i.e. the leaf of the DEFAULT
 * userData path.
 *
 * Restated here rather than imported from production on purpose: these suites
 * exist to catch the production value drifting, and a fixture that moved with it
 * could not. The production wire is pinned separately, by
 * `userdata-migration-wire.test.ts`.
 */
export const DEFAULT_USER_DATA_DIR_NAME = "Closedloop";

export type SyntheticInstall = {
  /** Stands in for Electron's `appData` — the parent of the default profile. */
  appData: string;
  /** The legacy profile directory, holding {@link LIVE_PROFILE_FILE}. */
  legacy: string;
  /** The `mkdtemp` root both of the above live under. */
  root: string;
};

/**
 * Create a synthetic install under a fresh temp root, registering that root in
 * `roots` for the caller's own cleanup hook.
 */
export function createSyntheticInstall(
  roots: string[],
  legacyDirName: string = LEGACY_DESKTOP_USER_DATA_DIR_NAME
): SyntheticInstall {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iss-8955-"));
  roots.push(root);
  const appData = path.join(root, "appdata");
  const legacy = path.join(appData, legacyDirName);
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(
    path.join(legacy, LIVE_PROFILE_FILE),
    "live profile contents"
  );
  return { appData, legacy, root };
}

/** Remove every root {@link createSyntheticInstall} registered. */
export function removeSyntheticInstalls(roots: string[]): void {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/**
 * What is left at `profileDir` — read here, asserted by the caller, so the
 * comparison below can be made against {@link INTACT_LIVE_PROFILE} in one line.
 */
export function liveProfileState(profileDir: string): {
  exists: boolean;
  entries: string[];
} {
  const exists = fs.existsSync(profileDir);
  return { exists, entries: exists ? fs.readdirSync(profileDir) : [] };
}

/** The state an untouched installed profile must still be in. */
export const INTACT_LIVE_PROFILE = {
  exists: true,
  entries: [LIVE_PROFILE_FILE],
};

/** The message every "was the profile moved?" assertion fails with. */
export const LIVE_PROFILE_MOVED =
  "the installed profile was moved out from under the running app";
