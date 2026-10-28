/**
 * @file renderer-ipc.ts
 * @description Crash-safe helpers for talking to the renderer from the main
 * process. Extracted from window.ts so the guard and the render-process
 * recovery policy are pure and unit-testable without an Electron runtime.
 */

import type { BrowserWindow, WebContents } from "electron";
import { gatewayLog } from "../logging/gateway-logger.js";

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
  let contents: WebContents;
  try {
    // On a destroyed-but-not-null window the native getter itself can throw
    // "Object has been destroyed" before the guards below run.
    contents = window.webContents;
  } catch (error) {
    warnDroppedSend(channel, error);
    return false;
  }
  return sendToRendererContents(contents, channel, ...args);
}

/**
 * The outcome of one reload decision. `budgetExhausted` is the DERIVED half and
 * the reason it is not inferable from `reload: false`: teardown and a tripped
 * breaker both decline to reload, but only the second means recovery gave up on
 * a window the user is still looking at (ISS-6331). Callers report those
 * differently, so the decision function has to say which one it made.
 */
export type RenderProcessGoneDecision = {
  reload: boolean;
  budgetExhausted: boolean;
  reloadTimestamps: number[];
};

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
}): RenderProcessGoneDecision {
  const pruned = input.reloadTimestamps.filter(
    (timestamp) => input.now - timestamp < CRASH_RELOAD_WINDOW_MS
  );
  // "clean-exit" is the normal teardown path (dispose/quit/intentional close);
  // only an abnormal disappearance leaves a live window showing a blank frame.
  // All three report NO exhaustion, for the same reason they decline to reload:
  // none of them is the breaker giving up on a window the user is still looking
  // at. `disposing`/`quitting` are the app going away; `clean-exit` is a
  // renderer this build already classifies as an intentional close, and
  // reclassifying it is a behavior change beyond ISS-6331.
  if (input.disposing || input.quitting || input.reason === "clean-exit") {
    return { reload: false, budgetExhausted: false, reloadTimestamps: pruned };
  }
  if (pruned.length >= MAX_CRASH_RELOADS) {
    return { reload: false, budgetExhausted: true, reloadTimestamps: pruned };
  }
  return {
    reload: true,
    budgetExhausted: false,
    reloadTimestamps: [...pruned, input.now],
  };
}

/** {@link evaluateFrameRecovery}'s verdict; the sibling of {@link RenderProcessGoneDecision}. */
export type FrameRecoveryDecision = {
  shouldReload: boolean;
  budgetExhausted: boolean;
  reloadTimestamps: number[];
};

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
}): FrameRecoveryDecision {
  if (!input.window || input.window.isDestroyed()) {
    return declineFrameRecovery(input.reloadTimestamps);
  }
  if (input.disposing || input.quitting || input.recovering) {
    return declineFrameRecovery(input.reloadTimestamps);
  }
  if (!isFrameDisposed(input.window)) {
    return declineFrameRecovery(input.reloadTimestamps);
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
    // The breaker is shared with `render-process-gone`, so exhaustion has to be
    // reported from this path too — a frame disposed on the fourth sleep/wake
    // inside the window leaves the same blank, un-retried app (ISS-6331).
    budgetExhausted: decision.budgetExhausted,
    reloadTimestamps: decision.reloadTimestamps,
  };
}

/** No recovery, no verdict on the budget, timestamps untouched. */
function declineFrameRecovery(
  reloadTimestamps: readonly number[]
): FrameRecoveryDecision {
  return {
    shouldReload: false,
    budgetExhausted: false,
    reloadTimestamps: [...reloadTimestamps],
  };
}

/**
 * True when an IPC event came from `window`'s renderer. Backs
 * `DesktopWindow.isTrustedSender`, and lives here for the same reason as its
 * siblings above: the teardown states are only reachable in production, so the
 * guard has to be drivable without an Electron runtime.
 *
 * Fails closed on a destroyed window. A destroyed-but-not-null `BrowserWindow`
 * makes even READING `.webContents` throw "Object has been destroyed", so the
 * former `sender === window?.webContents` — whose `?.` covers null only — threw
 * out of every IPC handler gated on it once the window went away with invokes
 * still in flight (quit, or an `app.exit()` from the process error handlers).
 * A sender that cannot be verified is not trusted, so the handler takes its
 * normal untrusted-sender rejection path instead of raising.
 */
export function isTrustedRendererSender(
  window: BrowserWindow | null,
  sender: WebContents
): boolean {
  // The `!window` arm is a compiler narrowing guard, not a second copy of the
  // policy: what counts as "gone" stays owned by the predicate below, and a
  // null window is refused by it too.
  if (!window || isRendererWindowGone(window)) {
    return false;
  }
  return sender === window.webContents;
}

/**
 * True when there is no live renderer window to compare a sender against.
 *
 * ISS-8776 — the DECISION half of {@link isTrustedRendererSender}'s fail-closed
 * branch, split out so a caller can report WHY a sender was refused without
 * changing whether it was. Both states still refuse; nothing here widens trust.
 *
 * The distinction is load-bearing during teardown. `app.exit()` from the
 * process error handlers destroys the window while the renderer is still alive
 * and still polling `desktop:get-runtime-status` once a second, so every one of
 * those polls arrives with no window to verify against and is refused. Reported
 * as `untrusted sender` — the message this guard threw for every refusal — that
 * reads as a foreign process attacking the IPC surface, and it sent the ISS-8776
 * triage looking for a renderer-identity bug that does not exist. It is a
 * lifecycle fact, and it has to say so.
 */
export function isRendererWindowGone(window: BrowserWindow | null): boolean {
  return !window || window.isDestroyed();
}

/**
 * {@link sendToRendererWindow} for a caller that holds the `WebContents`, such
 * as an IPC handler answering its sender. Same guards, same drop.
 */
export function sendToRendererContents(
  contents: WebContents,
  channel: string,
  ...args: unknown[]
): boolean {
  try {
    if (contents.isDestroyed()) {
      return false;
    }
    if (contents.mainFrame.isDestroyed()) {
      return false;
    }
    contents.send(channel, ...args);
    return true;
  } catch (error) {
    warnDroppedSend(channel, error);
    return false;
  }
}

function warnDroppedSend(channel: string, error: unknown): void {
  gatewayLog.warn(
    "renderer-ipc",
    `Dropped "${channel}": ${error instanceof Error ? error.message : String(error)}`
  );
}
