import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { app } from "electron";
import { getResolvedGitPath } from "../../server/operations/symphony-loop.js";
import { BUILD_COMMIT_HASH } from "../../shared/build-info.js";

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
  await execFileAsync(getResolvedGitPath(), ["fetch", "origin", "main"], {
    cwd: repoRoot,
  });
  const { stdout } = await execFileAsync(
    getResolvedGitPath(),
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
    getResolvedGitPath(),
    ["pull", "--rebase", "origin", "main"],
    {
      cwd: repoRoot,
    }
  );
  await execFileAsync("pnpm", ["-C", "apps/desktop", "build"], {
    cwd: repoRoot,
  });
  app.relaunch();
  app.exit(0);
}

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
