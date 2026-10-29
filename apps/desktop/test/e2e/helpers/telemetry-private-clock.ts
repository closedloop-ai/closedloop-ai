import { fileURLToPath } from "node:url";
import { _electron as electron, type Page } from "@playwright/test";
import type { DesktopApi } from "../../../src/renderer/types/desktop-api.js";
import { LOCAL_SESSION_SOURCE_STATUSES } from "../../../src/shared/local-session-source-status.js";
import { launchAuthenticatedDesktopApp as launchOriginal } from "./authenticated-desktop-app.js";
import { MAIN_JS } from "./desktop-app.js";
import { launchElectronOrExplain } from "./electron-launch-attribution.js";

import { captureTelemetryClockExit } from "./telemetry-clock-receipt.js";

const preload = fileURLToPath(
  new URL("./telemetry-private-clock-preload.cjs", import.meta.url)
);
declare global {
  var __closedloopTelemetryTestClock:
    | {
        requestOneCadence: () => unknown;
        snapshot: () => {
          actualCallbacks: number;
          advances: number;
          completionPending: boolean;
          errors: unknown[];
          dateIdentityUnchanged: boolean;
        };
      }
    | undefined;
}

/** Clock only the real seeded launch; bootstrap remains the original helper. */
export async function launchClockedAuthenticatedDesktopApp(
  options: Parameters<typeof launchOriginal>[0]
) {
  if (options.launchElectron) {
    throw new Error(
      "Telemetry clock adapter refuses competing launch ownership."
    );
  }
  const launched = await launchOriginal({
    ...options,
    launchElectron: async (launchOptions = {}) => {
      const args = [...(launchOptions.args ?? [])];
      const index = args.indexOf(MAIN_JS);
      if (index < 0 || args.filter((arg) => arg === MAIN_JS).length !== 1) {
        throw new Error("Unique original MAIN required.");
      }
      args.splice(index, 0, "-r", preload);
      const app = await launchElectronOrExplain(
        { ...launchOptions, args },
        (prepared) => electron.launch(prepared)
      );
      try {
        captureTelemetryClockExit(app);
        return app;
      } catch (error) {
        try {
          await app.close();
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Telemetry receipt setup and original child cleanup failed."
          );
        }
        throw error;
      }
    },
  });
  return launched;
}

/** Request one canonical period without delaying the original HTTP deadline. */
export function advanceTelemetryCadence(
  app: Awaited<ReturnType<typeof launchOriginal>>["app"]
) {
  return app.evaluate(() => {
    const owner = globalThis.__closedloopTelemetryTestClock;
    if (!owner) {
      throw new Error("Telemetry pre-MAIN clock owner missing.");
    }
    return owner.requestOneCadence();
  });
}

/** Reject clock-fixture errors after the unchanged final product assertions. */
export function verifyTelemetryClockCompleted(
  app: Awaited<ReturnType<typeof launchOriginal>>["app"]
) {
  return app.evaluate(() => {
    const owner = globalThis.__closedloopTelemetryTestClock;
    if (!owner) {
      throw new Error("Telemetry clock owner missing at final observation.");
    }
    const state = owner.snapshot();
    if (
      state.actualCallbacks !== 2 ||
      state.advances !== 2 ||
      state.completionPending ||
      state.errors.length ||
      !state.dateIdentityUnchanged
    ) {
      throw new Error(
        "Telemetry clock callbacks/completion/error/Date contract failed."
      );
    }
    return state;
  });
}

/** Reuse the real runtime status within the original upload observer deadline. */
export async function requestFirstTelemetryCadenceWhenReady(
  page: Page,
  app: Awaited<ReturnType<typeof launchOriginal>>["app"]
): Promise<boolean> {
  const status = await page.evaluate(() =>
    (window.desktopApi as DesktopApi).getAgentMonitorUrl()
  );
  if (status.localSessionSourceStatus !== LOCAL_SESSION_SOURCE_STATUSES.ready) {
    return false;
  }
  await advanceTelemetryCadence(app);
  return true;
}
