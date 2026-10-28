/**
 * Shared harness for Desktop Electron E2E tests.
 *
 * Centralizes the `_electron.launch` boilerplate that every spec needs: a
 * per-test temp `--user-data-dir` (so persisted profiles/approvals/keys never
 * leak across runs or from a developer's real Desktop state), the standard
 * test env (auto-update off, security warnings silenced, OTel disabled), a
 * `pageerror` collector (an unresolved lazy-chunk specifier throws here and
 * blanks the renderer — see branches-page.spec.ts), and deterministic teardown.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ElectronApplication, Locator, Page } from "@playwright/test";
import { _electron as electron, expect } from "@playwright/test";
// Extension-qualified: a `@repo/*` TS subpath resolves without one in the app
// but NOT under the Playwright spec loader, where the whole suite aborts at load
// with `Cannot find module`, reports "No tests found", and still exits 0.
import { ONBOARDING_STATE_VERSION } from "@repo/api/src/types/onboarding-persistence.ts";
import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase.ts";
import { E2E_EPHEMERAL_LOOPBACK_PORTS_ARG } from "../../../src/main/lifecycle/loopback-port-isolation.js";
import { E2E_NO_REVEAL_ARG } from "../../../src/main/lifecycle/window-reveal-suppression.js";
import { DEV_UPDATE_CHECK_DISABLED_ENV } from "../../../src/main/update/dev-update-check-gate.js";
import { desktopGuestGuidedOnboardingStorageKey } from "../../../src/renderer/components/dashboard/dashboard-storage-keys";
import type { CloudReadReadinessSnapshot } from "../../../src/shared/cloud-read-readiness-contract.js";
import { E2E_FEATURE_FLAG_ASSIGNMENT_ARG } from "../../../src/shared/e2e-feature-flag-assignment-contract.js";
import {
  SYNC_LANE_IDS,
  SyncLaneDeadLetteredBasis,
  SyncLaneDrainState,
  SyncLaneId,
} from "../../../src/shared/sync-burndown-contract.js";
import {
  ambientHarnessHomes,
  isolatedHarnessHomes,
} from "../../helpers/isolated-harness-homes";
import {
  E2E_DESKTOP_FEATURE_FLAG_SEED,
  E2E_DESKTOP_SETTINGS_SEED,
} from "./e2e-desktop-settings-seed";
import { mergeE2eFeatureFlagAssignment } from "./e2e-feature-flag-assignment-seed";
import {
  firstWindowOrExplainExit,
  launchElectronOrExplain,
} from "./electron-launch-attribution";
import {
  DESKTOP_MAIN_BUNDLE,
  E2E_REVEAL_WINDOW_OPT_IN_ARG,
} from "./electron-launch-preflight";
import {
  type PreloadGateOptions,
  preloadGateEnv,
  preloadGateLaunchArgs,
} from "./preload-gates";
import { captureProcessGroupId, killProcessGroup } from "./process-group-kill";
import {
  assertReturningInstallSeed,
  returningInstallSeedEnv,
  returningInstallSeedLaunchArgs,
} from "./returning-install-seed";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** apps/desktop — helpers live at apps/desktop/test/e2e/helpers. */
export const DESKTOP_ROOT = path.resolve(__dirname, "../../..");
export const MAIN_JS = DESKTOP_MAIN_BUNDLE;
/** This directory — the only place the test-only `-r` preloads may come from. */
const E2E_HELPERS_DIR = __dirname;
const APP_CLOSE_TIMEOUT_MS = 5000;
const APP_KILL_TIMEOUT_MS = 5000;
/**
 * The launch profile's settings file. Exported so a suite grading what a
 * launcher wrote into its profile names the same file the writer does, rather
 * than retyping it.
 */
export const DESKTOP_SETTINGS_FILE = "desktop-settings.json";

export type LaunchOptions = PreloadGateOptions & {
  /** Prefix for the per-test temp user-data dir (defaults to "desktop-e2e-"). */
  userDataPrefix?: string;
  /**
   * Reuse an EXISTING user-data dir instead of creating a fresh temp one. Lets a
   * test boot the app once to create + migrate the SQLite store, close it, seed
   * rows into that file while the app is DOWN (no cross-process WAL contention),
   * then relaunch against the SAME dir so the app reads the seeded corpus at boot.
   * When set, `userDataPrefix` is ignored.
   */
  userDataDir?: string;
  /**
   * Keep the user-data dir on `cleanup()` instead of removing it — so a caller
   * driving a multi-launch flow (see `userDataDir`) can seed/relaunch against it
   * and remove it itself at the end.
   */
  keepUserDataDir?: boolean;
  harnessHomesRoot?: string;
  /**
   * Extra env vars layered on top of the standard test env.
   *
   * ISS-7731: this layers OVER the default collector-home isolation, which is
   * what makes the seeded-corpus pattern work — spread nothing, or spread
   * `isolatedHarnessHomes(root)`, and then name the ONE home that should point
   * at a seeded corpus. The override is honored; the other six stay isolated.
   * There is no way to make a launch read the operator's real history except by
   * naming a real directory here, which is visible in a diff.
   */
  env?: Record<string, string>;
  /**
   * Called with the freshly-created temp user-data dir *before* the app
   * launches — the hook point for seeding electron-store JSON files
   * (e.g. seedPendingApprovals) that the main process reads at boot.
   */
  beforeLaunch?: (userDataDir: string) => void;
  /**
   * Leave this profile looking like a FIRST RUN instead of an install that has
   * run before.
   *
   * ISS-10195 gave a signed-out reader the guided onboarding run, which arms on
   * a first run — and a virgin e2e profile is one, so every launch opened a
   * blocking modal over the shell and the specs beneath it could not click
   * anything. Marking the profile settles that once here rather than in each of
   * 160 specs, the same reasoning ISS-7731 applied to collector-home isolation.
   *
   * Set this only in a spec whose SUBJECT is first-run behaviour. Such a launch
   * skips the returning-install preload seed and returns as soon as the first
   * window has loaded.
   */
  keepFirstRunState?: boolean;
  /**
   * ISS-5768: pin the desktop→cloud readiness snapshot the runtime-status
   * payload carries, so the Settings → History Sync cell and the startup panel
   * have a DETERMINISTIC backlog to render. See
   * {@link cloudReadReadinessLaunchArgs} for why the production sampler cannot
   * supply one inside a spec's lifetime.
   *
   * ISS-6972: this no longer influences which store a surface reads — the read
   * source is authenticated + online + permitted to sync.
   */
  cloudReadReadiness?: CloudReadReadinessSnapshot;
  /**
   * ISS-11426: pin the `computeTargetLinkBlock` field of the runtime-status
   * payload, so a spec can assert the Settings relink alert. The production
   * latch needs a real cloud refusing a real target, which no launch stands up.
   * See `compute-target-link-block-preload.cjs`.
   */
  computeTargetLinkBlock?: {
    refusedComputeTargetId: string | null;
    refusedBatchCount: number;
    firstRefusedAt: string;
  };
  /**
   * ISS-5768: pin the `cloudSync` half of the runtime-status payload. Requires
   * `cloudReadReadiness` — it rides the same preload. See
   * {@link identifiedCloudSyncProgress} for why a spec asserting the History
   * Sync cell needs it.
   *
   * ISS-9184: the FIRST sample, not a fixed one. A spec whose subject is a
   * CHANGE in this field replaces it mid-run with `pushCloudSyncProgress`
   * (`cloud-sync-progress-control.ts`); one that never pushes keeps this sample
   * for the whole launch.
   */
  cloudSyncProgress?: E2eCloudSyncProgress;
  /**
   * ISS-5987: put this launch's window ON SCREEN. Defaults to false — every spec
   * runs off screen so the whole suite is runnable on an operator's Mac without
   * taking over the display. Set it only for a spec whose SUBJECT is the reveal
   * itself (`startup-window-reveal.spec.ts`). To WATCH an ordinary run, use
   * `playwright test --debug` instead of editing a launch call — see
   * {@link windowRevealLaunchArgs}.
   */
  revealWindow?: boolean;
  /**
   * ISS-6929: the Electron launcher. Defaults to Playwright's
   * `_electron.launch`, and no spec overrides it — the seam exists so
   * `desktop-app-partial-launch.test.ts` can drive the teardown in
   * {@link launchGuardedElectronApp} against a REAL spawned process without a
   * real Electron build, which is the only way to assert an exited process
   * handle rather than the absence of a warning.
   */
  launchElectron?: ElectronLauncher;
};

/**
 * The app-level argument that keeps a launch off screen, or the reveal opt-in
 * when the caller asked to watch it (ISS-12135: without the opt-in the launch
 * preflight puts the window back off screen). App-level, so it goes AFTER
 * `MAIN_JS`.
 *
 * `playwright test --debug` counts as asking. Electron headedness is the APP's
 * decision, not Playwright's, so `--debug` cannot reveal this window on its own
 * — it would open the Inspector against a window that stays off screen. What it
 * does do is set `PWDEBUG=1` (playwright's own description: `Shortcut for
 * "PWDEBUG=1" ... "--headed"`), which test workers inherit, so honoring that
 * here is what makes a debugged run watchable. Note `--headed` alone does NOT:
 * it only sets `use.headless`, which `_electron.launch` never consults.
 *
 * Deliberately read HERE rather than at the two call sites, because
 * `launchAuthenticatedDesktopApp` passes a hardcoded `false` (through
 * {@link e2eAppLaunchArgs}) and exposes no `revealWindow` option — routing the
 * decision through one function is what lets `--debug` reveal a run from EITHER
 * launcher.
 */
export function windowRevealLaunchArgs(revealWindow: boolean): string[] {
  const watching = revealWindow || Boolean(process.env.PWDEBUG);
  return watching ? [E2E_REVEAL_WINDOW_OPT_IN_ARG] : [E2E_NO_REVEAL_ARG];
}

/**
 * ISS-5723: every app-level argument an E2E launch takes. Both launchers route
 * through this rather than composing the list themselves, so a switch that must
 * be on for EVERY launch cannot be added to one and forgotten on the other.
 *
 * {@link E2E_EPHEMERAL_LOOPBACK_PORTS_ARG} is unconditional here: the fixed
 * loopback ports it moves (4820, 4318) are the two resources a second Playwright
 * worker would collide on, and no spec asserts on either port number. It is what
 * makes `workers > 1` deterministic rather than a coin flip over which worker's
 * app won the bind — see that module for why it is a launch argument and not an
 * env var.
 *
 * {@link E2E_FEATURE_FLAG_ASSIGNMENT_ARG} (ISS-8753) is unconditional for the
 * same reason: desktop flag resolution is moving to the signed-in user's PostHog
 * assignment, an E2E launch has no account, and a launch that did not opt into
 * being served the seeded assignment would silently run with EVERY gate closed —
 * including the ones the standard profile seed opens for all specs. Passing it
 * from one place is what stops the authenticated launcher and this one
 * disagreeing about which of them has flags at all.
 */
export function e2eAppLaunchArgs(revealWindow: boolean): string[] {
  return [
    ...windowRevealLaunchArgs(revealWindow),
    E2E_EPHEMERAL_LOOPBACK_PORTS_ARG,
    E2E_FEATURE_FLAG_ASSIGNMENT_ARG,
  ];
}

export type LaunchedApp = {
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
  /** Uncaught renderer errors captured since launch. Assert `toEqual([])`. */
  pageErrors: Error[];
  /**
   * `console.error` texts captured since launch. A chunk-load failure CAUGHT by
   * the RootErrorBoundary never fires `pageerror` (the boundary handles it and
   * shows the "Something went wrong" fallback), but it IS logged here — so this
   * is the signal that catches a boundary-swallowed lazy-chunk crash. Filter for
   * fatal patterns before asserting; the renderer logs benign errors too.
   */
  consoleErrors: string[];
  /** Close the app and remove the temp user-data dir. Always call in `finally`. */
  cleanup: () => Promise<void>;
};

/**
 * The Electron switches that install the readiness fixture preload, or nothing
 * when a spec did not ask for one (in which case the app uses its real sampler).
 *
 * `SyncBurndownReporter.start()` schedules its FIRST sample a full 60s out, so
 * the runtime-status payload carries UNKNOWN readiness for the first minute of
 * every launch. No spec can wait that out, and waiting would not make the state
 * deterministic anyway — the real lane states depend on what the collectors
 * found in the fixture home dirs. Only the readiness INPUT is substituted; the
 * runtime-status handler, the preload bridge and every surface that renders the
 * backlog are the shipped ones. See `cloud-read-readiness-preload.cjs`.
 */
export function cloudReadReadinessLaunchArgs(
  snapshot: CloudReadReadinessSnapshot | undefined
): string[] {
  return snapshot
    ? ["-r", path.join(E2E_HELPERS_DIR, "cloud-read-readiness-preload.cjs")]
    : [];
}

/** The fixture the preload above reads, or nothing when no spec asked for one. */
export function cloudReadReadinessEnv(
  snapshot: CloudReadReadinessSnapshot | undefined
): Record<string, string> {
  return snapshot
    ? { CL_E2E_CLOUD_READ_READINESS: JSON.stringify(snapshot) }
    : {};
}

/** ISS-11426: the link-block preload, loaded only when a spec asked for one. */
export function computeTargetLinkBlockLaunchArgs(
  block: LaunchOptions["computeTargetLinkBlock"]
): string[] {
  return block
    ? [
        "-r",
        path.join(E2E_HELPERS_DIR, "compute-target-link-block-preload.cjs"),
      ]
    : [];
}

/** The fixture that preload reads. */
export function computeTargetLinkBlockEnv(
  block: LaunchOptions["computeTargetLinkBlock"]
): Record<string, string> {
  return block
    ? { CL_E2E_COMPUTE_TARGET_LINK_BLOCK: JSON.stringify(block) }
    : {};
}

type E2eLaneReadiness = CloudReadReadinessSnapshot["lanes"][number];

/**
 * A readiness snapshot carrying EVERY lane the burn-down reports, drained
 * except where overridden.
 *
 * `SyncBurndownReporter` builds every lane on every sample, and since
 * ISS-6206 the renderer's IPC boundary requires every one of them — a fixture
 * naming one lane is not a smaller real snapshot, it is one the app would
 * reject, and a launched-app assertion built on it would be measuring the
 * rejection rather than the behavior under test.
 */
function readinessWithLanes(
  overrides: Partial<Record<SyncLaneId, Partial<E2eLaneReadiness>>> = {}
): CloudReadReadinessSnapshot {
  return {
    sampledAtIso: "2026-08-07T12:00:00.000Z",
    importComplete: true,
    lanes: SYNC_LANE_IDS.map((lane) => ({
      lane,
      state: SyncLaneDrainState.Drained,
      resumeBlocked: false,
      itemsRemaining: 0,
      itemsRemainingIsLowerBound: false,
      deadLetteredCount: 0,
      deadLetteredBasis: SyncLaneDeadLetteredBasis.QueueStatusCount,
      unmeasuredRows: 0,
      ...overrides[lane],
    })),
  };
}

/** A cloud that demonstrably HOLDS this machine's history: every lane drained. */
export function drainedCloudReadReadiness(): CloudReadReadinessSnapshot {
  return readinessWithLanes();
}

/**
 * ISS-5768: the reported machine — the SESSION lanes are drained (`caughtUp`
 * was true on it), while the component inventory still owes thousands of rows
 * and one invocation part is abandoned. The state a per-lane completeness claim
 * rendered as "Up to date".
 */
export function outstandingCloudReadReadiness(
  itemsRemaining = 2985
): CloudReadReadinessSnapshot {
  return readinessWithLanes({
    [SyncLaneId.ComponentInventory]: {
      state: SyncLaneDrainState.Draining,
      itemsRemaining,
    },
    [SyncLaneId.InvocationParts]: {
      state: SyncLaneDrainState.DrainedWithDeadLetters,
      deadLetteredCount: 1,
    },
  });
}

/**
 * ISS-6206: a lane that NEVER RAN this launch, beside four genuinely drained
 * ones. Every lane owes nothing measurable, so the pre-ISS-6206 aggregate
 * rounded this up to "Up to date" — a lane that never looked, reported as
 * caught up. Under the strict Labs gate it must resolve to unverified instead.
 */
export function stoppedLaneCloudReadReadiness(): CloudReadReadinessSnapshot {
  return readinessWithLanes({
    [SyncLaneId.TranscriptArchive]: {
      state: SyncLaneDrainState.NeverStarted,
    },
  });
}

/**
 * ISS-6206: two lanes owing work in DIFFERENT units — outbox rows and
 * transcript files. Their sum is not a quantity of anything, which is why the
 * strict path reports them per lane instead of as one cross-lane total.
 */
export function mixedLaneCloudReadReadiness(): CloudReadReadinessSnapshot {
  return readinessWithLanes({
    [SyncLaneId.SessionMetadata]: {
      state: SyncLaneDrainState.Draining,
      itemsRemaining: 2900,
    },
    [SyncLaneId.TranscriptArchive]: {
      state: SyncLaneDrainState.Draining,
      itemsRemaining: 12,
    },
  });
}

/**
 * ISS-9823: the wedged device — the session lane's once-per-identity resume read
 * is failing, so every pass aborts before it can enqueue anything, beside four
 * genuinely drained lanes.
 *
 * The condition is self-reinforcing, which is what makes it invisible to every
 * count: the abort is the reason the outbox stays empty, so on a device that was
 * already caught up the lane reports a measured, honest zero and the pre-ISS-9823
 * aggregate rounded the whole app up to "Up to date" while local data never left
 * the machine. `remaining_unknown` with a clean zero is reproducible ONLY from
 * `resumeBlocked`, which is why the flag rides the payload — see
 * `parse-cloud-read-readiness.ts`.
 */
export function resumeBlockedCloudReadReadiness(): CloudReadReadinessSnapshot {
  return readinessWithLanes({
    [SyncLaneId.SessionMetadata]: {
      resumeBlocked: true,
      state: SyncLaneDrainState.RemainingUnknown,
    },
  });
}

/**
 * The `cloudSync` half of the runtime-status payload, declared structurally
 * rather than imported: `AgentSessionSyncProgress` lives in `src/main/`, and one
 * main-process import aborts the WHOLE Electron E2E run at load time.
 */
export type E2eCloudSyncProgress = {
  identified: boolean;
  pendingBackfillSessions: number;
  pendingIncrementalSessions: number;
  backfilling: boolean;
  caughtUp: boolean;
  deadLetteredSessions: number;
  deadLetteredComponents?: number;
  /**
   * ISS-7099: the lane's own progress pair — sessions it verified an ack for,
   * over the total it has had in flight.
   *
   * A fixture that omits these drives the banner's COMPATIBILITY fallback (the
   * derived pair an older main process gets), so it stays green even if the real
   * fields never traverse runtime-status → preload → poller. A spec asserting
   * the delivered/ready counter has to seed them.
   */
  deliveredSessions?: number;
  inFlightTotalSessions?: number;
};

/**
 * ISS-5768: a cloud identity with its SESSION lanes clean — `caughtUp: true`,
 * both per-lane dead-letter counts zero. Exactly what the reported machine
 * reported, and the reason the History Sync cell said "Up to date" on it.
 *
 * A spec asserting that cell needs this because `identified` is true only while
 * the cloud SOCKET is online with a compute target, which no E2E fixture stands
 * up — without it the cell renders its "not connected" dash and no completeness
 * label is reachable at all. It makes the label OBSERVABLE; the readiness
 * snapshot is what decides WHICH label appears.
 */
export function identifiedCloudSyncProgress(): E2eCloudSyncProgress {
  return {
    identified: true,
    pendingBackfillSessions: 0,
    pendingIncrementalSessions: 0,
    backfilling: false,
    caughtUp: true,
    deadLetteredSessions: 0,
    deadLetteredComponents: 0,
  };
}

/**
 * The fixture the preload reads as its FIRST runtime-status `cloudSync` sample.
 * Later samples come from the spec (ISS-9184) — see `cloudSyncProgress`.
 */
export function cloudSyncProgressEnv(
  progress: E2eCloudSyncProgress | undefined
): Record<string, string> {
  return progress
    ? { CL_E2E_CLOUD_SYNC_PROGRESS: JSON.stringify(progress) }
    : {};
}

/**
 * The reported ISS-5714 shape: a populated machine has signed in and its history
 * is still on its way up, so the cloud holds none of it yet.
 */
export function drainingCloudReadReadiness(
  itemsRemaining = 3401
): CloudReadReadinessSnapshot {
  return readinessWithLanes({
    [SyncLaneId.SessionMetadata]: {
      state: SyncLaneDrainState.Draining,
      itemsRemaining,
    },
  });
}

/**
 * Launch the built Desktop app against an isolated temp user-data dir and
 * return the first window plus a page-error collector and teardown helper.
 */
export async function launchDesktopApp(
  options: LaunchOptions = {}
): Promise<LaunchedApp> {
  const userDataDir =
    options.userDataDir ??
    fs.mkdtempSync(
      path.join(os.tmpdir(), options.userDataPrefix ?? "desktop-e2e-")
    );
  fs.mkdirSync(userDataDir, { recursive: true });
  // ISS-7731: isolation is the DEFAULT, not something 89 specs each had to
  // remember. Owned here (not by the caller) so a spec that says nothing about
  // collector homes is safe, and so the temp roots are removed by the same
  // teardown that removes the profile.
  const harnessHomesRoot =
    options.harnessHomesRoot ??
    fs.mkdtempSync(path.join(os.tmpdir(), "desktop-e2e-homes-"));

  const launched = await launchGuardedElectronApp({
    // Chromium/Electron switches must precede the app entrypoint; after MAIN_JS
    // they are application arguments and `-r` would never load.
    args: [
      ...returningInstallSeedLaunchArgs(options.keepFirstRunState),
      ...cloudReadReadinessLaunchArgs(options.cloudReadReadiness),
      ...computeTargetLinkBlockLaunchArgs(options.computeTargetLinkBlock),
      ...preloadGateLaunchArgs(options),
      MAIN_JS,
      `${USER_DATA_DIR_ARG}${userDataDir}`,
      ...e2eAppLaunchArgs(options.revealWindow === true),
    ],
    env: {
      ...process.env,
      ...cloudReadReadinessEnv(options.cloudReadReadiness),
      ...computeTargetLinkBlockEnv(options.computeTargetLinkBlock),
      ...cloudSyncProgressEnv(options.cloudSyncProgress),
      ...preloadGateEnv(options, userDataDir),
      CLOSEDLOOP_DISABLE_AUTO_UPDATE: "1",
      // ISS-12843: the unpackaged build's boot git probe raises the update
      // banner whenever origin/main is past the built commit, shifting the
      // page under a spec's measured geometry at an arbitrary moment.
      [DEV_UPDATE_CHECK_DISABLED_ENV]: "1",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      // FEA-2199: hard-disable the OTel SDK for E2E. The egress gate
      // (resolveDesktopTelemetryEgressEnabled) already stops the unpackaged app
      // from shipping to the prod relay, but this is belt-and-suspenders and
      // documents intent at the call site: each test launches a fresh
      // --user-data-dir (a new app.installation.id) and inherits CI's env, so
      // these short-lived runs must never produce telemetry at all. Without it,
      // the harness flooded prod Datadog/PostHog with `version=0.0` start/shutdown
      // pairs. A spec may still opt back in via options.env if it asserts OTel.
      OTEL_SDK_DISABLED: "1",
      // ISS-12787: blank, so a key exported in the runner's shell cannot reach a
      // seeded launch and send fake sessions to the default API origin. Before
      // `...options.env`, so a spec that needs an identity still passes its own.
      CLOSEDLOOP_API_KEY: "",
      // ISS-7731 — ABOVE `...process.env`, BELOW `...options.env`, and both
      // positions are load-bearing.
      //
      // Above the inherited environment: a launch that merely FAILS to pin a
      // home resolves it under `os.homedir()`, so the boot collectors read the
      // operator's real Cursor/Copilot/OpenCode history into this launch's
      // SQLite store. That is not hypothetical — a real local Copilot session
      // was found in a seeded Sessions population on PR #5639 (ISS-7697). Being
      // above also overrides a real value the operator happens to export.
      //
      // Below `options.env`: a spec that deliberately seeds a harness home must
      // still win. The established pattern (historical-import-utility-worker.spec.ts)
      // spreads this set and overrides one key back to a seeded corpus — that
      // override lands in `options.env` and is neither broken nor silently
      // ignored. OpenCode matters most: `opencode.db` is a BATCH source, one
      // file holding an unbounded number of sessions.
      ...isolatedHarnessHomes(harnessHomesRoot),
      ...options.env,
      ...returningInstallSeedEnv(
        options.keepFirstRunState,
        RETURNING_INSTALL_LOCAL_STORAGE_SEED
      ),
    },
    launchElectron: options.launchElectron,
    // ISS-8955: BEFORE the spawn, and that was load-bearing rather than merely
    // conventional. `--user-data-dir` redirects `userData` but not `appData`, so
    // an EMPTY launch profile used to be the main process's cue to rename the
    // operator's installed profile into it. The redirect guard in
    // `userdata-migration.ts` is what actually closes that now — this ordering
    // is no longer a safety property, and never was one for
    // `launchAuthenticatedDesktopApp`, which seeds nothing of its own. It is
    // still pinned, by `desktop-e2e-profile-seed-ordering.test.ts`, because the
    // per-spec `beforeLaunch` below layers onto what this wrote.
    beforeLaunch: () => {
      seedE2eDesktopSettings(userDataDir);
      options.beforeLaunch?.(userDataDir);
    },
    // The profile this launcher created is its own to remove, so it goes on the
    // wrapper's teardown alongside closing the app. `launchAuthenticatedDesktopApp`
    // passes nothing here: its caller made the dir and removes it.
    afterClose: () => {
      // The harness homes are ALWAYS this launcher's to remove — unlike the
      // profile, no caller can own them, so `keepUserDataDir` does not apply.
      fs.rmSync(harnessHomesRoot, { recursive: true, force: true });
      if (!options.keepUserDataDir) {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      }
    },
  });

  try {
    if (options.keepFirstRunState !== true) {
      await assertReturningInstallSeed(
        launched.page,
        RETURNING_INSTALL_LOCAL_STORAGE_SEED,
        SHELL_SETTLE_MS,
        launched.app
      );
    }
    return { ...launched, userDataDir };
  } catch (error) {
    await discardPartialLaunch(launched.cleanup);
    throw error;
  }
}

/**
 * Navigate the renderer to a nav view via hash routing — the same mechanism
 * the sidebar uses (FEA-1518). The sidebar is in FOCUS_MODE (only Sessions and
 * Branches are surfaced), so hash navigation — not clicking — is the reliable
 * driver for the Labs/Gateway views.
 */
export async function gotoNav(page: Page, navId: string): Promise<void> {
  await gotoHash(page, `/${navId}`);
}

/**
 * The nav view the shell has actually COMMITTED to — scope every page-global
 * query that a sibling view could also answer.
 *
 * Keep-alive leaves every visited view mounted (`App.tsx`), so `page.getByText`,
 * `page.locator`, and `.first()` all range over views the user is not looking
 * at. Since Dashboard became the canonical landing it is the FIRST view mounted
 * and therefore first in DOM order, and its Recent Sessions grid renders session
 * links, branch names, `data-column-id` headers, a Date range group, and cost
 * values — so an unscoped query on a Sessions or Branches surface now tends to
 * resolve Dashboard's copy first.
 *
 * `:visible` is NOT the fix. The body commits on a DEFERRED render while the
 * Topbar follows the immediate nav id, so visibility is a property that changes
 * under you mid-navigation: a `:visible` filter samples one instant, and an
 * `expect(...).toBeVisible()` that passes can be invalidated by the very next
 * frame — which then strands `click()` on a 0×0 box for its whole timeout. This
 * keys off `data-nav-panel-state` instead, so a control in a transitioning or
 * hidden sibling is not selectable in the first place.
 *
 * For a NEGATIVE assertion (`toHaveCount(0)`), scope to this AND keep a positive
 * anchor before it — an absent panel also yields zero.
 */
export function activeNavPanel(page: Page, navId: string): Locator {
  return page.locator(
    `[data-nav-panel="${navId}"][data-nav-panel-state="active"]`
  );
}

/** {@link gotoNav}, then wait for the shell to actually commit that view. */
export async function gotoNavSettled(
  page: Page,
  navId: string,
  timeoutMs = 30_000
): Promise<Locator> {
  await gotoNav(page, navId);
  const panel = activeNavPanel(page, navId);
  await expect(panel).toBeVisible({ timeout: timeoutMs });
  return panel;
}

/**
 * Navigate the renderer to an arbitrary hash route (e.g. a detail surface such
 * as `/sessions/:id`). Detail views mount their OWN lazy chunk — distinct from
 * the list view's — so a smoke pass must drive these directly to prove those
 * chunks load without crashing.
 */
export async function gotoHash(page: Page, hashPath: string): Promise<void> {
  await page.evaluate((path) => {
    window.location.hash = path;
  }, hashPath);
}

/** How long a launch waits for the reloaded renderer to mount the shell. */
const SHELL_SETTLE_MS = 60_000;

/**
 * The `localStorage` a profile needs to be past the guided onboarding takeover,
 * holding a guest guided-onboarding run already at rest.
 *
 * Production's own settled shape (`snapshot-service.ts` `settledOnboardingState`):
 * `Ready` is non-blocking so the dialog never opens, and the history is
 * load-bearing — `Ready` with an empty one restores as an unreachable state and
 * recovers to a fresh `Welcome`, putting the takeover straight back up.
 *
 * Shared by the app's returning-install launch and the unprivileged sidecar
 * tab (ISS-10943). Both apply the same guest record before renderer scripts,
 * while leaving the dashboard first-run latch untouched.
 */
export const RETURNING_INSTALL_LOCAL_STORAGE_SEED: Readonly<
  Record<string, string>
> = {
  [desktopGuestGuidedOnboardingStorageKey]: JSON.stringify({
    revision: 1,
    state: {
      accountProvider: null,
      history: [OnboardingPhase.DashboardAvailable],
      organizationEstablished: true,
      phase: OnboardingPhase.Ready,
      resuming: false,
      version: ONBOARDING_STATE_VERSION,
    },
  }),
};

/**
 * Close Electron and ensure its child process exits before test teardown.
 *
 * Playwright can resolve `app.close()` while the spawned Electron process is
 * still alive. Leaving that child attached keeps the worker open until
 * Playwright's teardown timeout, even though every test assertion passed.
 *
 * REJECTS when the child outlives the bounded kill wait. `kill()` is a request
 * and not a guarantee — an unreachable or already-reaped handle takes it and
 * nothing dies — and `waitForProcessExit` resolves on its own timeout either
 * way. Returning there would report a clean teardown over a surviving orphan,
 * which is the silence {@link discardPartialLaunch} exists to break: its catch
 * is unreachable while this resolves unconditionally.
 *
 * ISS-7654: `child` is the handle taken at LAUNCH, and re-reading it here via
 * `app.process()` is what this parameter exists to prevent. That accessor
 * round-trips Playwright's in-process dispatcher registry, whose `toImpl` does a
 * bare `_dispatcherByGuid.get(guid)._object` — so against an app that already
 * exited, and therefore has a disposed dispatcher, it throws `TypeError: Cannot
 * read properties of undefined (reading '_object')` AFTER a passing body. Node
 * keeps the launch-time handle and moves its `exitCode`/`signalCode` on exit, so
 * grading the saved handle is what lets this tell "already exited" (resolve)
 * from "failed to exit" (reject below) rather than dying before either verdict.
 * `test/soak/soak-types.ts` holds the same handle against the same accessor.
 *
 * `groupId` is the launch-time {@link captureProcessGroupId} reading, for the
 * same reason: by the time teardown runs, the leader may already be reaped and
 * its group only knowable from what was recorded while it was alive.
 */
export async function closeElectronApp(
  app: ElectronApplication,
  child: ChildProcess | undefined,
  groupId: number | undefined
): Promise<void> {
  const closePromise = app.close();
  closePromise.catch(() => {});

  const closed = await resolvesWithin(closePromise, APP_CLOSE_TIMEOUT_MS);
  if (!(closed && hasProcessExited(child))) {
    // The GROUP, not the leader alone — see `killProcessGroup` for why an
    // orphaned Electron helper is what hangs Playwright's worker teardown.
    //
    // ISS-7683: the ELSE branch needs no reap, and that is an argument rather
    // than an omission. `app.close()` resolving means Playwright's launcher
    // finished its own `gracefullyClose`, which awaits the child's `"close"`
    // event — and Node emits `"close"` only once the process has exited AND its
    // stdio streams are closed. A surviving helper is only reachable here
    // BECAUSE it still holds those inherited pipes, so a settled close is
    // positive evidence that no such helper is left. Consistent with what was
    // measured: the leaking spec never settled its close (`processClosed=false`
    // through teardown), and a spec whose close settled exited clean.
    killProcessGroup(child, groupId);
  }
  await waitForProcessExit(child, APP_KILL_TIMEOUT_MS);
  if (!hasProcessExited(child)) {
    throw new Error(
      `[desktop-e2e] Electron process ${child?.pid ?? "unknown"} was still running ${APP_KILL_TIMEOUT_MS}ms after SIGKILL`
    );
  }
}

/**
 * Whether Node has seen this child terminate. An absent child counts as exited.
 *
 * Exported so a suite asserting on teardown grades against the SAME notion of
 * "exited" the harness itself acts on, rather than a second copy of the rule.
 */
export function hasProcessExited(child: ChildProcess | undefined): boolean {
  return !child || child.exitCode !== null || child.signalCode !== null;
}

async function resolvesWithin(
  promise: Promise<unknown>,
  timeoutMs: number
): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => false
      ),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function waitForProcessExit(
  child: ChildProcess | undefined,
  timeoutMs: number
): Promise<void> {
  // `hasProcessExited` already returns true for an absent child, so this was
  // safe at runtime — but it returns `boolean`, not a type predicate, so it
  // never narrowed `child` for the `child.once` below. Short-circuiting on
  // `!child` first both keeps the behavior and makes the narrowing real.
  if (!child || hasProcessExited(child)) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

/**
 * Keep built-app E2E tests local and deterministic. The cloud relay is covered
 * by focused main-process tests; these Electron flows assert renderer and local
 * database behavior and should not depend on external Socket.IO handshakes.
 *
 * The patch itself lives in {@link E2E_DESKTOP_SETTINGS_SEED} — see that module
 * for why, and for the per-key rationale.
 *
 * ISS-8753: the FLAG subset of that patch is seeded a second time, as an
 * ASSIGNMENT, and only that write reaches a renderer gate:
 * `DesktopFeatureFlagProvider` resolves every key from the PostHog assignment
 * and fails closed in every build, dev included, so an unseeded gate is closed.
 * The `desktop-settings.json` write survives for main-process
 * `SettingsStore.getFlag` readers. Both writes come off the one
 * {@link E2E_DESKTOP_FEATURE_FLAG_SEED} literal, so they cannot drift.
 */
function seedE2eDesktopSettings(userDataDir: string): void {
  mergeDesktopSettings(userDataDir, E2E_DESKTOP_SETTINGS_SEED);
  mergeE2eFeatureFlagAssignment(userDataDir, E2E_DESKTOP_FEATURE_FLAG_SEED);
}

/**
 * Read-merge-write the launch profile's `desktop-settings.json`. The one place
 * that file's shape is known: settings are TOP-LEVEL keys, which is what
 * `SettingsStore` (electron-store, `name: "desktop-settings"`) reads back via a
 * bare `store.get(key)`. Keys absent from `patch` are preserved, so callers
 * layer rather than overwrite.
 */
function mergeDesktopSettings(
  userDataDir: string,
  patch: Record<string, unknown>
): void {
  const settingsPath = path.join(userDataDir, DESKTOP_SETTINGS_FILE);
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({ ...readDesktopSettings(userDataDir), ...patch }, null, 2),
    "utf8"
  );
}

/** The launch profile's persisted settings, or `{}` when it has none yet. */
function readDesktopSettings(userDataDir: string): Record<string, unknown> {
  const settingsPath = path.join(userDataDir, DESKTOP_SETTINGS_FILE);
  return fs.existsSync(settingsPath)
    ? JSON.parse(fs.readFileSync(settingsPath, "utf8"))
    : {};
}

/**
 * Open desktop feature gates for ONE spec.
 *
 * A fresh E2E profile sees every gate at its product default (usually OFF)
 * unless it is seeded here. Per-spec by design: call it from
 * `launchDesktopApp`'s `beforeLaunch`, which runs AFTER the standard seed, so
 * `cloudConnectionEnabled` / `agentsNav` are preserved and only the named flags
 * are added. Deliberately NOT folded into `seedE2eDesktopSettings`: a flag
 * seeded there flips for all specs, whereas this lets a single spec opt a named
 * flag ON without changing the product default every other spec receives.
 *
 * ISS-8753: TWO WRITES, ONE CALL, and ONLY ONE OF THEM REACHES THE RENDERER.
 * `mergeE2eFeatureFlagAssignment` is the write that opens a renderer gate —
 * `DesktopFeatureFlagProvider` resolves every key from the signed-in user's
 * PostHog assignment, which an E2E launch has no account for, and the harness
 * seed is what stands in. The `mergeDesktopSettings` write no longer feeds any
 * renderer gate at all; it survives because MAIN still reads
 * `SettingsStore.getFlag` for its own decisions (the collectors), so a spec
 * that needs one of those needs the
 * persisted value too. A spec asserting a RENDERED gate is asserting the
 * assignment half; see `labs-flag-seeding-contract.spec.ts`, which pins that
 * half on its own so a regression to the retired registry path cannot pass.
 *
 * The signature is unchanged, so every calling spec keeps working untouched.
 */
export function seedDesktopFeatureFlags(
  userDataDir: string,
  flags: Record<string, boolean>
): void {
  mergeDesktopSettings(userDataDir, flags);
  mergeE2eFeatureFlagAssignment(userDataDir, flags);
}

/**
 * Seed the Data & Sync configuration for ONE spec (ISS-4716).
 *
 * Separate from {@link seedDesktopFeatureFlags} because these values are not
 * booleans — `dataSyncLevel` and `syncObservabilityTier` are strings.
 *
 * Seed a COHERENT config, always including `dataSyncLevel`. The settings
 * migration takes an early return when a non-null `dataSyncLevel` is persisted;
 * without one it sees `cloudConnectionEnabled` (which the standard E2E seed
 * writes as `false`), treats the profile as legacy, derives a level from those
 * flags, and re-persists the derived booleans — silently undoing a partial seed
 * such as `transcriptSyncEnabled: true` on its own.
 *
 * That hazard covers the four values the migration WRITES — `dataSyncLevel` and
 * the three connectivity booleans. `syncObservabilityTier` is not one of them: a
 * persisted tier survives the re-derivation untouched, because the migration
 * guards its only tier write on the key being ABSENT. Seeding a tier alone is
 * therefore coherent (the standard E2E seed does exactly that), while seeding a
 * derived boolean alone is not.
 */
export function seedDesktopSyncSettings(
  userDataDir: string,
  settings: Record<string, unknown>
): void {
  mergeDesktopSettings(userDataDir, settings);
}

/**
 * ISS-4898: persist arbitrary top-level `DesktopSettings` for ONE spec — e.g.
 * `webAppOrigin`, to launch the app pointed at a stage profile. Same
 * read-merge-write as {@link seedDesktopFeatureFlags}; call it from
 * `launchDesktopApp`'s `beforeLaunch` so the standard seed's
 * `cloudConnectionEnabled` / `agentsNav` are preserved.
 */
export function seedDesktopSettings(
  userDataDir: string,
  patch: Record<string, unknown>
): void {
  mergeDesktopSettings(userDataDir, patch);
}

/**
 * Seed `patch` as a DEFAULT: write only the keys the profile does not already
 * carry, and leave every key it does carry exactly as it is.
 *
 * ISS-10554. The launcher-level seed it exists for answers a question a FRESH
 * profile has never been asked, and a settings key's ABSENCE is what the
 * production boot migrations read as "never chose" — so seeding on absence is
 * the same predicate the app itself uses, not a harness special case. An
 * unconditional {@link seedDesktopSettings} would overwrite the answer a launch
 * RECORDED, which is the state a relaunching spec is usually asserting survived:
 * `guided-onboarding-settings-sync.spec.ts` saves Off (`syncObservabilityTier:
 * "local"`, which `legacyFlagsToDataSyncLevel` pins to Off against the cloud
 * profile's `cloudConnectionEnabled: true`) and relaunches WITHOUT restating it,
 * so a clobbered `"full"` reconciles that same profile to Redacted instead.
 *
 * Not a substitute for {@link seedDesktopSettings}: a caller stating what a
 * launch must observe still overrides, which is how a spec's own `beforeLaunch`
 * keeps winning over a launcher default.
 */
export function seedDesktopSettingsDefaults(
  userDataDir: string,
  patch: Record<string, unknown>
): void {
  const existing = readDesktopSettings(userDataDir);
  const absent = Object.fromEntries(
    Object.entries(patch).filter(([key]) => !(key in existing))
  );
  if (Object.keys(absent).length > 0) {
    mergeDesktopSettings(userDataDir, absent);
  }
}

/** The Topbar breadcrumb nav. Scope breadcrumb queries to it so the sidebar's
 * same-named links can't satisfy them. */
export function breadcrumbNav(page: Page): Locator {
  return page.getByRole("navigation", { name: "Breadcrumb" });
}

/**
 * The Topbar breadcrumb's parent LINK back to a list route. On a list page that
 * same label renders as the current-page span (not a link), so the link's
 * presence is a reliable "detail mounted" signal — and the back affordance.
 */
export function breadcrumbParentLink(page: Page, name: string): Locator {
  return breadcrumbNav(page).getByRole("link", { name });
}

/**
 * Click a list row's link and wait for the detail view to mount. Each list row
 * renders its name as a link into the shared detail route; mounting is
 * confirmed via `breadcrumbParentLink`.
 */
export async function openDetailFromList(
  page: Page,
  rowLink: Locator,
  breadcrumbParentName: string
): Promise<void> {
  const targetRow = rowLink.first();
  await expect(targetRow).toBeVisible({ timeout: 30_000 });
  // Narrow list pages have fixed-height bands above and below the row scroller.
  // Center the link within the grid's own scroll band so Playwright does not
  // align it under the metric or pagination band while satisfying "in view".
  await targetRow.evaluate((element) => {
    const scroller = element.closest('[data-testid="grid-table-scroll-band"]');
    if (!(scroller instanceof HTMLElement)) {
      element.scrollIntoView({ block: "center", inline: "nearest" });
      return;
    }
    const elementRect = element.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    scroller.scrollTop +=
      elementRect.top -
      scrollerRect.top -
      scrollerRect.height / 2 +
      elementRect.height / 2;
  });
  try {
    await targetRow.click({ timeout: 5000 });
  } catch (error) {
    const href = await targetRow.getAttribute("href");
    if (!href?.startsWith("#/")) {
      throw error;
    }
    await targetRow.evaluate((element) => {
      if (!(element instanceof HTMLElement)) {
        throw new Error("list detail link is not an HTML element");
      }
      element.click();
    });
  }
  await expect(breadcrumbParentLink(page, breadcrumbParentName)).toBeVisible({
    timeout: 30_000,
  });
}

/**
 * Block until the db-host IPC source actually returns agent-component inventory.
 *
 * The main process installs DISABLED agent-dashboard DB responders at boot and
 * swaps in the real ones once the local db host is up. The disabled `list`
 * responder returns an EMPTY result, which the renderer's query client caches
 * and never refetches on its own — so navigating to `#/agents` inside that boot
 * window lands on a permanently empty list, and every row assertion after it
 * fails against a page that is not wrong so much as frozen. (Same race the
 * detail channel documents in `agent-detail-versions-truncated.spec.ts`.)
 *
 * Call this BEFORE navigating to the Agents workspace in any spec that seeded
 * inventory. Shared here rather than kept private to one spec because the race
 * is a property of the boot sequence, not of any single spec (ISS-5364 — the
 * second spec to need it).
 *
 * Polls the PRODUCTION IPC channel, so it proves the app can genuinely see the
 * seeded rows rather than that some time has passed.
 */
export async function waitForLocalAgentComponentList(
  page: Page,
  timeoutMs = 30_000
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const listFn = (
            globalThis as unknown as {
              desktopApi?: {
                db?: {
                  listAgentComponents?: (
                    filters: unknown
                  ) => Promise<{ items?: unknown[] } | null>;
                };
              };
            }
          ).desktopApi?.db?.listAgentComponents;
          if (!listFn) {
            return false;
          }
          try {
            const result = await listFn({});
            return (result?.items?.length ?? 0) > 0;
          } catch {
            return false;
          }
        }),
      { timeout: timeoutMs }
    )
    .toBe(true);
}

/**
 * Widen the current surface's `DateRangeFilter` to "All time" so a past-dated
 * seed is in range independent of the run clock.
 *
 * Promoted here from `all-views-smoke-seeded.spec.ts` (whitlockk, #5099 review) —
 * every seeded spec that widens the range needs the hardened form, and a copy of
 * the bare click is the flake this docstring describes.
 *
 * Idempotent by design: the Dashboard, Sessions, and Branches surfaces all bind
 * their range to the SAME persisted store (`useSharedDateRange("desktop")` →
 * localStorage `shared:date-range:desktop`). Once the Dashboard iteration widens
 * it, the Sessions and Branches toolbars mount with "All time" ALREADY active
 * (`aria-checked="true"`), and this returns without a click.
 */
export async function widenToAllTime(page: Page): Promise<void> {
  await selectDesktopDateRange(page, DesktopDateRangeLabel.AllTime);
}

/**
 * The Electron switch that points a launch at its isolated profile. Shared so
 * a reader of the emitted argv parses the same spelling the launchers emit.
 */
export const USER_DATA_DIR_ARG = "--user-data-dir=";

/** How a launcher spawns Electron. See {@link LaunchOptions.launchElectron}. */
export type ElectronLauncher = typeof electron.launch;

/**
 * ISS-6875: wrapped, never bare — a launch death carries no stderr and no exit
 * code, so without the marker the intake blames whichever spec was running.
 *
 * ISS-6929 collapsed both launchers onto {@link launchGuardedElectronApp}, so
 * this is the ONE place either of them reaches Playwright. The marker sits here
 * rather than at each launcher for the same reason the guard does: a second copy
 * is what lets one of them go unwrapped.
 */
const defaultElectronLauncher: ElectronLauncher = (launchOptions = {}) =>
  launchElectronOrExplain(launchOptions, (prepared) =>
    electron.launch(prepared)
  );

/**
 * ISS-6929: tear down a launch that came up but never produced a usable window.
 *
 * `electron.launch` resolving means the Electron process — and, for
 * `launchDesktopApp`, the `mkdtemp` profile it was pointed at — already exist.
 * A rejection anywhere between there and a usable page therefore orphans both
 * for the rest of the run, and the suite runs `workers: 2` against fixed
 * loopback ports, so an orphan is not merely untidy.
 *
 * Runs the launcher's OWN `cleanup`, which is already bounded at 5s close + 5s
 * kill — a second teardown would be a second thing to keep bounded.
 *
 * A teardown failure must not REPLACE the launch failure — the caller re-throws
 * what actually killed the launch, and that error is the whole diagnosis
 * (ISS-6875 hangs the `harness_launch_failure` marker and Playwright's own
 * message on it). But it must not vanish either: a close/kill that failed means
 * the orphan this function exists to prevent is still running, which is the one
 * thing a reader of the run needs to know. So it is reported and not re-thrown.
 */
export async function discardPartialLaunch(
  cleanup: () => Promise<void>
): Promise<void> {
  await cleanup().catch((teardownError: unknown) => {
    console.warn(
      "[desktop-e2e] partial-launch teardown failed; an Electron process or temp profile may have survived:",
      teardownError
    );
  });
}

/**
 * What a caller hands {@link launchGuardedElectronApp}.
 *
 * `args`/`env` are taken from the launcher's OWN parameter type rather than
 * restated, so a launch option cannot mean one thing here and another to
 * Playwright.
 */
export type GuardedLaunchOptions = Pick<
  NonNullable<Parameters<ElectronLauncher>[0]>,
  "args" | "env"
> & {
  /** Injected only by tests — see {@link LaunchOptions.launchElectron}. */
  launchElectron?: ElectronLauncher;
  /** Seeding that must happen before the spawn, inside the guard. */
  beforeLaunch?: () => void;
  /** Teardown the caller owns beyond closing the app, e.g. its temp profile. */
  afterClose?: () => void;
};

/** A launched app with its first window and the teardown that owns both. */
export type GuardedLaunch = {
  app: ElectronApplication;
  page: Page;
  pageErrors: Error[];
  consoleErrors: string[];
  cleanup: () => Promise<void>;
};

/**
 * ISS-6929: spawn Electron and take its first window with ONE teardown spanning
 * both steps — the only path either desktop-e2e launcher takes to a page.
 *
 * The window between the two is where the leak lived: `electron.launch`
 * resolving means a real Electron process exists, so a rejection before a usable
 * page orphans it for the rest of the run, on a suite at `workers: 2`. Both
 * launchers route through here rather than carrying a copy of the guard, because
 * two copies is what let one of them go unguarded in the first place — and the
 * `launchElectron` seam is what lets the node lane drive this against a real
 * spawned process, so the invariant is covered by behavior rather than by a
 * structural claim about where a `try` sits.
 *
 * `cleanup` is what the caller gets back, so its own `finally` and this guard
 * tear down exactly the same things.
 */
export async function launchGuardedElectronApp(
  options: GuardedLaunchOptions
): Promise<GuardedLaunch> {
  let app: ElectronApplication | undefined;
  let child: ChildProcess | undefined;
  let groupId: number | undefined;
  // ISS-7731 backstop. Both shipped launchers apply the isolation themselves,
  // which is what handles the seeded-corpus override correctly; this is the
  // choke point every path to Electron passes through, so it closes the hole a
  // THIRD launcher — or a caller reaching this directly — would otherwise open.
  // It only fills homes left AMBIENT, so it can never clobber a home a caller
  // deliberately pointed at a seeded corpus, and it creates nothing when the
  // caller already isolated everything.
  const ambient = ambientHarnessHomes(options.env);
  const backstopRoot =
    ambient.length > 0
      ? fs.mkdtempSync(path.join(os.tmpdir(), "desktop-e2e-homes-backstop-"))
      : undefined;
  const backstopHomes =
    backstopRoot === undefined
      ? {}
      : Object.fromEntries(
          Object.entries(isolatedHarnessHomes(backstopRoot)).filter(([key]) =>
            ambient.includes(key)
          )
        );
  const cleanup = async (): Promise<void> => {
    try {
      if (app) {
        await closeElectronApp(app, child, groupId);
        if (!child) {
          // ISS-7654: the launch-time capture is the ONLY handle teardown gets,
          // and `hasProcessExited` grades an absent child as exited — so
          // resolving here would claim an exit nobody observed. Reaching this
          // means `app.process()` threw on a just-launched app; the app was
          // still closed above, but whether it died is unknown, and
          // `discardPartialLaunch` turns this into the surviving-orphan warning
          // rather than a silent clean teardown.
          throw new Error(
            "[desktop-e2e] no Electron child handle was captured at launch; exit could not be verified"
          );
        }
      }
    } finally {
      // In a `finally` so a close/kill failure cannot strand whatever the caller
      // owns; `closeElectronApp` is already bounded at 5s close + 5s kill.
      if (backstopRoot !== undefined) {
        fs.rmSync(backstopRoot, { recursive: true, force: true });
      }
      options.afterClose?.();
    }
  };

  try {
    options.beforeLaunch?.();
    app = await (options.launchElectron ?? defaultElectronLauncher)({
      args: options.args,
      env: { ...options.env, ...backstopHomes },
    });
    // ISS-7654: the ONE moment the app is known to still have a live dispatcher.
    // Teardown runs after the body, by which time the app may already have gone,
    // and asking for the handle then throws instead of returning it.
    child = app.process();
    // ISS-7697: and the same moment is the only one that can answer the group
    // question — teardown may run against a leader the OS has already reaped,
    // whose surviving helper is exactly what teardown has to reach.
    groupId = captureProcessGroupId(child);

    const page = await firstWindowOrExplainExit(app.firstWindow(), child);
    const pageErrors: Error[] = [];
    page.on("pageerror", (error) => {
      pageErrors.push(error);
    });
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(message.text());
      }
    });
    await page.waitForLoadState("domcontentloaded");

    return { app, page, pageErrors, consoleErrors, cleanup };
  } catch (error) {
    await discardPartialLaunch(cleanup);
    throw error;
  }
}

/**
 * The `DateRangeFilter` options these specs drive, by accessible name. Every
 * desktop surface renders the same toggle group, so the label IS the contract
 * a spec selects on.
 */
export const DesktopDateRangeLabel = {
  AllTime: "All time",
  Last7Days: "Last 7 days",
  Last30Days: "Last 30 days",
} as const;
export type DesktopDateRangeLabel =
  (typeof DesktopDateRangeLabel)[keyof typeof DesktopDateRangeLabel];

/** How long the toggle gets to survive a route commit before we give up. */
const DATE_RANGE_SETTLE_MS = 15_000;

/**
 * Click a `DateRangeFilter` option on whichever surface is on screen.
 *
 * The drop-in replacement for a bare
 * `page.locator('[aria-label="…"]:visible').click()`, and the reason none of
 * those survive in this suite. Locator resolution and actionability are two
 * separate steps, and the keep-alive route body commits on a DEFERRED render
 * (`useDeferredValue` in `App.tsx`, whose non-active branch is `hidden h-full`)
 * while the Topbar breadcrumb follows the IMMEDIATE nav id. So a spec that
 * navigates and then drives a control can resolve the OUTGOING view's copy while
 * it is still visible, and hold that handle while the deferred commit gives it
 * `display:none`. Playwright re-resolves on detach but not on "element is not
 * visible", so the handle then sits at a 0×0 box for the whole 30s action
 * timeout — the failure ISS-7995 hit on ten specs across two CI runs.
 *
 * Choosing and clicking inside ONE browser task is what closes that window;
 * `responsive-pages.spec.ts` documents the same technique.
 *
 * The cost of that trade: landing on the OUTGOING view's copy is harmless for
 * the resulting RANGE — every surface binds the one `useSharedDateRange`
 * ("desktop") store — but not for the reads that range change provokes, because
 * the outgoing view refetches too. So a spec whose subject is the request COUNT
 * across a range transition drives the control itself instead;
 * `branches-placeholder-data.spec.ts` is the one that does.
 *
 * That exclusion is NOT what makes such a spec sound, and ISS-8044 is the
 * correction: it fails with this helper or without it whenever a
 * `desktop:db:changed` flush lands mid-count, because the flush invalidates the
 * range cache the count is pinning. Driving the control directly removes one
 * source of extra reads; `waitForLiveBridgeQuiescence` removes the other, and a
 * request-count spec needs both.
 */
export async function clickDesktopDateRange(
  page: Page,
  label: DesktopDateRangeLabel
): Promise<void> {
  await expect
    .poll(
      () =>
        page.locator(`[aria-label="${label}"]`).evaluateAll((elements) => {
          const onScreen = elements.find(
            (element) => element.getClientRects().length > 0
          );
          if (!(onScreen instanceof HTMLElement)) {
            return false;
          }
          onScreen.click();
          return true;
        }),
      { timeout: DATE_RANGE_SETTLE_MS }
    )
    .toBe(true);
}

/**
 * {@link clickDesktopDateRange} plus the idempotence and the proof: skip the
 * click when the option is already the selected range, and assert it is selected
 * afterwards when it was not.
 */
export async function selectDesktopDateRange(
  page: Page,
  label: DesktopDateRangeLabel
): Promise<void> {
  const option = page.locator(`[aria-label="${label}"]:visible`).first();
  await expect(option).toBeVisible({ timeout: DATE_RANGE_SETTLE_MS });
  if ((await option.getAttribute("aria-checked")) === "true") {
    return;
  }
  await clickDesktopDateRange(page, label);
  await expect(
    page.locator(`[aria-label="${label}"]:visible`).first()
  ).toHaveAttribute("aria-checked", "true", {
    timeout: DATE_RANGE_SETTLE_MS,
  });
}

/** The Settings v2 shell's own handle — the modal Settings is on desktop. */
export const SETTINGS_SHELL_TEST_ID = "settings-shell";

/**
 * Open Settings and wait for the modal to mount, returning the shell.
 *
 * ISS-10195: Settings stopped being a nav PAGE when the workspace-experience
 * gate retired. It is the modal `DesktopSettingsModalHost` presents over the
 * last nav page, so there is no Settings breadcrumb in the Topbar, no
 * `[data-nav-panel="settings"]`, and no tab strip — `gotoNav(page, "settings")`
 * followed by `locator('header').getByText('Settings')` resolves nothing. Every
 * spec that needs Settings comes through here instead of re-deriving that.
 *
 * `panel` and `intent` are the `SettingsPanelId` / `SettingsPanelIntent` wire
 * values, taken as plain strings so this module keeps its `@repo/api` import
 * surface — specs pass the imported consts.
 */
export async function openSettingsPanel(
  page: Page,
  options: { panel?: string; intent?: string; timeoutMs?: number } = {}
): Promise<Locator> {
  const params = new URLSearchParams();
  if (options.panel !== undefined) {
    params.set("panel", options.panel);
  }
  if (options.intent !== undefined) {
    params.set("intent", options.intent);
  }
  const query = params.toString();
  await gotoHash(page, query.length === 0 ? "/settings" : `/settings?${query}`);
  const shell = page.getByTestId(SETTINGS_SHELL_TEST_ID);
  await expect(shell).toBeVisible({ timeout: options.timeoutMs ?? 30_000 });
  return shell;
}
