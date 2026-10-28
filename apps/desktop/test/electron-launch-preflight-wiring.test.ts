/**
 * ISS-12135: `launchElectronOrExplain` spawns with what the preflight returns.
 * A wrapper that preflighted and then launched the caller's ORIGINAL options
 * would pass every case in `electron-launch-preflight.test.ts`, since only a
 * Desktop build launch is rewritten and that lane has no build.
 */

import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import { launchElectronOrExplain } from "./e2e/helpers/electron-launch-attribution.js";

const { PREFLIGHTED_ARGS } = vi.hoisted(() => ({
  PREFLIGHTED_ARGS: ["preflighted-entry.js", "--preflighted"],
}));

vi.mock("./e2e/helpers/electron-launch-preflight.js", () => ({
  preflightElectronLaunch: () => ({ args: PREFLIGHTED_ARGS }),
}));

describe("launch preflight wiring (ISS-12135)", () => {
  test("the launcher receives the preflighted options, not the caller's", async () => {
    let received: readonly string[] | undefined;

    await launchElectronOrExplain({ args: ["caller-entry.js"] }, (prepared) => {
      received = prepared.args;
      return Promise.resolve("launched");
    });

    assert.deepEqual(received, PREFLIGHTED_ARGS);
  });
});
