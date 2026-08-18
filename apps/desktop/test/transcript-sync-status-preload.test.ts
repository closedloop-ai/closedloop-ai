/**
 * ISS-4719: renderer preload bridge for the transcript-sync status snapshot.
 *
 * The main-process handler (`desktop:get-transcript-sync-status`, registered in
 * `src/main/ipc/runtime-info-ipc.ts`) computes the honest per-file
 * "N of M bytes uploaded" archive-lane state, but it was never exposed on
 * `window.desktopApi`, so the renderer had no way to call it. This suite pins
 * the preload bridge: `getTranscriptSyncStatus()` invokes the correct channel
 * with no args and returns the `{ enabled, online, files[] }` snapshot shape
 * verbatim (the preload is a pure passthrough — it must not drop or reshape the
 * per-file byte offsets the handler produced).
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { RuntimeInfoIpcChannel } from "../src/main/ipc/runtime-info-ipc.js";
import { createDesktopApi } from "../src/main/preload-common.js";
import {
  emptyTranscriptStatusCounts,
  TranscriptEgressGate,
  TranscriptSyncStatus,
  type TranscriptSyncStatusSnapshot,
} from "../src/shared/transcript-sync-status-contract.js";

type Listener = (...args: never[]) => void;

function makeFakeIpc(resolveValue: unknown) {
  const invokes: Array<{ channel: string; args: unknown[] }> = [];
  return {
    invokes,
    ipc: {
      invoke: (channel: string, ...args: unknown[]) => {
        invokes.push({ channel, args });
        return Promise.resolve(resolveValue);
      },
      send: () => undefined,
      on: (_channel: string, _listener: Listener) => undefined,
      removeListener: (_channel: string, _listener: Listener) => undefined,
    },
  };
}

describe("transcript-sync status preload bridge (ISS-4719)", () => {
  test("getTranscriptSyncStatus invokes the status channel with no args", async () => {
    const snapshot: TranscriptSyncStatusSnapshot = {
      enabled: false,
      online: false,
      tierGate: TranscriptEgressGate.Denied,
      storeReady: false,
      statusCounts: emptyTranscriptStatusCounts(),
    };
    const { ipc, invokes } = makeFakeIpc(snapshot);
    const api = createDesktopApi(ipc);

    await api.getTranscriptSyncStatus();

    assert.deepEqual(invokes, [
      { channel: RuntimeInfoIpcChannel.GetTranscriptSyncStatus, args: [] },
    ]);
  });

  test("getTranscriptSyncStatus returns the { enabled, online, statusCounts } snapshot verbatim", async () => {
    const snapshot: TranscriptSyncStatusSnapshot = {
      enabled: true,
      online: true,
      tierGate: TranscriptEgressGate.Allowed,
      storeReady: true,
      statusCounts: {
        ...emptyTranscriptStatusCounts(),
        [TranscriptSyncStatus.Uploading]: 2,
      },
    };
    const { ipc } = makeFakeIpc(snapshot);
    const api = createDesktopApi(ipc);

    const result = await api.getTranscriptSyncStatus();

    // Pure passthrough: the census and gate computed in main must reach the
    // renderer unchanged, not be dropped or reshaped by the bridge.
    assert.deepEqual(result, snapshot);
  });
});
