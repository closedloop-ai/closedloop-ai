/**
 * PLN-2162 M4: drives the realtime bridge through the production preload hop:
 * `createDesktopApi().realtime` → an `ipcRenderer` stand-in wired to the REAL
 * registered handlers → the REAL `DesktopRealtimeHost` → its pushes back to the
 * preload's `onEvent`. The doubles are the IPC transport edge and the socket
 * client, so dropping the preload spread, or aiming it at a channel main does
 * not register, reds this.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { RealtimeClient } from "@repo/realtime-client/connection";
import {
  type RealtimeChannelListener,
  RealtimeStatus,
} from "@repo/realtime-client/port";
import {
  ChannelKind,
  formatChannelAddress,
} from "@repo/realtime-contract/channels";
import type { WebContents } from "electron";
import { describe, test } from "vitest";
import { registerDesktopRealtimeIpcHandlers } from "../src/main/ipc/desktop-realtime-ipc.js";
import { createDesktopApi } from "../src/main/preload-common.js";
import { DesktopRealtimeHost } from "../src/main/realtime/desktop-realtime-host.js";
import {
  DesktopRealtimeEventKind,
  desktopRealtimeJoinResultSchema,
} from "../src/shared/desktop-realtime-contract.js";

const CHANNEL = formatChannelAddress(
  ChannelKind.Comments,
  "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b",
  ["artifact-1"]
);

describe("desktop realtime preload hop (PLN-2162 M4)", () => {
  test("join, the ack push and leave cross the preload to main's host and back", async () => {
    const hop = createHop();
    const events: unknown[] = [];
    const unsubscribe = hop.api.realtime.onEvent((event) => events.push(event));

    const joined = desktopRealtimeJoinResultSchema.parse(
      await hop.api.realtime.join({ channel: CHANNEL })
    );
    hop.listeners.get(CHANNEL)?.dataLoadedAt?.();

    assert.deepEqual(joined, {
      status: RealtimeStatus.Connecting,
      joined: false,
    });
    assert.deepEqual(events, [
      {
        event: DesktopRealtimeEventKind.Status,
        status: RealtimeStatus.Connecting,
      },
      { event: DesktopRealtimeEventKind.Joined, channel: CHANNEL },
    ]);

    await hop.api.realtime.leave({ channel: CHANNEL });
    assert.deepEqual(hop.leaves, [CHANNEL]);
    assert.deepEqual(
      events.at(-1),
      { event: DesktopRealtimeEventKind.Status, status: RealtimeStatus.Closed },
      "the last leave closes the client"
    );
    const heard = events.length;

    unsubscribe();
    hop.listeners.get(CHANNEL)?.onResync();
    assert.equal(events.length, heard, "no event after unsubscribe");
  });
});

function createHop() {
  const handlers = new Map<
    string,
    (event: { sender: WebContents }, payload?: unknown) => unknown
  >();
  const listeners = new Map<string, RealtimeChannelListener>();
  const leaves: string[] = [];
  const host = new DesktopRealtimeHost({
    getAccountAdmission: () => ({
      userId: "user-1",
      organizationId: "org-1",
      generation: 1,
    }),
    fetchToken: () => Promise.reject(new Error("not used")),
    clientVersion: "test",
    createClient: (): RealtimeClient => ({
      join: (channel, listener) => {
        listeners.set(channel, listener);
        return () => leaves.push(channel);
      },
      status: () => RealtimeStatus.Connecting,
      onStatus: () => () => undefined,
      close: () => undefined,
    }),
  });
  registerDesktopRealtimeIpcHandlers(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    { isTrustedSender: () => true, host }
  );

  const renderer = new EventEmitter();
  const sender = Object.assign(new EventEmitter(), {
    id: 3,
    mainFrame: { isDestroyed: () => false },
    isDestroyed: () => false,
    send: (channel: string, ...args: unknown[]) =>
      renderer.emit(channel, {}, ...args),
  });
  const ipcRenderer = {
    invoke: (channel: string, ...args: unknown[]) => {
      const handler = handlers.get(channel);
      if (handler === undefined) {
        return Promise.reject(
          new Error(`No handler registered for '${channel}'`)
        );
      }
      return Promise.resolve(
        handler({ sender: sender as unknown as WebContents }, ...args)
      );
    },
    send: () => undefined,
    on: (channel: string, listener: (...args: never[]) => void) => {
      renderer.on(channel, listener as RendererListener);
    },
    removeListener: (channel: string, listener: (...args: never[]) => void) => {
      renderer.removeListener(channel, listener as RendererListener);
    },
  };
  return { api: createDesktopApi(ipcRenderer), listeners, leaves };
}

type RendererListener = (...args: unknown[]) => void;
