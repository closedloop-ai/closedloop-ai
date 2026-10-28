/**
 * @file dev-update-check-gate.test.ts
 * @description ISS-12135: a vibe-profile Desktop never runs the dev update check,
 * so it never shows the update banner; every other launch keeps its check.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vibeProfileLaunchEnv } from "../scripts/vibe-profile/launch-env";
import {
  DEV_UPDATE_CHECK_DISABLED_ENV,
  isDevUpdateCheckDisabled,
} from "../src/main/update/dev-update-check-gate.js";
import {
  createWiringLane,
  type HarnessOptions,
  resetWiringHarness,
  restoreWiringHarness,
  timers,
  updater,
} from "./helpers/auto-update-wiring-harness.js";

vi.mock("electron-updater", async () => {
  const { updater: double } = await import(
    "./helpers/auto-update-wiring-harness.js"
  );
  return { default: { autoUpdater: double.stub }, autoUpdater: double.stub };
});

vi.mock("electron", async () => {
  const stub = await import("./helpers/electron-module-stub.js");
  return { ...stub, default: stub.default };
});

const { installDesktopUpdateLane } = await import(
  "../src/main/update/auto-update-wiring.js"
);

const ORIGINS = {
  apiOrigin: "http://localhost:3201",
  webOrigin: "http://localhost:3200",
};
const PAST_ONE_POLL_MS = 5 * 60 * 1000 + 1;
const originalGate = process.env[DEV_UPDATE_CHECK_DISABLED_ENV];

function startWiring(options: HarnessOptions = {}) {
  const lane = createWiringLane(options);
  installDesktopUpdateLane(lane.deps)();
  return lane;
}

beforeEach(() => {
  resetWiringHarness();
  Reflect.deleteProperty(process.env, DEV_UPDATE_CHECK_DISABLED_ENV);
});

afterEach(() => {
  restoreWiringHarness();
  vi.useRealTimers();
  if (originalGate === undefined) {
    Reflect.deleteProperty(process.env, DEV_UPDATE_CHECK_DISABLED_ENV);
  } else {
    process.env[DEV_UPDATE_CHECK_DISABLED_ENV] = originalGate;
  }
});

describe("isDevUpdateCheckDisabled", () => {
  it("is on only for the value the vibe profile sets", () => {
    expect(
      isDevUpdateCheckDisabled({ [DEV_UPDATE_CHECK_DISABLED_ENV]: "1" })
    ).toBe(true);
    expect(isDevUpdateCheckDisabled({})).toBe(false);
    expect(
      isDevUpdateCheckDisabled({ [DEV_UPDATE_CHECK_DISABLED_ENV]: "" })
    ).toBe(false);
    expect(
      isDevUpdateCheckDisabled({ [DEV_UPDATE_CHECK_DISABLED_ENV]: "0" })
    ).toBe(false);
  });
});

describe("dev update lane with the check disabled", () => {
  it("never probes, polls or nudges the renderer", async () => {
    vi.useFakeTimers();
    process.env[DEV_UPDATE_CHECK_DISABLED_ENV] = "1";
    const { deps } = startWiring({
      isPackaged: false,
      devUpdateAvailable: () => Promise.resolve({ updateAvailable: true }),
    });

    await vi.advanceTimersByTimeAsync(PAST_ONE_POLL_MS * 3);

    expect(deps.checkForUpdate).not.toHaveBeenCalled();
    expect(deps.setUpdateCheckTimer).not.toHaveBeenCalled();
    expect(deps.notifyRendererDevUpdateReady).not.toHaveBeenCalled();
  });

  it("still nudges when the check is not disabled", async () => {
    const { deps, devUpdateNudged } = startWiring({
      isPackaged: false,
      devUpdateAvailable: () => Promise.resolve({ updateAvailable: true }),
    });

    await devUpdateNudged;
    expect(deps.notifyRendererDevUpdateReady).toHaveBeenCalledTimes(1);
    expect(timers).toHaveLength(1);
  });

  it("leaves the packaged update lane checking", async () => {
    process.env[DEV_UPDATE_CHECK_DISABLED_ENV] = "1";
    const { downloadGuarded } = startWiring({ isPackaged: true });

    await downloadGuarded;
    expect(updater.stub.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(timers).toHaveLength(1);
  });
});

describe("vibe profile launch environment", () => {
  it("turns the dev update check off for the vibe Desktop", () => {
    const { env } = vibeProfileLaunchEnv("/synthetic/profile", ORIGINS);

    expect(isDevUpdateCheckDisabled(env)).toBe(true);
  });
});
