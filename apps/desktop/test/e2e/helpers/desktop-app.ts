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
import type { ElectronApplication, Page } from "@playwright/test";
import { _electron as electron } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** apps/desktop — helpers live at apps/desktop/test/e2e/helpers. */
export const DESKTOP_ROOT = path.resolve(__dirname, "../../..");
export const MAIN_JS = path.join(DESKTOP_ROOT, "dist/main/index.js");
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
};

export type LaunchedApp = {
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
  /** Uncaught renderer errors captured since launch. Assert `toEqual([])`. */
  pageErrors: Error[];
  /** Close the app and remove the temp user-data dir. Always call in `finally`. */
  cleanup: () => Promise<void>;
};

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
    args: [MAIN_JS, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
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
  await page.waitForLoadState("domcontentloaded");

  const cleanup = async (): Promise<void> => {
    await closeElectronApp(app);
    if (!options.keepUserDataDir) {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  };

  return { app, page, userDataDir, pageErrors, cleanup };
}

/**
 * Navigate the renderer to a nav view via hash routing — the same mechanism
 * the sidebar uses (FEA-1518). The sidebar is in FOCUS_MODE (only Sessions and
 * Branches are surfaced), so hash navigation — not clicking — is the reliable
 * driver for the Labs/Gateway views.
 */
export async function gotoNav(page: Page, navId: string): Promise<void> {
  await page.evaluate((id) => {
    window.location.hash = `/${id}`;
  }, navId);
}

/**
 * Close Electron with a bounded graceful window. Some app shutdown paths can
 * hang after the renderer assertion has already completed; tests should still
 * remove their temp profile and let Playwright tear down its worker.
 */
async function closeElectronApp(app: ElectronApplication): Promise<void> {
  const child = app.process();
  const closePromise = app.close();
  closePromise.catch(() => {});

  const closed = await resolvesWithin(closePromise, APP_CLOSE_TIMEOUT_MS);
  if (closed) {
    return;
  }

  child?.kill("SIGKILL");
  await waitForProcessExit(child, APP_KILL_TIMEOUT_MS);
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
  if (!child || child.exitCode !== null || child.signalCode !== null) {
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
  const settingsPath = path.join(userDataDir, DESKTOP_SETTINGS_FILE);
  const raw = fs.existsSync(settingsPath)
    ? JSON.parse(fs.readFileSync(settingsPath, "utf8"))
    : {};
  fs.writeFileSync(
    settingsPath,
    JSON.stringify(
      { ...raw, cloudConnectionEnabled: false, agents: true },
      null,
      2
    ),
    "utf8"
  );
}
