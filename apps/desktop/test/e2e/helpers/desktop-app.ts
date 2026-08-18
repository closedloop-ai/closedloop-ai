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
import { E2E_EPHEMERAL_LOOPBACK_PORTS_ARG } from "../../../src/main/lifecycle/loopback-port-isolation.js";
import { E2E_NO_REVEAL_ARG } from "../../../src/main/lifecycle/window-reveal-suppression.js";
import type { CloudReadReadinessSnapshot } from "../../../src/shared/cloud-read-readiness-contract.js";
import {
  SYNC_LANE_IDS,
  SyncLaneDrainState,
  SyncLaneId,
} from "../../../src/shared/sync-burndown-contract.js";
import {
  localSessionSourceGateEnv,
  localSessionSourceGateLaunchArgs,
} from "./local-session-source-gate";
import {
  sessionsPageDataGateEnv,
  sessionsPageDataGateLaunchArgs,
} from "./sessions-page-data-gate";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** apps/desktop — helpers live at apps/desktop/test/e2e/helpers. */
export const DESKTOP_ROOT = path.resolve(__dirname, "../../..");
export const MAIN_JS = path.join(DESKTOP_ROOT, "dist/main/index.js");
/** This directory — the only place the test-only `-r` preloads may come from. */
const E2E_HELPERS_DIR = __dirname;
const APP_CLOSE_TIMEOUT_MS = 5000;
const APP_KILL_TIMEOUT_MS = 5000;
const DESKTOP_SETTINGS_FILE = "desktop-settings.json";

export type LaunchOptions = {
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
  /** Extra env vars layered on top of the standard test env. */
  env?: Record<string, string>;
  /**
   * Called with the freshly-created temp user-data dir *before* the app
   * launches — the hook point for seeding electron-store JSON files
   * (e.g. seedPendingApprovals) that the main process reads at boot.
   */
  beforeLaunch?: (userDataDir: string) => void;
  /**
   * ISS-5714: pin the desktop→cloud readiness snapshot the read-source cutover
   * consults, so a launched app has a DETERMINISTIC answer to "does the cloud
   * hold this machine's history?". See {@link cloudReadReadinessLaunchArgs} for
   * why the production sampler cannot supply one inside a spec's lifetime.
   */
  cloudReadReadiness?: CloudReadReadinessSnapshot;
  /**
   * ISS-5768: pin the `cloudSync` half of the runtime-status payload. Requires
   * `cloudReadReadiness` — it rides the same preload. See
   * {@link identifiedCloudSyncProgress} for why a spec asserting the History
   * Sync cell needs it.
   */
  cloudSyncProgress?: E2eCloudSyncProgress;
  /**
   * ISS-4561: install the Sessions combined `pageData` IPC gate. It is INERT
   * until the spec arms it; armed, it forces the best-effort usage half into the
   * transient failure the recovery hook exists for and holds each response until
   * the spec releases it. See `sessions-page-data-gate-preload.cjs` for what that
   * substitutes, and what it deliberately leaves as the real thing.
   */
  sessionsPageDataGate?: boolean;
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
   * ISS-6002: hold the LOCAL SESSION SOURCE down (`starting`, with no observed
   * boot import) while the session read keeps answering — the cold-boot window
   * in which a successful `{ total: 0 }` says nothing about what the store
   * holds. Held from launch; `releaseLocalSessionSource` lets the real source
   * through. See `local-session-source-gate-preload.cjs`.
   */
  localSessionSourceGate?: boolean;
};

/**
 * The app-level argument that keeps a launch off screen, or nothing when the
 * caller asked to watch it. App-level, so it goes AFTER `MAIN_JS`.
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
  return watching ? [] : [E2E_NO_REVEAL_ARG];
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
 */
export function e2eAppLaunchArgs(revealWindow: boolean): string[] {
  return [
    ...windowRevealLaunchArgs(revealWindow),
    E2E_EPHEMERAL_LOOPBACK_PORTS_ARG,
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
 * ISS-5714: `SyncBurndownReporter.start()` schedules its FIRST sample a full
 * 60s out, so `getCloudReadReadiness()` answers UNKNOWN for the first minute of
 * every launch and the cutover holds every surface on Local. No spec can wait
 * that out, and waiting would not make the state deterministic anyway — the real
 * lane states depend on what the collectors found in the fixture home dirs. Only
 * the readiness INPUT is substituted; the IPC handler, the preload bridge,
 * `resolveCloudReadCutover`, the providers and both read sources are the shipped
 * ones. See `cloud-read-readiness-preload.cjs`.
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

type E2eLaneReadiness = CloudReadReadinessSnapshot["lanes"][number];

/**
 * A readiness snapshot carrying EVERY lane the burn-down reports, drained
 * except where overridden.
 *
 * `SyncBurndownReporter` builds all five lanes on every sample, and since
 * ISS-6206 the renderer's IPC boundary requires exactly that set — a fixture
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
      itemsRemaining: 0,
      itemsRemainingIsLowerBound: false,
      deadLetteredCount: 0,
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

/** The fixture the preload reads for the runtime-status `cloudSync` field. */
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

  seedE2eDesktopSettings(userDataDir);
  options.beforeLaunch?.(userDataDir);

  const app = await electron.launch({
    // Chromium/Electron switches must precede the app entrypoint; after MAIN_JS
    // they are application arguments and `-r` would never load.
    args: [
      ...cloudReadReadinessLaunchArgs(options.cloudReadReadiness),
      ...sessionsPageDataGateLaunchArgs(options.sessionsPageDataGate === true),
      ...localSessionSourceGateLaunchArgs(
        options.localSessionSourceGate === true
      ),
      MAIN_JS,
      `--user-data-dir=${userDataDir}`,
      ...e2eAppLaunchArgs(options.revealWindow === true),
    ],
    env: {
      ...process.env,
      ...cloudReadReadinessEnv(options.cloudReadReadiness),
      ...cloudSyncProgressEnv(options.cloudSyncProgress),
      ...sessionsPageDataGateEnv(options.sessionsPageDataGate === true),
      ...localSessionSourceGateEnv(options.localSessionSourceGate === true),
      CLOSEDLOOP_DISABLE_AUTO_UPDATE: "1",
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
      ...options.env,
    },
  });

  const page = await app.firstWindow();
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

  const cleanup = async (): Promise<void> => {
    await closeElectronApp(app);
    if (!options.keepUserDataDir) {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  };

  return { app, page, userDataDir, pageErrors, consoleErrors, cleanup };
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

/**
 * The first-launch onboarding overlay (PRD-532 / FEA-3999). Since the unified
 * GitHub-first account graduated to always-on, the Dashboard layers this modal
 * sign-in dialog over the (fully mounted) dashboard whenever the device is
 * signed out — which every E2E profile is. It intercepts pointer events, so any
 * spec that clicks a Dashboard control (e.g. the "All time" date-range toggle)
 * must first clear it. There is no in-flow skip (sign-in is required and E2E has
 * no Clerk), so — like seeding the tour-seen storage key to skip the first-run
 * reveal — the overlay is dismissed here for tests whose subject is the
 * dashboard underneath, not the onboarding gate.
 */
export const ONBOARDING_OVERLAY_LABEL = "Set up your Closedloop account";

/**
 * Dismiss the signed-out first-launch onboarding overlay so a spec can interact
 * with the Dashboard mounted behind it.
 *
 * The overlay is a React-rendered, auth-state-driven `<div role="dialog">` (see
 * `DashboardPage`): it mounts only once the renderer's auth pull resolves to
 * signed-out, which happens ASYNCHRONOUSLY after the Dashboard heading paints.
 * A one-shot `node.remove()` was racy on two fronts: it no-oped when the auth
 * pull had not resolved yet (overlay not mounted at call time, then mounted
 * later to intercept the click), and React re-inserted the node on any
 * subsequent re-render because the component's own dismissed-state was never
 * flipped. Either way the "All time" click hit the overlay and timed out.
 *
 * Instead of fighting React's ownership of that node, inject a persistent
 * stylesheet that removes the overlay from the pointer-event/visibility layer
 * by `aria-label`. A `<style>` in `<head>` survives every React re-render, so
 * even if the overlay mounts (or re-mounts) after this call the Dashboard
 * controls behind it stay clickable. Idempotent and safe to call unconditionally
 * before driving Dashboard controls (a no-op for an already-onboarded profile,
 * which never mounts the overlay).
 */
export async function dismissDesktopOnboardingOverlay(
  page: Page
): Promise<void> {
  await page.addStyleTag({
    content: `[role="dialog"][aria-label="${ONBOARDING_OVERLAY_LABEL}"]{display:none !important;pointer-events:none !important;}`,
  });
  // Assert the neutralization held: an overlay already mounted at call time is
  // now hidden, and an absent one (auth still resolving, or an already-onboarded
  // profile) is trivially hidden — either way the style rule keeps it out of the
  // pointer-event layer for the rest of the test, so a later mount cannot
  // intercept Dashboard clicks.
  const overlay = page.locator(
    `[role="dialog"][aria-label="${ONBOARDING_OVERLAY_LABEL}"]`
  );
  await expect(overlay).toBeHidden();
}

/** The first-run landing's headline, and the CTA that enters the app past it. */
export const GUEST_LANDING_HEADING = /Stop\s+burning\s+tokens\./;
export const GUEST_LANDING_CTA = "Get Started";

/**
 * Click through the first-run landing into the app.
 *
 * ISS-5112 Step F: with the `guest-onboarding` flag ON, a profile that has never
 * completed a first launch gets a full-window landing that REPLACES the app
 * shell — so a spec that seeds the flag against a fresh user-data dir sees no
 * Dashboard, no sidebar and no topbar until this runs. Profiles seeded through
 * a prior boot (the `seedOnboardedProfile` pattern) carry the onboarded storage
 * key and never see it.
 *
 * Deliberately STRICT rather than tolerant: it waits for the landing and fails
 * if it never arrives. The overlay helper above can afford to no-op on absence
 * because it only neutralizes something in the way; this one is the only route
 * into the app for the profiles that call it, so silently skipping would leave
 * the caller asserting against a screen that never loaded and blame the wrong
 * thing.
 */
export async function enterFromGuestLanding(
  page: Page,
  timeoutMs: number
): Promise<void> {
  const cta = page.getByRole("button", { name: GUEST_LANDING_CTA });
  await expect(cta).toBeVisible({ timeout: timeoutMs });
  await cta.click();
  // The landing unmounts on click; waiting for that here means a caller's next
  // assertion cannot race the takeover still being on screen.
  await expect(cta).toBeHidden({ timeout: timeoutMs });
}

/**
 * Close Electron and ensure its child process exits before test teardown.
 *
 * Playwright can resolve `app.close()` while the spawned Electron process is
 * still alive. Leaving that child attached keeps the worker open until
 * Playwright's teardown timeout, even though every test assertion passed.
 */
export async function closeElectronApp(
  app: ElectronApplication
): Promise<void> {
  const child = app.process();
  const closePromise = app.close();
  closePromise.catch(() => {});

  const closed = await resolvesWithin(closePromise, APP_CLOSE_TIMEOUT_MS);
  if (!(closed && hasProcessExited(child))) {
    child?.kill("SIGKILL");
  }
  await waitForProcessExit(child, APP_KILL_TIMEOUT_MS);
}

function hasProcessExited(child: ChildProcess | undefined): boolean {
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
 * Seed `agents: true` so specs that navigate to the Agents workspace keep
 * exercising real content. FEA-2923 registered the shared `"agents"` UI flag in
 * the desktop registry with a product default of OFF (opt-in Labs toggle). Once
 * a flag is in the registry, `DesktopFeatureFlagProvider` resolves it from the
 * persisted setting/registry default instead of the unpackaged-dev fallback, so
 * without this seed a fresh E2E profile hides AgentsView and specs such as
 * `agents.spec.ts` / `distribution-flow.spec.ts` time out. Kept in the E2E seed
 * (not the product default) so releases stay opt-in.
 */
function seedE2eDesktopSettings(userDataDir: string): void {
  mergeDesktopSettings(userDataDir, {
    agents: true,
    // ISS-5310 (ISS-4779 closed-by-default): `agentsNav` is the per-item gate
    // over the Agents destination, which moved back into Labs and ships OFF.
    // Distinct from the `agents` flag above — that one gates the workspace's
    // CONTENT, this one gates whether the nav entry and `#/agents` exist at all.
    // Seeded for the same reason as `labsNav` below: these specs assert the
    // views, and the gate itself is covered by
    // `navigation/__tests__/agents-labs-gate.test.tsx`.
    agentsNav: true,
    cloudConnectionEnabled: false,
    // ISS-5037 (ISS-4779 closed-by-default): `labsNav` is the container gate
    // over the whole Labs sidebar section, and it ships OFF. Every Labs
    // DESTINATION — Insights, Packs, Plans, Audit, Help, and everything
    // FOCUS_MODE folds in — is unreachable until a user opts in from the
    // application menu, so a harness that did not opt in could only ever smoke
    // the "turned off" panel. Opt in here, once, for the same reason `agents`
    // is seeded: these specs assert the VIEWS, and the gate itself is covered by
    // `app-shell-routing.test.tsx` + `feature-flags-shared-ui.test.ts`.
    labsNav: true,
  });
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
  const raw = fs.existsSync(settingsPath)
    ? JSON.parse(fs.readFileSync(settingsPath, "utf8"))
    : {};
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({ ...raw, ...patch }, null, 2),
    "utf8"
  );
}

/**
 * Enable registered desktop Labs flags for ONE spec.
 *
 * Same mechanism as {@link seedE2eDesktopSettings} — a registered flag resolves
 * from the persisted setting, so a fresh E2E profile sees its product default
 * (usually OFF) unless it is persisted here. This variant is per-spec: call it
 * from `launchDesktopApp`'s `beforeLaunch`, which runs AFTER the standard seed,
 * so `cloudConnectionEnabled` / `agents` are preserved and only the named flags
 * are added.
 *
 * Deliberately NOT folded into `seedE2eDesktopSettings`: a flag seeded there
 * flips for all specs, whereas this per-spec variant lets a single spec opt a
 * named flag ON without changing the product default every other spec receives.
 */
export function seedDesktopFeatureFlags(
  userDataDir: string,
  flags: Record<string, boolean>
): void {
  mergeDesktopSettings(userDataDir, flags);
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
 * `cloudConnectionEnabled` / `agents` are preserved.
 */
export function seedDesktopSettings(
  userDataDir: string,
  patch: Record<string, unknown>
): void {
  mergeDesktopSettings(userDataDir, patch);
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
  await targetRow.click();
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
 * Promoted here from `all-views-smoke-seeded.spec.ts` (wongk, #5099 review) —
 * every seeded spec that widens the range needs the hardened form, and a copy of
 * the bare click is the flake this docstring describes.
 *
 * Idempotent by design: the Dashboard, Sessions, and Branches surfaces all bind
 * their range to the SAME persisted store (`useSharedDateRange("desktop")` →
 * localStorage `shared:date-range:desktop`). Once the Dashboard iteration widens
 * it, the Sessions and Branches toolbars mount with "All time" ALREADY active
 * (`aria-checked="true"`). A blind `.click()` on that already-selected toggle is
 * a no-op for the range but still races the surface's first paint — that is what
 * timed out on Branches: the toggle resolved but was not yet visible/stable, and
 * the redundant click waited out the full 30s. So: wait for the toggle to be
 * visible, then click it ONLY when it is not already the selected range. When it
 * is already "All time" this returns after the visibility wait without a click,
 * removing the race entirely.
 */
export async function widenToAllTime(page: Page): Promise<void> {
  const allTime = page.locator('[aria-label="All time"]:visible').first();
  await expect(allTime).toBeVisible({ timeout: 15_000 });
  if ((await allTime.getAttribute("aria-checked")) === "true") {
    return;
  }
  await allTime.click();
  await expect(allTime).toHaveAttribute("aria-checked", "true", {
    timeout: 15_000,
  });
}
