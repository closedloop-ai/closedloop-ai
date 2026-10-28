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
 *     src/main/update/fake-update-feed.ts), which (a) forces the packaged updater path
 *     on in this unpackaged build, (b) points electron-updater's generic
 *     provider at the fixture, and (c) stubs the real `quitAndInstall` binary
 *     swap — which cannot apply an unsigned build and would itself hang.
 *   - The real `checkForUpdates()` runs and `update-available` fires against the
 *     fixture (proving feed wiring); the download→ready transition is then
 *     advanced deterministically in main so this test does not depend on a
 *     flaky native binary download.
 *
 * Boundary (documented, by design): this asserts the boot → check → available →
 * ready → install/quit *handoff*, the no-hang invariant, and the ISS-9164
 * attribution headers a real electron-updater check puts on the wire. It cannot
 * assert the DOWNLOAD's headers — `autoDownload` is off under the fake feed, so
 * no artifact request is ever made; that half is pinned in
 * `test/auto-update-request-headers.test.ts`. Real signed/
 * notarized binary replacement stays on the macOS release lane (the manual E2E
 * owed by FEA-2026) — explicitly out of scope per FEA-2099.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import { expect, test } from "@playwright/test";
import { FAKE_UPDATE_HANDOFF_MARKER } from "../../src/main/update/fake-update-feed.js";
import { UPDATE_BANNER_READY_TEST_ID } from "../../src/renderer/components/update-banner-state.js";
import { launchDesktopApp } from "./helpers/desktop-app.js";
import {
  FAKE_FEED_UPDATE_VERSION,
  startFakeUpdateFeed,
} from "./helpers/fake-update-feed.js";
import {
  parkedGatewayListens,
  releaseGatewayListen,
} from "./helpers/gateway-listen-gate.js";

/** Bounded ceiling for the whole check → apply → handoff → exit sequence. */
const HANDOFF_DEADLINE_MS = 30_000;

/**
 * ISS-9164 wire spellings, written out rather than imported from the contract
 * module (`@repo/api/src/types/desktop-client-attribution`) for the same reason
 * its unit sibling does: importing the constant would make a rename invisible
 * here, and this assertion exists to catch exactly that.
 */
const CLIENT_VERSION_HEADER = "x-desktop-client-version";
const COMPUTE_TARGET_ID_HEADER = "x-desktop-compute-target-id";

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

      // 1b) …and the check carried what ISS-9164 says it carries. The count
      //     above proves a request happened; only the headers prove what it
      //     carried, so a provider that dropped or renamed these would still
      //     satisfy step 1 (davetho, #6867). The version is the positive
      //     control: if the fixture retained nothing, it would be absent too and
      //     the compute-target assertion below would pass vacuously.
      //
      //     Held against what this build actually reports, not a release-semver
      //     shape: `app.getVersion()` is Electron's empty-manifest sentinel
      //     "0.0" under the harness's unpackaged `dist/main` launch (FEA-2199,
      //     `src/main/util/desktop-service-version.ts`), so a `\d+.\d+.\d+`
      //     shape is a contract only a PACKAGED build can meet — which this one
      //     is not, and never will be. Equality still fails on an absent,
      //     renamed, or wrong-valued header, which is the whole control.
      const [checkHeaders] = feed.channelRequestHeaders();
      const attestedVersion = await app.evaluate(({ app: electronApp }) =>
        electronApp.getVersion()
      );
      // Without this the control can go vacuous: were the app to report nothing
      // AND the header be absent, the equality below would compare undefined to
      // undefined and pass.
      expect(attestedVersion, "the app must report some version").toBeTruthy();
      expect(
        checkHeaders?.[CLIENT_VERSION_HEADER],
        "the updater check should attest this build's version"
      ).toBe(attestedVersion);
      expect(
        checkHeaders?.[COMPUTE_TARGET_ID_HEADER],
        "an unauthenticated launch has no compute target to attest"
      ).toBeUndefined();

      // 2) The app advances to the ready-to-install state for the new version.
      //    Poll the gateway/renderer status surface, which reflects
      //    packagedUpdateState after the fake-feed download promotion.
      // checkForUpdate() returns the current packaged update status payload
      // in the packaged/fake-feed flow. Poll it until ready.
      await expect
        .poll(
          () =>
            page.evaluate(async () => {
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
              return await desktopApi?.checkForUpdate?.();
            }),
          {
            message: "update should reach readyToInstall against the fake feed",
            timeout: 15_000,
            intervals: [250],
          }
        )
        .toMatchObject({
          readyToInstall: true,
          version: FAKE_FEED_UPDATE_VERSION,
        });

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

  // ISS-11447: a check that fails after the update is ready must leave it ready.
  // The unit suites mimic electron-updater's check-failure detail; here the real
  // updater emits it against a feed that has started answering 500.
  test("keeps the relaunch action after a follow-up check fails", async () => {
    test.setTimeout(90_000);

    const feed = await startFakeUpdateFeed();
    const { app, page, cleanup } = await launchDesktopApp({
      userDataPrefix: "desktop-autoupdate-check-failure-e2e-",
      env: { CL_DESKTOP_FAKE_UPDATE_FEED: feed.url },
    });
    const child = app.process();
    let mainStdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      mainStdout += chunk.toString("utf8");
    });
    let processExited = false;
    let exitStatus: { code: number | null; signal: NodeJS.Signals | null } = {
      code: null,
      signal: null,
    };
    const exitPromise = new Promise<void>((resolve) => {
      child.once("exit", (code, signal) => {
        processExited = true;
        exitStatus = { code, signal };
        resolve();
      });
    });
    const checkForUpdate = () =>
      page.evaluate(async () => {
        const desktopApi = (
          window as unknown as {
            desktopApi?: {
              checkForUpdate?: () => Promise<{
                readyToInstall?: boolean;
                version?: string;
                error?: string;
              }>;
            };
          }
        ).desktopApi;
        return await desktopApi?.checkForUpdate?.();
      });

    try {
      await expect
        .poll(checkForUpdate, { timeout: 15_000, intervals: [250] })
        .toMatchObject({
          readyToInstall: true,
          version: FAKE_FEED_UPDATE_VERSION,
        });
      const ready = page.getByTestId(UPDATE_BANNER_READY_TEST_ID);
      await expect(ready).toBeVisible();

      feed.failChannelRequests();
      const servedBeforeFailure = feed.channelRequestCount();
      const failedCheck = await checkForUpdate();

      expect(
        feed.channelRequestCount(),
        "the follow-up check should reach the failing feed"
      ).toBeGreaterThan(servedBeforeFailure);
      expect(
        failedCheck?.error,
        "the follow-up check should fail"
      ).toBeTruthy();

      await ready.getByRole("button").click();
      const exitedInTime = await Promise.race([
        exitPromise.then(() => true),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), HANDOFF_DEADLINE_MS)
        ),
      ]);
      expect(
        exitedInTime,
        "the relaunch action should still hand off to the updater"
      ).toBe(true);
      expect(exitStatus).toEqual({ code: 0, signal: null });
      await expect
        .poll(() => mainStdout, { timeout: 5000 })
        .toContain(FAKE_UPDATE_HANDOFF_MARKER);
    } finally {
      if (processExited) {
        await cleanup().catch(() => {});
      } else {
        await cleanup();
      }
      await feed.close().catch(() => {});
    }
  });

  // ISS-10291: the renderer's check IPC is live from the constructor, before
  // boot starts the update checks. An update that check finds must reach the
  // banner, not only the updater's own download.
  test("shows the banner for an update a renderer check finds before boot starts the checks", async () => {
    test.setTimeout(90_000);

    const feed = await startFakeUpdateFeed();
    const { app, page, cleanup } = await launchDesktopApp({
      userDataPrefix: "desktop-autoupdate-preboot-e2e-",
      env: { CL_DESKTOP_FAKE_UPDATE_FEED: feed.url },
      gatewayListenGate: true,
    });

    try {
      // Boot is parked on the gateway bind, so it has not checked: the
      // renderer's check below is the first request the feed sees.
      await expect.poll(() => parkedGatewayListens(app)).toBeGreaterThan(0);
      expect(feed.channelRequestCount()).toBe(0);

      await page.evaluate(async () => {
        const desktopApi = (
          window as unknown as {
            desktopApi?: { checkForUpdate?: () => Promise<unknown> };
          }
        ).desktopApi;
        await desktopApi?.checkForUpdate?.();
      });

      expect(feed.channelRequestCount()).toBeGreaterThan(0);
      await expect(page.getByTestId(UPDATE_BANNER_READY_TEST_ID)).toBeVisible();
    } finally {
      await releaseGatewayListen(app).catch(() => {});
      await cleanup();
      await feed.close().catch(() => {});
    }
  });
});
