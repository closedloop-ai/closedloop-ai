import { execFile } from "node:child_process";
import { access, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { app } from "electron";
import { z } from "zod";
import { getResolvedGitPathAsync } from "../../server/operations/binary-path-overrides.js";
import { BUILD_COMMIT_HASH } from "../../shared/build-info.js";
import { gatewayLog } from "../logging/gateway-logger.js";

const execFileAsync = promisify(execFile);

/** The unpackaged (git checkout) update probe result. */
export type DevUpdateCheckResult = {
  updateAvailable: boolean;
  currentHash: string;
  remoteHash: string;
};

/**
 * Dev-mode (unpackaged) update check: is `origin/main` ahead of the commit this
 * build was made from? Packaged builds use electron-updater instead.
 */
export async function checkForDevUpdate(
  repoRoot: string
): Promise<DevUpdateCheckResult> {
  await execFileAsync(
    await getResolvedGitPathAsync(),
    ["fetch", "origin", "main"],
    {
      cwd: repoRoot,
    }
  );
  const { stdout } = await execFileAsync(
    await getResolvedGitPathAsync(),
    ["rev-parse", "origin/main"],
    { cwd: repoRoot }
  );
  const remoteHash = stdout.trim();
  return {
    updateAvailable: remoteHash !== BUILD_COMMIT_HASH,
    currentHash: BUILD_COMMIT_HASH,
    remoteHash,
  };
}

/**
 * Dev-mode apply: rebase onto origin/main, rebuild the desktop bundle, and
 * relaunch into it. Only reachable from an unpackaged checkout.
 */
export async function applyDevUpdate(repoRoot: string): Promise<void> {
  await execFileAsync(
    await getResolvedGitPathAsync(),
    ["pull", "--rebase", "origin", "main"],
    {
      cwd: repoRoot,
    }
  );
  await rebuildKeepingCheckoutLaunchable(repoRoot);
  app.relaunch();
  app.exit(0);
}

/**
 * The desktop `build` script deletes `dist` before it writes anything, so a
 * later step failing left the checkout with no entry for the next `electron .`
 * to resolve: the running app survived, and the user's next launch hit
 * Electron's "Error launching app" with no way back short of a successful build
 * (ISS-12479). The previous bundle is moved aside first and put back on any
 * failure, so the rebase lands and the checkout stays launchable.
 */
async function rebuildKeepingCheckoutLaunchable(
  repoRoot: string
): Promise<void> {
  const entry = await resolveBuiltEntryPath(repoRoot);
  const distDir = path.join(repoRoot, DESKTOP_PACKAGE_DIR, DESKTOP_DIST_DIR);
  const parkedDir = `${distDir}${PARKED_DIST_SUFFIX}`;
  await rm(parkedDir, { recursive: true, force: true });
  const parked = await parkPreviousDist(distDir, parkedDir);
  try {
    await runDesktopBuild(repoRoot, entry);
  } catch (error) {
    await restorePreviousDist(distDir, parkedDir, parked);
    logDevUpdateBuildFailure(entry, parked, error);
    throw error;
  }
  await rm(parkedDir, { recursive: true, force: true });
}

async function runDesktopBuild(repoRoot: string, entry: string): Promise<void> {
  await execFileAsync("pnpm", ["-C", DESKTOP_PACKAGE_DIR, "build"], {
    cwd: repoRoot,
  });
  if (!(await pathExists(entry))) {
    throw new Error(`Dev update build finished but ${entry} is missing`);
  }
}

/**
 * Whether a previous bundle was moved aside. A `rename` failure propagates
 * rather than being absorbed: nothing has been destroyed yet, so refusing the
 * update is the outcome that keeps the checkout launchable.
 */
async function parkPreviousDist(
  distDir: string,
  parkedDir: string
): Promise<boolean> {
  if (!(await pathExists(distDir))) {
    return false;
  }
  await rename(distDir, parkedDir);
  return true;
}

/**
 * Best-effort: the caller is already rethrowing the build failure, and a
 * restore that itself fails must not replace that diagnosis with its own.
 */
async function restorePreviousDist(
  distDir: string,
  parkedDir: string,
  parked: boolean
): Promise<void> {
  if (!parked) {
    return;
  }
  try {
    await rm(distDir, { recursive: true, force: true });
    await rename(parkedDir, distDir);
  } catch (error) {
    gatewayLog.error(
      DEV_UPDATE_LOG_TAG,
      `Dev update could not restore ${distDir} from ${parkedDir}: ${failureDetail(error)}`
    );
  }
}

/**
 * The only place the failure is recorded. `applyDevUpdate` rejects through the
 * ApplyUpdate IPC handler into `UpdateBanner.handleApply`, whose catch only
 * re-enables the button, so without this line the build stderr reaches no log
 * the next person can grep (ISS-12479).
 */
function logDevUpdateBuildFailure(
  entry: string,
  parked: boolean,
  error: unknown
): void {
  const previous = parked ? "restored" : "none to restore";
  gatewayLog.error(
    DEV_UPDATE_LOG_TAG,
    `Dev update build failed; entry ${entry}, previous build ${previous}: ${failureDetail(error)}`
  );
}

/**
 * `promisify(execFile)` attaches the child's captured `stderr` to the rejection
 * alongside the message, so both are read; a failure thrown by this module
 * carries only a message.
 */
function failureDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const parsed = EXEC_FILE_FAILURE.safeParse(error);
  const stderr = parsed.success ? parsed.data.stderr.trim() : "";
  return stderr.length > 0 ? `${message} | stderr: ${stderr}` : message;
}

/**
 * The entry the next `electron .` resolves, read from the package the rebase
 * just updated rather than copied here, so moving the entry cannot leave this
 * check watching a path nothing writes.
 */
async function resolveBuiltEntryPath(repoRoot: string): Promise<string> {
  const manifestPath = path.join(repoRoot, DESKTOP_PACKAGE_DIR, "package.json");
  const manifest = DESKTOP_MANIFEST.parse(
    JSON.parse(await readFile(manifestPath, "utf8"))
  );
  return path.join(repoRoot, DESKTOP_PACKAGE_DIR, manifest.main);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

const DESKTOP_PACKAGE_DIR = "apps/desktop";

/** What the desktop `clean:dist` step removes before the build writes. */
const DESKTOP_DIST_DIR = "dist";

const PARKED_DIST_SUFFIX = ".pre-dev-update";

const DEV_UPDATE_LOG_TAG = "dev-update";

const DESKTOP_MANIFEST = z.object({ main: z.string().min(1) });

const EXEC_FILE_FAILURE = z.object({ stderr: z.string() });

/**
 * The renderer payload for the dev-mode update nudge. Unlike packaged builds
 * there is no download phase: an available update (origin/main ahead of the
 * built commit) is immediately applicable via {@link applyDevUpdate} (git pull
 * --rebase + rebuild + relaunch). We therefore emit the canonical
 * "downloaded"/readyToInstall status so the renderer UpdateBanner shows its
 * Relaunch action right away rather than a passive "available" message.
 */
export const DEV_UPDATE_READY_STATUS = {
  status: "downloaded",
  updateAvailable: true,
  readyToInstall: true,
} as const;
