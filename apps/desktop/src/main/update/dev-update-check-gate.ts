/**
 * Turns off the unpackaged build's automatic update check, the git probe behind
 * the update banner. The vibe profile sets it (ISS-12135): its Desktop is a dev
 * build of the session's own worktree, so `origin/main` moving ahead is not an
 * update for it, and the banner's Relaunch would `git pull --rebase` that
 * worktree (`applyDevUpdate`). The packaged update lane never reads it.
 */
export const DEV_UPDATE_CHECK_DISABLED_ENV =
  "CL_DESKTOP_DEV_UPDATE_CHECK_DISABLED";

export function isDevUpdateCheckDisabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env[DEV_UPDATE_CHECK_DISABLED_ENV]?.trim() === "1";
}
