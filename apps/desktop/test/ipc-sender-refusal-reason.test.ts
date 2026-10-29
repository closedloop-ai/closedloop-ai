/**
 * @file ipc-sender-refusal-reason.test.ts
 * @description ISS-8776 AC2/AC3 — a refused IPC call must say WHICH refusal it
 * is, and the refusal decision itself must not move.
 *
 * The crash log carried four of these on `desktop:get-runtime-status`:
 *
 *     Error occurred in handler for 'desktop:get-runtime-status': Error: untrusted sender
 *         at assertTrustedIpcSender (…)                                    ×4
 *
 * The ticket asked which of two causes it was — a renderer `WebContents`
 * identity change, or a missing `event.sender`. It was NEITHER. The predicate
 * is a live closure over `deps.desktopWindow`
 * (`desktop-ipc-registration.ts`), so a recreated window's new `WebContents`
 * matches automatically and an identity change cannot produce this. What
 * produces it is `isTrustedRendererSender` FAILING CLOSED on a destroyed
 * window: the unhandled rejection called `app.exit(1)`, that tore the window
 * down while the renderer was still alive, and the renderer's shared
 * runtime-status poll (`use-runtime-status-poll.ts`, `INGEST_POLL_MS = 1000`)
 * kept firing once a second into the teardown — four polls, four refusals,
 * matching the four-second gap between the two log timestamps.
 *
 * So the fix is NOT to relax the guard, and these cases pin that it was not
 * relaxed: every input that was refused before is still refused. What changed
 * is only which fact the refusal states.
 */
import assert from "node:assert/strict";
import type { BrowserWindow, WebContents } from "electron";
import { test } from "vitest";
import { assertTrustedIpcSender } from "../src/main/ipc/ipc-trusted-sender.js";
import {
  isRendererWindowGone,
  isTrustedRendererSender,
} from "../src/main/ipc/renderer-ipc.js";
import {
  type RuntimeInfoIpcDeps,
  registerRuntimeInfoIpcHandlers,
} from "../src/main/ipc/runtime-info-ipc.js";
import {
  RENDERER_WINDOW_GONE_MESSAGE,
  UNTRUSTED_IPC_SENDER_MESSAGE,
} from "../src/shared/ipc-refusal-messages.js";
import { RuntimeInfoIpcChannel } from "../src/shared/runtime-info-ipc-channel.js";

/** A stand-in renderer `WebContents`; only identity matters to the guard. */
const RENDERER = { id: 1 } as unknown as WebContents;
/** A different sender — a genuinely foreign process. */
const FOREIGN = { id: 2 } as unknown as WebContents;

function liveWindow(): BrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: RENDERER,
  } as unknown as BrowserWindow;
}

function destroyedWindow(): BrowserWindow {
  return {
    isDestroyed: () => true,
    get webContents(): WebContents {
      throw new Error("Object has been destroyed");
    },
  } as unknown as BrowserWindow;
}

test("the trust decision is unchanged: only the app's own live renderer passes", () => {
  assert.equal(isTrustedRendererSender(liveWindow(), RENDERER), true);
  assert.equal(isTrustedRendererSender(liveWindow(), FOREIGN), false);
  assert.equal(isTrustedRendererSender(destroyedWindow(), RENDERER), false);
  assert.equal(isTrustedRendererSender(null, RENDERER), false);
});

test("a torn-down window is reported as gone; a live one is not", () => {
  assert.equal(isRendererWindowGone(liveWindow()), false);
  assert.equal(isRendererWindowGone(destroyedWindow()), true);
  assert.equal(isRendererWindowGone(null), true);
});

test("a teardown refusal names the teardown, not an untrusted sender", () => {
  const window = destroyedWindow();
  assert.throws(
    () =>
      assertTrustedIpcSender(
        (sender) => isTrustedRendererSender(window, sender as WebContents),
        { sender: RENDERER },
        () => isRendererWindowGone(window)
      ),
    // The app's OWN renderer, polling a health channel during the app's own
    // exit, must not be described as an untrusted sender.
    new RegExp(RENDERER_WINDOW_GONE_MESSAGE)
  );
});

test("a genuinely foreign sender is still refused as untrusted, window alive", () => {
  const window = liveWindow();
  assert.throws(
    () =>
      assertTrustedIpcSender(
        (sender) => isTrustedRendererSender(window, sender as WebContents),
        { sender: FOREIGN },
        () => isRendererWindowGone(window)
      ),
    new RegExp(UNTRUSTED_IPC_SENDER_MESSAGE)
  );
});

test("the window-gone probe cannot GRANT access — only label a refusal", () => {
  // A probe that lies "the window is gone" must not turn a foreign sender into
  // an accepted one. If the label ever became part of the decision, this is the
  // case that catches it.
  const window = liveWindow();
  assert.throws(
    () =>
      assertTrustedIpcSender(
        (sender) => isTrustedRendererSender(window, sender as WebContents),
        { sender: FOREIGN },
        () => true
      ),
    new RegExp(RENDERER_WINDOW_GONE_MESSAGE),
    "a mislabelled refusal is still a refusal"
  );
  // And the trusted sender is still accepted with the same lying probe.
  assert.doesNotThrow(() =>
    assertTrustedIpcSender(
      (sender) => isTrustedRendererSender(window, sender as WebContents),
      { sender: RENDERER },
      () => true
    )
  );
});

test("the runtime-status registrar actually wires the probe through", () => {
  // The wiring, not the helper: without this, deleting the third argument at
  // the `desktop:get-runtime-status` call site leaves every case above green
  // while the production channel goes back to reporting a teardown as an
  // attack. `get-runtime-status` is the channel a UI polls to discover it is
  // recovering, so it is the one whose failure mode has to be legible.
  const handlers = new Map<string, (event: unknown) => unknown>();
  registerRuntimeInfoIpcHandlers(
    {
      handle: (channel, listener) => {
        handlers.set(channel, listener as (event: unknown) => unknown);
      },
    },
    {
      isTrustedSender: () => false,
      isRendererWindowGone: () => true,
    } as unknown as RuntimeInfoIpcDeps
  );

  const handler = handlers.get(RuntimeInfoIpcChannel.GetRuntimeStatus);
  assert.ok(handler, "the runtime-status channel was registered");
  assert.throws(
    () => handler({ sender: RENDERER }),
    new RegExp(RENDERER_WINDOW_GONE_MESSAGE)
  );
});

test("with no probe wired at all, the message is exactly what it always was", () => {
  const window = liveWindow();
  assert.throws(
    () =>
      assertTrustedIpcSender(
        (sender) => isTrustedRendererSender(window, sender as WebContents),
        { sender: FOREIGN }
      ),
    new RegExp(UNTRUSTED_IPC_SENDER_MESSAGE),
    "every unwired caller keeps today's behavior byte for byte"
  );
});
