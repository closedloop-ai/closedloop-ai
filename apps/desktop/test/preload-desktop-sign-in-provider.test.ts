/**
 * ISS-5112 — the preload bridge is the one seam between the renderer's pick and
 * the main process that validates it, and it is a bare pass-through with no
 * logic of its own. That is exactly why it needs a test: every OTHER stage of
 * the provider hint is asserted (the click site, the IPC parse, the URL
 * builder), so deleting the argument HERE is invisible to all of them while
 * every desktop sign-in silently loses the provider the user picked.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DesktopSignInProvider } from "@repo/api/src/types/desktop-authorize-url";
import { createDesktopApi } from "../src/main/preload-common.js";

const BEGIN_SIGN_IN_CHANNEL = "desktop:begin-desktop-sign-in";

type Listener = (...args: never[]) => void;

// Same shape as the other preload-bridge stubs in this directory: the event
// members are part of what `createDesktopApi` accepts, not optional extras.
function createIpcStub() {
  const calls: { channel: string; args: unknown[] }[] = [];
  return {
    calls,
    ipc: {
      invoke: (channel: string, ...args: unknown[]) => {
        calls.push({ channel, args });
        return Promise.resolve({ ok: true });
      },
      send: () => undefined,
      on: (_channel: string, _listener: Listener) => undefined,
      removeListener: (_channel: string, _listener: Listener) => undefined,
    },
  };
}

test("beginDesktopSignIn forwards the picked provider over IPC", async () => {
  const { ipc, calls } = createIpcStub();

  await createDesktopApi(ipc).beginDesktopSignIn(DesktopSignInProvider.Google);

  const call = calls.find((c) => c.channel === BEGIN_SIGN_IN_CHANNEL);
  assert.ok(call, "the begin-sign-in channel was invoked");
  assert.deepEqual(call.args, [DesktopSignInProvider.Google]);
});

test("beginDesktopSignIn sends no provider when the caller names none", async () => {
  // The renderer's email pick and any older caller land here. `undefined` has to
  // reach main as an absent hint rather than being substituted for something.
  const { ipc, calls } = createIpcStub();

  await createDesktopApi(ipc).beginDesktopSignIn();

  const call = calls.find((c) => c.channel === BEGIN_SIGN_IN_CHANNEL);
  assert.ok(call, "the begin-sign-in channel was invoked");
  assert.deepEqual(call.args, [undefined]);
});
