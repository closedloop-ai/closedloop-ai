/**
 * @file renderer-lifecycle-ipc.test.ts
 * @description ISS-9175 — the `desktop:renderer-ready` listener is gated on
 * the trusted sender like its two siblings, and its two post-yield sends go
 * through the production `sendToRendererWindow` guard, so a disposed render
 * frame (which `isDestroyed()` does not report) is dropped instead of throwing
 * out of the fire-and-forget listener. Only the send path is pinned here: a
 * throw from `handleRendererReady` or a readiness probe still rejects.
 */
import assert from "node:assert/strict";
import type { BrowserWindow, WebContents } from "electron";
import { test } from "vitest";
import { sendToRendererWindow } from "../src/main/ipc/renderer-ipc.js";
import { registerRendererLifecycleIpcHandlers } from "../src/main/ipc/renderer-lifecycle-ipc.js";
import { RendererLifecycleIpcChannel } from "../src/shared/renderer-lifecycle-ipc-channel.js";
import { RendererReadyPhase } from "../src/shared/renderer-ready-phase.js";

type Listener = (
  event: { sender: WebContents },
  ...args: unknown[]
) => void | Promise<void>;

type FakeSender = WebContents & { sent: string[]; sendCalls: number };

function makeSender(options: {
  destroyed?: boolean;
  frameDisposed?: boolean;
  sendImpl?: (channel: string, sent: string[]) => void;
}): FakeSender {
  const sent: string[] = [];
  const sender = {
    sent,
    sendCalls: 0,
    isDestroyed: () => options.destroyed ?? false,
    mainFrame: { isDestroyed: () => options.frameDisposed ?? false },
    send(channel: string) {
      sender.sendCalls += 1;
      if (options.sendImpl) {
        options.sendImpl(channel, sent);
        return;
      }
      sent.push(channel);
    },
  };
  return sender as unknown as FakeSender;
}

function wire(
  sender: FakeSender,
  options: {
    trusted?: boolean;
    trustedSequence?: boolean[];
    shuttingDown?: boolean;
    sourceReady?: boolean;
  } = {}
) {
  const window = {
    isDestroyed: () => false,
    webContents: sender,
  } as unknown as BrowserWindow;
  const listeners = new Map<string, Listener>();
  const calls: string[] = [];
  registerRendererLifecycleIpcHandlers(
    {
      on: (channel, listener) => {
        listeners.set(channel, listener);
      },
    },
    {
      isTrustedSender: () =>
        options.trustedSequence?.shift() ?? options.trusted ?? true,
      handleRendererReady: (_sender, phase) => {
        calls.push(`handleRendererReady:${phase}`);
      },
      yieldToMainLoop: () => {
        calls.push("yieldToMainLoop");
        return Promise.resolve();
      },
      sendToRenderer: (channel, ...args) =>
        sendToRendererWindow(window, channel, ...args),
      isShuttingDown: () => {
        calls.push("isShuttingDown");
        return options.shuttingDown ?? false;
      },
      isLocalSessionSourceReady: () => {
        calls.push("isLocalSessionSourceReady");
        return options.sourceReady ?? true;
      },
      notifyInitialRendererLiveDbIdle: () => calls.push("liveDbIdle"),
      notifyRendererUserInput: () => calls.push("userInput"),
    }
  );
  const ready = listeners.get(RendererLifecycleIpcChannel.RendererReady);
  if (!ready) {
    throw new Error("RendererReady listener must be registered");
  }
  return {
    calls,
    emitReady: (phase: unknown = RendererReadyPhase.Mounted) =>
      Promise.resolve(ready({ sender }, phase)),
  };
}

// ---------------------------------------------------------------------------
// Locking tests: behaviour that holds on main today and must keep holding.
// ---------------------------------------------------------------------------

test("trusted sender with a ready local source gets db:ready then db:changed", async () => {
  const sender = makeSender({});
  const { calls, emitReady } = wire(sender);
  await emitReady();
  assert.deepEqual(sender.sent, ["desktop:db:ready", "desktop:db:changed"]);
  assert.deepEqual(calls, [
    `handleRendererReady:${RendererReadyPhase.Mounted}`,
    "yieldToMainLoop",
    "isShuttingDown",
    "isLocalSessionSourceReady",
  ]);
});

test("an unknown phase narrows to Shell before reaching handleRendererReady", async () => {
  const sender = makeSender({});
  const { calls, emitReady } = wire(sender);
  await emitReady("not-a-phase");
  assert.equal(calls[0], `handleRendererReady:${RendererReadyPhase.Shell}`);
});

test("navigation readiness is accepted without duplicating the database ack", async () => {
  const sender = makeSender({});
  const { calls, emitReady } = wire(sender);
  await emitReady(RendererReadyPhase.NavigationReady);
  assert.deepEqual(calls, [
    `handleRendererReady:${RendererReadyPhase.NavigationReady}`,
  ]);
  assert.deepEqual(sender.sent, []);
});

test("nothing is sent while shutting down", async () => {
  const sender = makeSender({});
  const { emitReady } = wire(sender, { shuttingDown: true });
  await emitReady();
  assert.deepEqual(sender.sent, []);
});

test("nothing is sent to a destroyed sender", async () => {
  const sender = makeSender({ destroyed: true });
  const { emitReady } = wire(sender);
  await emitReady();
  assert.deepEqual(sender.sent, []);
});

test("nothing is sent when the local session source is not ready", async () => {
  const sender = makeSender({});
  const { emitReady } = wire(sender, { sourceReady: false });
  await emitReady();
  assert.deepEqual(sender.sent, []);
});

// ---------------------------------------------------------------------------
// ISS-9175: the guards.
// ---------------------------------------------------------------------------

test("an untrusted sender is rejected before handleRendererReady, the yield, or any readiness probe", async () => {
  const sender = makeSender({});
  const { calls, emitReady } = wire(sender, { trusted: false });
  await emitReady();
  assert.deepEqual(calls, []);
  assert.deepEqual(sender.sent, []);
});

test("a sender replaced during the yield receives no database ack", async () => {
  const sender = makeSender({});
  const { emitReady } = wire(sender, { trustedSequence: [true, false] });
  await emitReady();
  assert.deepEqual(sender.sent, []);
});

test("a send that throws after the yield (frame disposed, isDestroyed still false) does not reject the listener", async () => {
  const sender = makeSender({
    sendImpl: () => {
      throw new Error(
        "Render frame was disposed before WebFrameMain could be accessed"
      );
    },
  });
  const { emitReady } = wire(sender);
  await assert.doesNotReject(() => emitReady());
  assert.deepEqual(sender.sent, []);
});

test("a disposed render frame is caught by the pre-check, so send is never called", async () => {
  const sender = makeSender({ frameDisposed: true });
  const { emitReady } = wire(sender);
  await assert.doesNotReject(() => emitReady());
  assert.equal(sender.sendCalls, 0);
});

test("first send succeeds and the second throws: the listener still resolves", async () => {
  const sender = makeSender({
    sendImpl: (channel, sent) => {
      if (sent.length === 1) {
        throw new Error("Object has been destroyed");
      }
      sent.push(channel);
    },
  });
  const { emitReady } = wire(sender);
  await assert.doesNotReject(() => emitReady());
  assert.deepEqual(sender.sent, ["desktop:db:ready"]);
});
