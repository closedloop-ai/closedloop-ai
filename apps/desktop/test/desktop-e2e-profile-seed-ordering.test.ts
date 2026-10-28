/**
 * @file desktop-e2e-profile-seed-ordering.test.ts
 * @description ISS-8955 — the desktop E2E launch profile, from the two angles
 * that together stop a harness run relocating the operator's installed profile.
 *
 * The reported defect: `--user-data-dir=<path>` redirects Electron's `userData`
 * but NOT its `appData`, so `migrateLegacyUserDataDirectory` saw the INSTALLED
 * app's directory as a legacy one and an absent-or-empty launch profile as the
 * fresh target to `renameSync` it into. On the machine it was measured on that
 * rename succeeds: APFS is case-insensitive, so the pre- and post-rename
 * spellings are one inode, and `/private/tmp` shares a device with `~/Library`,
 * so there is no `EXDEV` to stop it.
 *
 * `launchDesktopApp` escaped that by ACCIDENT: `seedE2eDesktopSettings` runs in
 * `beforeLaunch`, so its profile is non-empty by the time Electron starts and
 * the migration takes its one safe branch. Nothing asserted the ordering and
 * nothing said it mattered, so moving the seed after the launch would have
 * started moving whatever profile the runner had.
 *
 * Two claims, and the second is why the first is not the fix:
 *
 *   1. `launchDesktopApp` really does seed BEFORE the spawn. Read at spawn time
 *      through the `launchElectron` seam, because the launcher removes the
 *      profile again on teardown — by the time a case body could look, it is
 *      gone. Killed by moving the seed after the launch.
 *   2. `launchAuthenticatedDesktopApp` spawns against a profile holding ONLY
 *      what it seeded there itself — no installed or legacy state — and the
 *      real migration refuses that profile for being REDIRECTED rather than for
 *      holding data. So the ordering in claim 1 is a guarantee about layering,
 *      not about safety; the redirect guard is what makes an e2e launch
 *      harmless, on both launchers. Killed by removing that guard, which turns
 *      the refusal into `skipped-target-has-data`.
 *
 * ISS-10554 narrowed claim 2's precondition. This launcher used to seed nothing,
 * so the case could point the migration at a BYTE-EMPTY target — the strictest
 * input, since that is the branch that rmdirs the target and renames the live
 * profile into it. It now seeds the sync-consent answer its specs always meant
 * (`E2E_DESKTOP_SYNC_CONSENT_SEED`), because an ABSENT tier is what
 * `grandfatherConsentTier` reads as "never chose, infer from the live flags", so
 * the cloud read those specs assert was being inferred from evidence no user
 * supplied. The byte-empty target is not lost: `userdata-migration.test.ts` owns
 * all three target states — absent, empty, non-empty — against a directly
 * constructed profile, and its non-empty case is this exact discrimination. What
 * is only assertable HERE is the real launcher's real profile, so this case now
 * pins that profile's whole contents — its seed and nothing else — which is what
 * stops it going vacuous from either side.
 *
 * Nothing here spawns Electron, and the only `appData` any migration sees is one
 * this file created under `mkdtemp` — no installed profile is named or reached.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, test } from "vitest";
import { migrateLegacyUserDataDirectory } from "../src/main/lifecycle/userdata-migration.js";
import { E2E_FEATURE_FLAG_ASSIGNMENT_FILE } from "../src/shared/e2e-feature-flag-assignment-contract.js";
import { launchAuthenticatedDesktopApp } from "./e2e/helpers/authenticated-desktop-app.js";
import {
  DESKTOP_SETTINGS_FILE,
  type ElectronLauncher,
  launchDesktopApp,
  USER_DATA_DIR_ARG,
} from "./e2e/helpers/desktop-app.js";
import { E2E_DESKTOP_SYNC_CONSENT_SEED } from "./e2e/helpers/e2e-desktop-settings-seed.js";
import {
  createSyntheticInstall,
  DEFAULT_USER_DATA_DIR_NAME,
  INTACT_LIVE_PROFILE,
  LIVE_PROFILE_MOVED,
  liveProfileState,
  removeSyntheticInstalls,
} from "./helpers/synthetic-user-data-install.js";

const roots: string[] = [];

afterAll(() => {
  removeSyntheticInstalls(roots);
});

/** What the launcher's profile looked like at the moment Electron was spawned. */
type SpawnedProfile = {
  userDataDir: string;
  entries: string[];
  /** Parsed `desktop-settings.json`, or null when the launcher wrote none. */
  settings: unknown;
};

/**
 * A launcher that records the profile it was about to spawn against, then fails.
 *
 * Recorded, never asserted in here: an assertion inside an injected double is
 * one that can silently never run. Every case asserts from its own body, and
 * {@link onlyProfile} fails loudly if the launcher was never reached.
 *
 * For `launchDesktopApp` the read has to happen HERE: it creates the profile and
 * removes it on teardown, which runs before the rejection reaches the case body.
 * `launchAuthenticatedDesktopApp` removes nothing — the caller owns the profile,
 * which here is `roots` — so reading at spawn time there is about pinning what
 * Electron was actually spawned against, not about the directory's lifetime.
 */
function capturingLauncher(captured: SpawnedProfile[]): ElectronLauncher {
  return (launchOptions) => {
    const arg = (launchOptions?.args ?? []).find((value) =>
      value.startsWith(USER_DATA_DIR_ARG)
    );
    const userDataDir = arg?.slice(USER_DATA_DIR_ARG.length) ?? "";
    const settingsPath = path.join(userDataDir, DESKTOP_SETTINGS_FILE);
    captured.push({
      userDataDir,
      entries: fs.existsSync(userDataDir) ? fs.readdirSync(userDataDir) : [],
      settings: fs.existsSync(settingsPath)
        ? JSON.parse(fs.readFileSync(settingsPath, "utf8"))
        : null,
    });
    return Promise.reject(new Error("captured; no Electron was spawned"));
  };
}

function onlyProfile(captured: SpawnedProfile[]): SpawnedProfile {
  const [profile] = captured;
  if (captured.length !== 1 || !profile) {
    throw new Error(
      `the injected launcher should have been reached exactly once, saw ${captured.length}`
    );
  }
  if (profile.userDataDir === "") {
    throw new Error(
      `the launch carried no ${USER_DATA_DIR_ARG} argument, so it ran against the DEFAULT profile`
    );
  }
  return profile;
}

describe("the desktop e2e launch profile is never a migration target (ISS-8955)", () => {
  test("launchDesktopApp seeds the profile BEFORE Electron is spawned", async () => {
    const captured: SpawnedProfile[] = [];

    await assert.rejects(() =>
      launchDesktopApp({
        userDataPrefix: "iss-8955-seed-order-",
        launchElectron: capturingLauncher(captured),
      })
    );

    // The assignment file is one of the two `seedE2eDesktopSettings` writes, and
    // the one whose name has a canonical exported constant to check against.
    assert.ok(
      onlyProfile(captured).entries.includes(E2E_FEATURE_FLAG_ASSIGNMENT_FILE),
      "the launch profile was still unseeded when Electron was spawned, so the per-spec beforeLaunch has nothing to layer onto"
    );
  });

  test("the authenticated launcher spawns against a profile holding only its own seed, and the migration refuses it for being redirected", async () => {
    const captured: SpawnedProfile[] = [];
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "iss-8955-auth-udd-")
    );
    roots.push(userDataDir);

    // No `beforeLaunch`, which is exactly how every authenticated spec makes its
    // first launch (branch-details-timeline.spec.ts and fourteen others).
    await assert.rejects(() =>
      launchAuthenticatedDesktopApp({
        userDataDir,
        launchElectron: capturingLauncher(captured),
      })
    );

    const spawned = onlyProfile(captured);
    // The precondition, asserted rather than assumed, and from both sides.
    //
    // Nothing but the settings file: anything else in here would be state this
    // launcher did not put there, and the refusal below could then be about THAT
    // rather than about the redirect.
    assert.deepEqual(
      spawned.entries,
      [DESKTOP_SETTINGS_FILE],
      "the authenticated launcher spawned against a profile carrying state it did not seed, so the refusal below may not be the redirect guard's"
    );
    // And exactly its consent answer inside it: this is the only spawn-time read
    // of what ISS-10554 seeds, so a launcher that stopped STATING that answer —
    // silently returning those specs to inferring consent from the flags they
    // seed — fails HERE, and not eighteen Branches specs later.
    assert.deepEqual(
      spawned.settings,
      E2E_DESKTOP_SYNC_CONSENT_SEED,
      "the authenticated launcher's profile did not carry exactly its sync-consent seed when Electron was spawned"
    );

    const { appData, legacy } = createSyntheticInstall(roots);
    const result = migrateLegacyUserDataDirectory({
      appDataPath: appData,
      userDataPath: spawned.userDataDir,
      appName: DEFAULT_USER_DATA_DIR_NAME,
    });

    assert.deepEqual(
      liveProfileState(legacy),
      INTACT_LIVE_PROFILE,
      LIVE_PROFILE_MOVED
    );
    // `skipped-target-has-data` here would mean the redirect check is gone and
    // this launch is safe only because the launcher's own seed got there first.
    assert.equal(result, "skipped-user-data-redirected");
  });
});
