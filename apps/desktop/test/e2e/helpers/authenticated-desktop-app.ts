/**
 * The authenticated Desktop E2E launcher.
 *
 * Split out of `branch-details-authenticated-cloud.ts` (ISS-6929) so the
 * main-process test lane can import it: that module reaches the repo-root
 * `e2e/helpers/` fixtures and `@repo/api` subpaths, which resolve only under the
 * Playwright runner, so nothing in it could be driven by a behavioral test. The
 * launcher itself needs none of that — only the shared harness next door — and
 * an Electron process it can orphan is behavior, not structure.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ElectronApplication, Page } from "@playwright/test";
import type { DesktopSessionRecord } from "../../../src/main/session/desktop-session-store.js";
import { DEV_UPDATE_CHECK_DISABLED_ENV } from "../../../src/main/update/dev-update-check-gate.js";
import {
  DASHBOARD_FLAG_SET,
  dashboardOnboardedStorageKey,
  dashboardTourSeenStorageKey,
} from "../../../src/renderer/components/dashboard/dashboard-storage-keys";
import type { CloudReadReadinessSnapshot } from "../../../src/shared/cloud-read-readiness-contract.js";
import { isolatedHarnessHomes } from "../../helpers/isolated-harness-homes";
import {
  cloudReadReadinessEnv,
  cloudReadReadinessLaunchArgs,
  cloudSyncProgressEnv,
  discardPartialLaunch,
  type E2eCloudSyncProgress,
  type ElectronLauncher,
  e2eAppLaunchArgs,
  launchGuardedElectronApp,
  MAIN_JS,
  RETURNING_INSTALL_LOCAL_STORAGE_SEED,
  seedDesktopSettingsDefaults,
  USER_DATA_DIR_ARG,
} from "./desktop-app";
import { E2E_DESKTOP_SYNC_CONSENT_SEED } from "./e2e-desktop-settings-seed";
import {
  gatewayListenGateEnv,
  gatewayListenGateLaunchArgs,
} from "./gateway-listen-gate";
import {
  assertReturningInstallSeed,
  returningInstallSeedEnv,
  returningInstallSeedLaunchArgs,
} from "./returning-install-seed";
import { prepareSameProcessAuthSeed } from "./same-process-auth-seed";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Launched Electron state needed by the authenticated Branch E2E fixture. */
export type AuthenticatedDesktopApp = {
  app: ElectronApplication;
  cleanup: () => Promise<void>;
  page: Page;
  pageErrors: Error[];
};

/** Inputs for an isolated authenticated Desktop fixture launch. */
export type AuthenticatedDesktopLaunchOptions = {
  beforeLaunch?: (userDataDir: string) => void;
  env?: Record<string, string>;
  userDataDir: string;
  /** Opt in a seeded returning-local subject; fresh authenticated fixtures keep first-run behavior. */
  returningInstall?: boolean;
  /** Seed only the two original Dashboard completion flags in the first app frame. */
  seedDashboardStorage?: boolean;
  /** Opt in fixture-only encrypted session seeding before production boot restore. */
  sameProcessSessionSeed?: DesktopSessionRecord;
  /**
   * App-level arguments placed after the standard e2e ones. ISS-12017: the
   * vibe walk passes the arguments `vibe:profile launch-env` prints for its
   * seeded profile.
   */
  appArgs?: readonly string[];
  /**
   * The collector-home root to use instead of a fresh `mkdtemp` one; still
   * removed on `cleanup()`. `launchDesktopApp` takes the same option. ISS-11634:
   * the control skill picks the path up front so it can record it for crash
   * cleanup.
   */
  harnessHomesRoot?: string;
  /**
   * ISS-5768: pin the readiness snapshot the runtime-status payload carries, so
   * the Settings → History Sync cell and the startup panel have a DETERMINISTIC
   * backlog to render — the production sampler cannot answer inside a spec's
   * lifetime (see `cloudReadReadinessLaunchArgs`).
   *
   * ISS-6972: this does not influence which store a surface reads — the read
   * source is authenticated + online.
   */
  cloudReadReadiness?: CloudReadReadinessSnapshot;
  /**
   * ISS-5489 (PLN-1694 M2): the `cloudSync` half of the runtime-status payload.
   * A spec asserting anything the SESSION lanes report — counts, a progress bar,
   * a drained claim — needs it, because `identified` is true only while the
   * cloud socket is up with a compute target, which no E2E fixture stands up.
   * Without it those surfaces can only ever render their unmeasured state, and
   * the runtime-status → preload → poller chain goes unexercised.
   *
   * ISS-9184: the FIRST sample, not a fixed one — a spec whose subject is a
   * CHANGE in this field replaces it mid-run with `pushCloudSyncProgress`
   * (`cloud-sync-progress-control.ts`).
   */
  cloudSyncProgress?: E2eCloudSyncProgress;
  /**
   * ISS-6929: the Electron launcher. Defaults to Playwright's
   * `_electron.launch`, and no spec overrides it — the seam exists so
   * `desktop-app-partial-launch.test.ts` can drive this launcher's teardown
   * against a REAL spawned process without a real Electron build.
   */
  launchElectron?: ElectronLauncher;
  /**
   * Reveal the window, for a spec whose subject is the window coming forward.
   * `launchDesktopApp` takes the same option; every other spec leaves it off.
   */
  revealWindow?: boolean;
};

/**
 * Launches the authenticated fixture with a deterministic Linux safeStorage
 * backend. Headless CI cannot expose a usable OS secret key to Electron, so a
 * test-only preload enables Electron's documented basic backend before the
 * production app restores its session; macOS and Windows keep native storage.
 *
 * The profile dir is NOT this launcher's to remove — unlike `launchDesktopApp`
 * it never creates one: every caller passes a `userDataDir` it made itself and
 * removes in its own outer `finally`. Its `afterClose` therefore removes only
 * the collector-home root it DID create (ISS-7731), and a partial launch tears
 * down the Electron process and those homes, never the caller's profile.
 */
export async function launchAuthenticatedDesktopApp({
  appArgs = [],
  beforeLaunch,
  cloudReadReadiness,
  env,
  userDataDir,
  harnessHomesRoot: requestedHarnessHomesRoot,
  cloudSyncProgress,
  launchElectron,
  revealWindow = false,
  returningInstall = false,
  seedDashboardStorage = false,
  sameProcessSessionSeed,
}: AuthenticatedDesktopLaunchOptions): Promise<AuthenticatedDesktopApp> {
  if (returningInstall && seedDashboardStorage) {
    throw new Error("Choose one authenticated first-frame storage seed");
  }
  const keepFirstRunState = !(returningInstall || seedDashboardStorage);
  const storageSeed = seedDashboardStorage
    ? dashboardCompletedStorageSeed
    : returningDashboardSeed;
  fs.mkdirSync(userDataDir, { recursive: true });
  // ISS-7731: same default-on collector-home isolation as `launchDesktopApp`.
  // This launcher creates no profile, but the harness homes ARE its own, so it
  // takes an `afterClose` purely to remove them.
  const harnessHomesRoot =
    requestedHarnessHomesRoot ??
    fs.mkdtempSync(path.join(os.tmpdir(), "desktop-e2e-auth-homes-"));
  const authSeedPreload =
    sameProcessSessionSeed === undefined
      ? undefined
      : path.join(harnessHomesRoot, "same-process-auth-seed.cjs");
  const linuxSafeStorageArgs =
    process.platform === "linux"
      ? [
          "-r",
          path.join(__dirname, "linux-safe-storage-preload.cjs"),
          "--password-store=basic",
        ]
      : [];

  const { app, page, pageErrors, cleanup } = await launchGuardedElectronApp({
    // Chromium switches must precede Electron's app entrypoint. After MAIN_JS
    // they are application arguments and do not select the Linux password store.
    args: [
      ...returningInstallSeedLaunchArgs(keepFirstRunState),
      ...linuxSafeStorageArgs,
      ...(authSeedPreload === undefined ? [] : ["-r", authSeedPreload]),
      ...gatewayListenGateLaunchArgs(),
      ...cloudReadReadinessLaunchArgs(cloudReadReadiness),
      MAIN_JS,
      `${USER_DATA_DIR_ARG}${userDataDir}`,
      ...e2eAppLaunchArgs(revealWindow),
      ...appArgs,
    ],
    env: {
      ...process.env,
      ...cloudReadReadinessEnv(cloudReadReadiness),
      ...cloudSyncProgressEnv(cloudSyncProgress),
      ...gatewayListenGateEnv(false, userDataDir),
      CLOSEDLOOP_DISABLE_AUTO_UPDATE: "1",
      // ISS-12843: argued in `desktop-app.ts`'s copy of this layer.
      [DEV_UPDATE_CHECK_DISABLED_ENV]: "1",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      OTEL_SDK_DISABLED: "1",
      // ISS-7731 — above `...process.env` so an unpinned home cannot fall back
      // to `os.homedir()`, below `...env` so a spec's seeded corpus still wins.
      // Argued once in `desktop-app.ts`'s copy of this layer.
      ...isolatedHarnessHomes(harnessHomesRoot),
      ...env,
      ...returningInstallSeedEnv(keepFirstRunState, storageSeed),
    },
    launchElectron,
    beforeLaunch: () => {
      // ISS-10554: STATE this profile's consent answer rather than leaving the
      // new-install seed's explicit not-consented `null` to stand in for one.
      // It no longer decides the READ source — that stopped consulting consent
      // on 2026-09-25 — but it is still the tier the egress lanes, the Settings
      // sync panel and the onboarding takeover all read, and a launcher that
      // left it unanswered would put every authenticated spec on a device
      // mid-onboarding.
      //
      // A DEFAULT, not an override, and on both axes. Before the caller's hook,
      // never after, so a spec that wants a different answer —
      // `guided-onboarding-settings-sync.spec.ts` wants `null` — seeds it in
      // `beforeLaunch` and still wins. And only when the profile has no answer
      // yet, so a RELAUNCH of a profile whose earlier launch recorded one keeps
      // it: that spec saves Off and relaunches without restating it, and an
      // unconditional `"full"` here reconciles the same profile to Redacted.
      seedDesktopSettingsDefaults(userDataDir, E2E_DESKTOP_SYNC_CONSENT_SEED);
      beforeLaunch?.(userDataDir);
      if (sameProcessSessionSeed !== undefined) {
        prepareSameProcessAuthSeed(
          harnessHomesRoot,
          userDataDir,
          sameProcessSessionSeed
        );
      }
    },
    afterClose: () => {
      fs.rmSync(harnessHomesRoot, { recursive: true, force: true });
    },
  });

  try {
    if (!keepFirstRunState) {
      await assertReturningInstallSeed(page, storageSeed, 60_000, app);
    }
    return { app, page, pageErrors, cleanup };
  } catch (error) {
    await discardPartialLaunch(cleanup);
    throw error;
  }
}

const returningDashboardSeed: Readonly<Record<string, string>> = {
  ...RETURNING_INSTALL_LOCAL_STORAGE_SEED,
  [dashboardOnboardedStorageKey]: DASHBOARD_FLAG_SET,
};

const dashboardCompletedStorageSeed: Readonly<Record<string, string>> = {
  [dashboardOnboardedStorageKey]: DASHBOARD_FLAG_SET,
  [dashboardTourSeenStorageKey]: DASHBOARD_FLAG_SET,
};
