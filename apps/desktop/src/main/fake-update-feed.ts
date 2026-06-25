/**
 * Test-only seam for exercising the electron-updater lifecycle against a local
 * fixture feed (FEA-2099), without a real release server, code-signing, or
 * notarization.
 *
 * Production desktop builds drive auto-update only when `app.isPackaged` is
 * true (see app.ts). That gate makes the entire updater state machine — and
 * therefore the FEA-2026 before-quit / `finishUpdateInstall` handoff that
 * regressed into the "Restarting…" hang — unreachable from an unpackaged
 * `_electron.launch` e2e run.
 *
 * This module opens a single, env-gated seam so a Playwright Electron e2e can:
 *   1. force the packaged updater path on in an unpackaged dev build, and
 *   2. point electron-updater's generic provider at a localhost fixture server
 *      (a crafted `latest-mac.yml`/`latest.yml` + a dummy newer artifact), and
 *   3. stub the real binary swap at the `finishUpdateInstall` boundary —
 *      `autoUpdater.quitAndInstall` cannot apply an unsigned build and would
 *      hang, which is the opposite of what this guard is meant to assert.
 *
 * The seam is keyed entirely off the `CL_DESKTOP_FAKE_UPDATE_FEED` env var.
 * That var is never set by the app, only by the e2e harness, so the fake-feed
 * branch is dead in every shipped build. Activation deliberately requires BOTH
 * the env var AND `!isPackaged` so it can never alter a real packaged client
 * even if the var leaks into a packaged environment.
 */

/** Env var carrying the localhost fixture feed base URL (set only by e2e). */
export const FAKE_UPDATE_FEED_ENV = "CL_DESKTOP_FAKE_UPDATE_FEED";

/**
 * Marker written to stdout when the before-quit handoff reaches
 * `finishUpdateInstall` under the fake feed. The e2e asserts on this line as
 * the "handoff completed, no hang" signal (the FEA-2026 regression guard).
 */
export const FAKE_UPDATE_HANDOFF_MARKER =
  "[fake-update-feed] finishUpdateInstall handoff complete";

/**
 * The fixture feed base URL when the test seam is active, else null. Trimmed;
 * empty/whitespace is treated as unset.
 */
export function getFakeUpdateFeedUrl(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const raw = env[FAKE_UPDATE_FEED_ENV];
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Whether the packaged-style updater path (electron-updater wiring +
 * `finishUpdateInstall` handoff) should run.
 *
 * True for real packaged builds, OR when the fake-feed env seam is set on an
 * UNPACKAGED build (the e2e case). Packaged builds ignore the env seam: a real
 * client must never have its updater feed redirected by a stray env var.
 */
export function isPackagedUpdateFlowActive(
  isPackaged: boolean,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (isPackaged) {
    return true;
  }
  return getFakeUpdateFeedUrl(env) !== null;
}

/**
 * True when the fake-feed e2e seam is active (unpackaged + env set). Used to
 * stub the real `quitAndInstall` binary swap, which cannot run unsigned.
 */
export function isFakeUpdateFeedActive(
  isPackaged: boolean,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return !isPackaged && getFakeUpdateFeedUrl(env) !== null;
}

/** Minimal surface of `electron-updater`'s AppUpdater used by the seam. */
export type FakeFeedAutoUpdater = {
  forceDevUpdateConfig: boolean;
  autoInstallOnAppQuit: boolean;
  setFeedURL(options: { provider: "generic"; url: string }): void;
};

/**
 * Point electron-updater at the localhost fixture feed via its generic
 * provider — the same provider type production uses (electron-builder.yml
 * `publish.provider: generic`), so the check→download→ready path is exercised
 * for real against crafted metadata.
 *
 * `forceDevUpdateConfig` lets the updater run in an unpackaged build.
 * `autoInstallOnAppQuit` is disabled so a wedged/abandoned run can never try to
 * apply the unsigned dummy artifact on exit.
 */
export function configureFakeUpdateFeed(
  autoUpdater: FakeFeedAutoUpdater,
  feedUrl: string
): void {
  autoUpdater.forceDevUpdateConfig = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.setFeedURL({ provider: "generic", url: feedUrl });
}
