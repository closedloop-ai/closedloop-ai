/**
 * Unit tests for apps/desktop/src/main/renderer-ipc.ts
 *
 * Covers:
 *   - sendToRendererWindow guards null / destroyed / disposed-frame teardown
 *     states (the macOS sleep/wake "Render frame was disposed" crash) and only
 *     sends to a healthy renderer.
 *   - evaluateRenderProcessGone reload policy: skips clean exits and teardown,
 *     reloads on abnormal disappearance, and trips the rolling-window
 *     reload-loop breaker.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CRASH_RELOAD_WINDOW_MS,
  evaluateRenderProcessGone,
  isFrameDisposed,
  MAX_CRASH_RELOADS,
  sendToRendererWindow,
} from "../src/main/renderer-ipc.js";
import { fakeWindow, type SendCall } from "./helpers/fake-window.js";

test("sendToRendererWindow drops when the window is gone", () => {
  assert.equal(sendToRendererWindow(null, "desktop:ping"), false);
});

test("sendToRendererWindow drops a destroyed window without touching webContents", () => {
  // webContentsThrows would blow up if the helper read `.webContents`; the
  // window-level isDestroyed() guard must short-circuit first.
  const window = fakeWindow({
    windowDestroyed: true,
    webContentsThrows: new Error("Object has been destroyed"),
  });
  let result: boolean | undefined;
  assert.doesNotThrow(() => {
    result = sendToRendererWindow(window, "desktop:ping");
  });
  assert.equal(result, false);
});

test("sendToRendererWindow drops when webContents is destroyed", () => {
  const calls: SendCall[] = [];
  const sent = sendToRendererWindow(
    fakeWindow({ contentsDestroyed: true, calls }),
    "desktop:ping"
  );
  assert.equal(sent, false);
  assert.equal(calls.length, 0);
});

test("sendToRendererWindow swallows a throwing webContents getter on a torn-down window", () => {
  const window = fakeWindow({
    webContentsThrows: new Error("Object has been destroyed"),
  });
  let result: boolean | undefined;
  assert.doesNotThrow(() => {
    result = sendToRendererWindow(window, "desktop:command-keys-changed");
  });
  assert.equal(result, false);
});

test("sendToRendererWindow forwards channel and args to a healthy renderer", () => {
  const calls: SendCall[] = [];
  const sent = sendToRendererWindow(
    fakeWindow({ calls }),
    "desktop:db:changed",
    { sessionId: "s1" }
  );
  assert.equal(sent, true);
  assert.deepEqual(calls, [
    { channel: "desktop:db:changed", args: [{ sessionId: "s1" }] },
  ]);
});

test("sendToRendererWindow swallows the disposed-frame error instead of throwing", () => {
  const window = fakeWindow({
    throwOnSend: new Error(
      "Render frame was disposed before WebFrameMain could be accessed"
    ),
  });
  let result: boolean | undefined;
  assert.doesNotThrow(() => {
    result = sendToRendererWindow(window, "desktop:command-keys-changed");
  });
  assert.equal(result, false);
});

test("evaluateRenderProcessGone skips a clean exit", () => {
  const decision = evaluateRenderProcessGone({
    reason: "clean-exit",
    disposing: false,
    quitting: false,
    now: 1000,
    reloadTimestamps: [],
  });
  assert.equal(decision.reload, false);
  assert.deepEqual(decision.reloadTimestamps, []);
});

test("evaluateRenderProcessGone skips while disposing or quitting", () => {
  for (const flag of ["disposing", "quitting"] as const) {
    const decision = evaluateRenderProcessGone({
      reason: "crashed",
      disposing: flag === "disposing",
      quitting: flag === "quitting",
      now: 1000,
      reloadTimestamps: [],
    });
    assert.equal(decision.reload, false, flag);
  }
});

test("evaluateRenderProcessGone reloads on abnormal disappearance and records the attempt", () => {
  const decision = evaluateRenderProcessGone({
    reason: "crashed",
    disposing: false,
    quitting: false,
    now: 1000,
    reloadTimestamps: [],
  });
  assert.equal(decision.reload, true);
  assert.deepEqual(decision.reloadTimestamps, [1000]);
});

test("evaluateRenderProcessGone prunes timestamps outside the rolling window", () => {
  const stale = 100;
  const now = stale + CRASH_RELOAD_WINDOW_MS + 1;
  const decision = evaluateRenderProcessGone({
    reason: "killed",
    disposing: false,
    quitting: false,
    now,
    reloadTimestamps: [stale],
  });
  // The stale attempt aged out, so this reload is allowed and the stale entry
  // is dropped from the persisted list.
  assert.equal(decision.reload, true);
  assert.deepEqual(decision.reloadTimestamps, [now]);
});

test("evaluateRenderProcessGone trips the reload-loop breaker at the cap", () => {
  const recent = Array.from({ length: MAX_CRASH_RELOADS }, (_, i) => 1000 + i);
  const decision = evaluateRenderProcessGone({
    reason: "crashed",
    disposing: false,
    quitting: false,
    now: 1100,
    reloadTimestamps: recent,
  });
  assert.equal(decision.reload, false);
  // The breaker preserves the in-window attempts; it does not add a new one.
  assert.deepEqual(decision.reloadTimestamps, recent);
});

test("evaluateRenderProcessGone reloads on frame-disposed reason", () => {
  const decision = evaluateRenderProcessGone({
    reason: "frame-disposed",
    disposing: false,
    quitting: false,
    now: 1000,
    reloadTimestamps: [],
  });
  assert.equal(decision.reload, true);
  assert.deepEqual(decision.reloadTimestamps, [1000]);
});

test("isFrameDisposed returns false for a null window", () => {
  assert.equal(isFrameDisposed(null), false);
});

test("isFrameDisposed returns false for a destroyed window", () => {
  assert.equal(isFrameDisposed(fakeWindow({ windowDestroyed: true })), false);
});

test("isFrameDisposed returns false when webContents is destroyed", () => {
  assert.equal(isFrameDisposed(fakeWindow({ contentsDestroyed: true })), false);
});

test("isFrameDisposed returns false when frame is alive", () => {
  assert.equal(isFrameDisposed(fakeWindow({})), false);
});

test("isFrameDisposed returns true when mainFrame is destroyed", () => {
  assert.equal(isFrameDisposed(fakeWindow({ frameDestroyed: true })), true);
});

test("isFrameDisposed returns true when webContents getter throws", () => {
  assert.equal(
    isFrameDisposed(
      fakeWindow({
        webContentsThrows: new Error(
          "Render frame was disposed before WebFrameMain could be accessed"
        ),
      })
    ),
    true
  );
});

test("sendToRendererWindow returns false early when mainFrame is destroyed (no send called)", () => {
  const calls: SendCall[] = [];
  const sent = sendToRendererWindow(
    fakeWindow({ frameDestroyed: true, calls }),
    "desktop:db:changed",
    { sessionId: "s1" }
  );
  assert.equal(sent, false);
  assert.equal(calls.length, 0);
});
