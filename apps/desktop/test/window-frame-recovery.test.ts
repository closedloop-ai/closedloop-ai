/**
 * Unit tests for the frame-disposal recovery logic in DesktopWindow
 * (apps/desktop/src/main/window.ts) — FEA-2386.
 *
 * These tests drive the production `evaluateFrameRecovery` function that
 * `DesktopWindow.checkFrameHealthAndRecover` calls. This is the same code
 * path the production triggers (focus/show/resume/GPU-crash) execute.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluateFrameRecovery,
  MAX_CRASH_RELOADS,
} from "../src/main/renderer-ipc.js";
import { fakeWindow } from "./helpers/fake-window.js";

test("frame recovery skips when window is null", () => {
  const result = evaluateFrameRecovery({
    window: null,
    disposing: false,
    quitting: false,
    recovering: false,
    now: 1000,
    reloadTimestamps: [],
  });
  assert.equal(result.shouldReload, false);
});

test("frame recovery skips when window is destroyed", () => {
  const result = evaluateFrameRecovery({
    window: fakeWindow({ windowDestroyed: true }),
    disposing: false,
    quitting: false,
    recovering: false,
    now: 1000,
    reloadTimestamps: [],
  });
  assert.equal(result.shouldReload, false);
});

test("frame recovery skips when disposing", () => {
  const result = evaluateFrameRecovery({
    window: fakeWindow({ frameDestroyed: true }),
    disposing: true,
    quitting: false,
    recovering: false,
    now: 1000,
    reloadTimestamps: [],
  });
  assert.equal(result.shouldReload, false);
});

test("frame recovery skips when quitting", () => {
  const result = evaluateFrameRecovery({
    window: fakeWindow({ frameDestroyed: true }),
    disposing: false,
    quitting: true,
    recovering: false,
    now: 1000,
    reloadTimestamps: [],
  });
  assert.equal(result.shouldReload, false);
});

test("frame recovery is a no-op when frame is alive", () => {
  const result = evaluateFrameRecovery({
    window: fakeWindow({}),
    disposing: false,
    quitting: false,
    recovering: false,
    now: 1000,
    reloadTimestamps: [],
  });
  assert.equal(result.shouldReload, false);
});

test("frame recovery triggers reload when frame is disposed", () => {
  const result = evaluateFrameRecovery({
    window: fakeWindow({ frameDestroyed: true }),
    disposing: false,
    quitting: false,
    recovering: false,
    now: 1000,
    reloadTimestamps: [],
  });
  assert.equal(result.shouldReload, true);
  assert.deepEqual(result.reloadTimestamps, [1000]);
});

test("frame recovery triggers reload when mainFrame access throws", () => {
  const result = evaluateFrameRecovery({
    window: fakeWindow({
      webContentsThrows: new Error(
        "Render frame was disposed before WebFrameMain could be accessed"
      ),
    }),
    disposing: false,
    quitting: false,
    recovering: false,
    now: 1000,
    reloadTimestamps: [],
  });
  assert.equal(result.shouldReload, true);
  assert.deepEqual(result.reloadTimestamps, [1000]);
});

test("frame recovery respects reload-loop breaker", () => {
  const recent = Array.from({ length: MAX_CRASH_RELOADS }, (_, i) => 900 + i);
  const result = evaluateFrameRecovery({
    window: fakeWindow({ frameDestroyed: true }),
    disposing: false,
    quitting: false,
    recovering: false,
    now: 1000,
    reloadTimestamps: recent,
  });
  assert.equal(result.shouldReload, false);
  assert.deepEqual(result.reloadTimestamps, recent);
});

test("concurrent triggers: recovering guard prevents duplicate reloads", () => {
  const window = fakeWindow({ frameDestroyed: true });
  const first = evaluateFrameRecovery({
    window,
    disposing: false,
    quitting: false,
    recovering: false,
    now: 1000,
    reloadTimestamps: [],
  });
  assert.equal(first.shouldReload, true);

  const second = evaluateFrameRecovery({
    window,
    disposing: false,
    quitting: false,
    recovering: true,
    now: 1001,
    reloadTimestamps: first.reloadTimestamps,
  });
  assert.equal(second.shouldReload, false);
});
