/**
 * ISS-12257: the one link the fence and renderer suites do not cover, the
 * `createDesktopSessionReplayDesktopApi` spread in `preload-common.ts`. Drop it,
 * or aim it at a channel main does not register, and main refuses every replay
 * batch while both suites stay green.
 *
 * The chain runs in one pass: the REAL `createDesktopApi`, an `ipcRenderer`
 * stand-in wired to the REAL registered handler, and the REAL fence it feeds.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createDesktopReplayRecordingFence } from "../src/main/auth/desktop-replay-request-auth.js";
import { registerDesktopReplayRecordingIpcHandler } from "../src/main/ipc/desktop-replay-recording-ipc.js";
import { createDesktopApi } from "../src/main/preload-common.js";

const TRUSTED_SENDER = { id: "trusted-renderer" };
const AUTH_GENERATION = 1;

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

describe("desktop session replay preload hop (ISS-12257)", () => {
  it("reportDesktopReplayRecording reaches the fence main registers", async () => {
    const handlers = new Map<string, IpcHandler>();
    const invokedChannels: string[] = [];
    const fence = createDesktopReplayRecordingFence(
      () => true,
      () => AUTH_GENERATION
    );
    registerDesktopReplayRecordingIpcHandler(
      { handle: (channel, listener) => handlers.set(channel, listener) },
      {
        isTrustedSender: (sender) => sender === TRUSTED_SENDER,
        report: fence.report,
      }
    );
    const desktopApi = createDesktopApi({
      invoke: (channel: string, ...args: unknown[]) => {
        invokedChannels.push(channel);
        const handler = handlers.get(channel);
        if (!handler) {
          return Promise.reject(
            new Error(`no main handler registered for ${channel}`)
          );
        }
        return Promise.resolve(handler({ sender: TRUSTED_SENDER }, ...args));
      },
      on: () => undefined,
      removeListener: () => undefined,
      send: () => undefined,
    });
    assert.equal(fence.isCurrent(), false);

    await desktopApi.reportDesktopReplayRecording({
      signedIn: true,
      authGeneration: AUTH_GENERATION,
    });

    // Independent literal, not the exported constant: a channel renamed on
    // the preload side only must fail here rather than pass by construction.
    assert.deepEqual(invokedChannels, ["desktop:report-replay-recording"]);
    assert.equal(fence.isCurrent(), true);
  });
});
