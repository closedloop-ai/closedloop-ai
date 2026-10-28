/**
 * ISS-5808: Electron E2E regression for the Requests view's LIVE refresh.
 *
 * The reported defect only exists in the launched app: the Requests page read
 * its store once on mount and then showed that snapshot for as long as it
 * stayed open. A mounted renderer test with a mocked `desktopApi` cannot catch
 * that; it proves the component re-reads a mock, not that the real preload →
 * `getActivityEvents` → `ActivityLogStore` path reaches the screen (review
 * #4783). Hence this spec.
 *
 * HOW THE STATE CHANGE IS DRIVEN: the spec sends one request to the launched
 * gateway after the view has finished its mount-time read. The gateway router
 * records every `/api/gateway/*` request it answers, and `ActivityLogStore`
 * appends it in memory, so the next read returns it. With no navigation, no
 * reload and no click, the only thing that can put that row on screen is the
 * view re-reading on its own: with the poll removed the row never appears and
 * this spec fails.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { DESKTOP_REQUESTS_LIVE_REFRESH_FEATURE_FLAG_KEY } from "../../src/shared/desktop-requests-live-refresh-flag";
import {
  gotoNav,
  launchDesktopApp,
  seedDesktopFeatureFlags,
} from "./helpers/desktop-app";

/**
 * Where `gateway-listen-gate-preload.cjs` redirects the gateway's port
 * discovery write for an isolated launch profile.
 */
const DISCOVERY_FILE_SEGMENTS = [".closedloop-ai", "electron-port"] as const;

/** A gateway path no route serves, so the request has no side effect. */
const PROBE_PATH = "/api/gateway/iss-5808-live-refresh-probe";

/** `ActivityPanel`'s blocking load state. */
const LOADING_TEXT = "Loading...";

/**
 * Comfortably past the view's 5s refresh interval. Traced live at ~6s locally
 * on the job version of this spec; 30s leaves headroom on a slow CI runner.
 */
const REFRESH_OBSERVATION_TIMEOUT_MS = 30_000;
const MOUNT_TIMEOUT_MS = 30_000;
const PORT_DISCOVERY_TIMEOUT_MS = 30_000;
const PORT_PATTERN = /^\d+$/;

function readGatewayPort(userDataDir: string): number | null {
  try {
    const raw = fs
      .readFileSync(path.join(userDataDir, ...DISCOVERY_FILE_SEGMENTS), "utf8")
      .trim();
    return PORT_PATTERN.test(raw) ? Number(raw) : null;
  } catch {
    return null;
  }
}

test.describe("Requests view live refresh (ISS-5808)", () => {
  test("shows a gateway request that arrives while the view is open, without a reload", async () => {
    // Generous against the sum of the explicit timeouts below, so a slow
    // runner fails on an ASSERTION with a named locator rather than on an
    // unattributable test-level timeout.
    test.setTimeout(240_000);

    const { page, pageErrors, cleanup, userDataDir } = await launchDesktopApp({
      userDataPrefix: "desktop-requests-live-refresh-e2e-",
      beforeLaunch: (launchUserDataDir) => {
        // Default-off Labs gate: the live behavior does not exist until it is
        // seeded on, so this call is what puts the spec on the gated path.
        seedDesktopFeatureFlags(launchUserDataDir, {
          [DESKTOP_REQUESTS_LIVE_REFRESH_FEATURE_FLAG_KEY]: true,
        });
      },
    });

    try {
      await gotoNav(page, "requests");
      await expect(
        page.getByRole("heading", { level: 1, name: "Requests" })
      ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
      // The mount-time read has settled, so a row that shows up after the
      // request below cannot have come from it.
      await expect(page.getByText(LOADING_TEXT, { exact: true })).toHaveCount(
        0,
        { timeout: MOUNT_TIMEOUT_MS }
      );
      const probeRow = page.getByText(PROBE_PATH);
      await expect(probeRow).toHaveCount(0);

      await expect
        .poll(() => readGatewayPort(userDataDir), {
          message: "the launched gateway must publish its port",
          timeout: PORT_DISCOVERY_TIMEOUT_MS,
        })
        .not.toBeNull();
      const port = readGatewayPort(userDataDir);
      const response = await fetch(`http://127.0.0.1:${port}${PROBE_PATH}`);
      // Drain the body so the gateway's `finish` (which records the request)
      // has fired before the poll is observed.
      await response.text();

      await expect(probeRow).toBeVisible({
        timeout: REFRESH_OBSERVATION_TIMEOUT_MS,
      });

      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});
