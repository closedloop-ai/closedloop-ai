/**
 * E2E: desktop auto-update lifecycle against a local fake update feed (FEA-2099).
 *
 * Regression-guards the FEA-2026 "Restarting…" hang: the before-quit handler
 * must hand the install + relaunch to the updater via `finishUpdateInstall()`
 * (instead of force-exiting the process mid-shutdown, which left the renderer
 * wedged on "Restarting…"). There is otherwise no automated coverage of the
 * update lifecycle.
 *
 * How it stays hermetic — no real release server, no code-signing/notarization:
 *   - A localhost fixture server (helpers/fake-update-feed) serves crafted
 *     electron-updater channel metadata advertising a newer version.
 *   - The app is launched with CL_DESKTOP_FAKE_UPDATE_FEED set (see
 *     src/main/fake-update-feed.ts), which (a) forces the packaged updater path
 *     on in this unpackaged build, (b) points electron-updater's generic
 *     provider at the fixture, and (c) stubs the real `quitAndInstall` binary
 *     swap — which cannot apply an unsigned build and would itself hang.
 *   - The real `checkForUpdates()` runs and `update-available` fires against the
 *     fixture (proving feed wiring); the download→ready transition is then
 *     advanced deterministically in main so this test does not depend on a
 *     flaky native binary download.
 *
 * Boundary (documented, by design): this asserts the boot → check → available →
 * ready → install/quit *handoff* and the no-hang invariant. Real signed/
 * notarized binary replacement stays on the macOS release lane (the manual E2E
 * owed by FEA-2026) — explicitly out of scope per FEA-2099.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import { expect, test } from "@playwright/test";
import { FAKE_UPDATE_HANDOFF_MARKER } from "../../src/main/fake-update-feed.js";
import { launchDesktopApp } from "./helpers/desktop-app";
import {
  FAKE_FEED_UPDATE_VERSION,
  startFakeUpdateFeed,
} from "./helpers/fake-update-feed";

/** Bounded ceiling for the whole check → apply → handoff → exit sequence. */
const HANDOFF_DEADLINE_MS = 30_000;

test.describe("Auto-update flow (fake feed)", () => {
  test("drives update-available → ready → install handoff without hanging", async () => {
    test.setTimeout(90_000);

    const feed = await startFakeUpdateFeed();

    const { app, page, cleanup } = await launchDesktopApp({
      userDataPrefix: "desktop-autoupdate-e2e-",
      env: { CL_DESKTOP_FAKE_UPDATE_FEED: feed.url },
    });

    // Capture the main process stdout so we can assert on the deterministic
    // handoff marker `finishUpdateInstall()` emits under the fake feed.
    const child = app.process();
    let mainStdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      mainStdout += chunk.toString("utf8");
    });

    // The renderer-facing ready state is asserted below via the
    // `desktop:check-for-update` IPC (step 2), which returns the same
    // packagedUpdateState the preload re-broadcasts as `desktop:update-status`.
    // We do not attach a `desktop:update-status` CustomEvent listener here: the
    // boot-time check fires that broadcast before this spec could register a
    // listener, so capturing it live would be inherently racy — the IPC poll is
    // the deterministic read of the same state.

    let processExited = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    const exitPromise = new Promise<void>((resolve) => {
      child.once("exit", (code, signal) => {
        processExited = true;
        exitCode = code;
        exitSignal = signal;
        resolve();
      });
    });

    try {
      // 1) The fixture feed is actually hit by electron-updater's real check.
      await expect
        .poll(() => feed.channelRequestCount(), {
          message: "electron-updater should fetch the fixture channel file",
          timeout: 20_000,
        })
        .toBeGreaterThan(0);

      // 2) The app advances to the ready-to-install state for the new version.
      //    Poll the gateway/renderer status surface, which reflects
      //    packagedUpdateState after the fake-feed download promotion.
      const readyStatus = await page.evaluate(async (expectedVersion) => {
        const desktopApi = (
          window as unknown as {
            desktopApi?: {
              checkForUpdate?: () => Promise<{
                readyToInstall?: boolean;
                version?: string;
                status?: string;
              }>;
            };
          }
        ).desktopApi;
        // checkForUpdate() returns the current packaged update status payload
        // in the packaged/fake-feed flow. Poll it until ready.
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          const status = await desktopApi?.checkForUpdate?.();
          if (
            status?.readyToInstall === true &&
            status?.version === expectedVersion
          ) {
            return status;
          }
          await new Promise((r) => setTimeout(r, 250));
        }
        return await desktopApi?.checkForUpdate?.();
      }, FAKE_FEED_UPDATE_VERSION);

      expect(
        readyStatus?.readyToInstall,
        "update should reach readyToInstall against the fake feed"
      ).toBe(true);
      expect(readyStatus?.version).toBe(FAKE_FEED_UPDATE_VERSION);

      // 3) Trigger apply. This sets applyingDownloadedUpdate and calls
      //    app.quit(), which fires the before-quit handler → graceful shutdown
      //    → finishUpdateInstall() handoff (the FEA-2026 path).
      await page.evaluate(() => {
        const desktopApi = (
          window as unknown as {
            desktopApi?: { applyUpdate?: () => Promise<unknown> };
          }
        ).desktopApi;
        // Fire-and-forget: the IPC round-trip races the app quitting, so the
        // promise may never settle (the process exits first). Swallow any
        // rejection so it can't surface as an unhandled rejection in main.
        desktopApi?.applyUpdate?.()?.catch(() => {
          // ignored — app is quitting
        });
      });

      // 4) The no-hang invariant: the process must exit within the bounded
      //    deadline (a wedged "Restarting…" hang would never resolve this).
      const exitedInTime = await Promise.race([
        exitPromise.then(() => true),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), HANDOFF_DEADLINE_MS)
        ),
      ]);

      expect(
        exitedInTime,
        `app should reach the update handoff and exit within ${HANDOFF_DEADLINE_MS}ms (FEA-2026 no-hang guard)`
      ).toBe(true);

      // 4b) Clean exit, not a crash: a SIGKILL/SIGSEGV or non-zero code would
      //     also satisfy "exited in time", so distinguish the graceful
      //     finishUpdateInstall handoff (exit 0) from an abnormal termination.
      expect(
        { exitCode, exitSignal },
        "update handoff should exit cleanly (code 0, no signal)"
      ).toEqual({ exitCode: 0, exitSignal: null });

      // 5) The handoff actually ran finishUpdateInstall (not a force-exit):
      //    the deterministic marker proves the before-quit continuation reached
      //    the updater hand-off seam after graceful cleanup. Poll rather than
      //    read once — the final stdout chunk can arrive after the `exit` event
      //    (write-then-quit flush ordering is not guaranteed).
      await expect
        .poll(() => mainStdout, {
          message:
            "finishUpdateInstall handoff marker should appear in main stdout",
          timeout: 5000,
        })
        .toContain(FAKE_UPDATE_HANDOFF_MARKER);
    } finally {
      // The app has (in the happy path) already exited; cleanup is still safe.
      if (processExited) {
        // Process already gone — only remove the temp profile.
        await cleanup().catch(() => {});
      } else {
        await cleanup();
      }
      await feed.close().catch(() => {});
    }
  });
});
