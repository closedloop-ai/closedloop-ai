import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyMacOverlayWorkaround,
  MAC_DISABLE_OVERLAYS_SWITCH,
} from "../src/main/lifecycle/gpu-overlay-workaround.js";

const DISABLE_MAC_OVERLAYS_LOG_PATTERN = /disable-mac-overlays/;

type AppendedSwitch = { theSwitch: string; value?: string };

function makeCommandLine(recorded: AppendedSwitch[]) {
  return {
    appendSwitch: (theSwitch: string, value?: string) => {
      recorded.push({ theSwitch, value });
    },
  };
}

test("appends --disable-mac-overlays on darwin", () => {
  const appended: AppendedSwitch[] = [];
  const logs: string[] = [];

  const result = applyMacOverlayWorkaround({
    commandLine: makeCommandLine(appended),
    platform: "darwin",
    log: (message) => logs.push(message),
  });

  assert.equal(result, true);
  assert.deepEqual(appended, [
    { theSwitch: MAC_DISABLE_OVERLAYS_SWITCH, value: undefined },
  ]);
  assert.equal(MAC_DISABLE_OVERLAYS_SWITCH, "disable-mac-overlays");
  assert.equal(logs.length, 1);
  assert.match(logs[0], DISABLE_MAC_OVERLAYS_LOG_PATTERN);
});

test("does nothing on non-darwin platforms", () => {
  for (const platform of ["linux", "win32"] as const) {
    const appended: AppendedSwitch[] = [];
    const logs: string[] = [];

    const result = applyMacOverlayWorkaround({
      commandLine: makeCommandLine(appended),
      platform,
      log: (message) => logs.push(message),
    });

    assert.equal(result, false, `expected no-op on ${platform}`);
    assert.deepEqual(
      appended,
      [],
      `expected no switch appended on ${platform}`
    );
    assert.deepEqual(logs, [], `expected no log on ${platform}`);
  }
});

test("omitting the optional log does not throw on darwin", () => {
  const appended: AppendedSwitch[] = [];

  const result = applyMacOverlayWorkaround({
    commandLine: makeCommandLine(appended),
    platform: "darwin",
  });

  assert.equal(result, true);
  assert.deepEqual(appended, [
    { theSwitch: MAC_DISABLE_OVERLAYS_SWITCH, value: undefined },
  ]);
});
