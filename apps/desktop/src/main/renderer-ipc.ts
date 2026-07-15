/**
 * @file renderer-ipc.ts
 * @description Crash-safe helpers for talking to the renderer from the main
 * process. Extracted from window.ts so the guard and the render-process
 * recovery policy are pure and unit-testable without an Electron runtime.
 */

import type { BrowserWindow } from "electron";
import { gatewayLog } from "./gateway-logger.js";

// Reload-loop breaker for render-process-gone recovery: at most this many
// reload attempts inside the rolling window before we give up and leave the
// window as-is (so a renderer that crashes on every load can't spin forever).
export const MAX_CRASH_RELOADS = 3;
export const CRASH_RELOAD_WINDOW_MS = 60_000;

/**
 * Returns true when the renderer's Chromium frame has been disposed even though
 * the BrowserWindow and WebContents wrappers are still alive. Accessing
 * `webContents.mainFrame` itself throws when the frame is gone, so this is a
 * try/catch probe rather than a clean boolean predicate.
 */
export function isFrameDisposed(window: BrowserWindow | null): boolean {
  if (!window || window.isDestroyed()) {
    return false;
  }
  try {
    const contents = window.webContents;
    if (contents.isDestroyed()) {
      return false;
    }
    return contents.mainFrame.isDestroyed();
  } catch {
    return true;
  }
}

/**
 * Best-effort IPC send to a renderer. Returns true if the message was handed to
 * Electron, false if it was dropped.
 *
 * Guards the three teardown states that all make `webContents.send` throw, and
 * which routinely occur on macOS sleep/wake when the renderer is reaped while
 * the main process still holds a live `BrowserWindow`:
 *   1. the window is gone (null),
 *   2. the `webContents` is destroyed (`isDestroyed()` reports it),
 *   3. the render frame was disposed even though the `WebContents` wrapper is
 *      still alive — "Render frame was disposed before WebFrameMain could be
 *      accessed" — which `isDestroyed()` does NOT report, so it can only be
 *      caught.
 *
 * State 3 is now also caught by a `mainFrame.isDestroyed()` pre-check, which
 * prevents Electron's internal `webFrameMain.send()` wrapper from logging to
 * stderr before re-throwing.
 */
export function sendToRendererWindow(
  window: BrowserWindow | null,
  channel: string,
  ...args: unknown[]
): boolean {
  if (!window || window.isDestroyed()) {
    return false;
  }
  try {
    // Read webContents inside the try: on a destroyed-but-not-null window the
    // native getter itself can throw "Object has been destroyed" before the
    // isDestroyed()/send guards below run.
    const contents = window.webContents;
    if (contents.isDestroyed()) {
      return false;
    }
    if (contents.mainFrame.isDestroyed()) {
      return false;
    }
    contents.send(channel, ...args);
    return true;
  } catch (error) {
    gatewayLog.warn(
      "renderer-ipc",
      `Dropped "${channel}": ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

/**
 * Decides whether to reload the renderer after a `render-process-gone` event,
 * applying the rolling-window reload-loop breaker. Pure (no Electron, no clock)
 * so the recovery policy is unit-testable; the caller supplies `now` and the
 * prior reload timestamps and persists the returned list.
 */
export function evaluateRenderProcessGone(input: {
  reason: string;
  disposing: boolean;
  quitting: boolean;
  now: number;
  reloadTimestamps: readonly number[];
}): { reload: boolean; reloadTimestamps: number[] } {
  const pruned = input.reloadTimestamps.filter(
    (timestamp) => input.now - timestamp < CRASH_RELOAD_WINDOW_MS
  );
  // "clean-exit" is the normal teardown path (dispose/quit/intentional close);
  // only an abnormal disappearance leaves a live window showing a blank frame.
  if (
    input.disposing ||
    input.quitting ||
    input.reason === "clean-exit" ||
    pruned.length >= MAX_CRASH_RELOADS
  ) {
    return { reload: false, reloadTimestamps: pruned };
  }
  return { reload: true, reloadTimestamps: [...pruned, input.now] };
}

/**
 * Pure decision function for frame-disposal recovery. Encapsulates the full
 * guard sequence from `DesktopWindow.checkFrameHealthAndRecover` so the
 * production code and tests share the same logic.
 */
export function evaluateFrameRecovery(input: {
  window: BrowserWindow | null;
  disposing: boolean;
  quitting: boolean;
  recovering: boolean;
  now: number;
  reloadTimestamps: readonly number[];
}): { shouldReload: boolean; reloadTimestamps: number[] } {
  if (!input.window || input.window.isDestroyed()) {
    return {
      shouldReload: false,
      reloadTimestamps: [...input.reloadTimestamps],
    };
  }
  if (input.disposing || input.quitting || input.recovering) {
    return {
      shouldReload: false,
      reloadTimestamps: [...input.reloadTimestamps],
    };
  }
  if (!isFrameDisposed(input.window)) {
    return {
      shouldReload: false,
      reloadTimestamps: [...input.reloadTimestamps],
    };
  }
  const decision = evaluateRenderProcessGone({
    reason: "frame-disposed",
    disposing: input.disposing,
    quitting: input.quitting,
    now: input.now,
    reloadTimestamps: input.reloadTimestamps,
  });
  return {
    shouldReload: decision.reload,
    reloadTimestamps: decision.reloadTimestamps,
  };
}
