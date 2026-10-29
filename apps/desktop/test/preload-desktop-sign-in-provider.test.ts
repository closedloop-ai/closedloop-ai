/**
 * ISS-5112 — the preload bridge is the one seam between the renderer's pick and
 * the main process that validates it, and it is a bare pass-through with no
 * logic of its own. That is exactly why it needs a test: every OTHER stage of
 * the provider hint is asserted (the click site, the IPC parse, the URL
 * builder), so deleting the argument HERE is invisible to all of them while
 * every desktop sign-in silently loses the provider the user picked.
 */

import assert from "node:assert/strict";
import {
  DesktopSignInFraming,
  DesktopSignInMethod,
  DesktopSignInProvider,
} from "@repo/api/src/types/desktop-authorize-url";
import { test } from "vitest";
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
  assert.deepEqual(call.args, [
    DesktopSignInProvider.Google,
    undefined,
    undefined,
    undefined,
  ]);
});

// ISS-5954 M2/M5 — the email pick is an explicit wire value now, not the
// absent hint (absent means GitHub on the web side), and the typed address
// rides along for the prefill.
test("beginDesktopSignIn forwards the email method and hint over IPC", async () => {
  const { ipc, calls } = createIpcStub();

  await createDesktopApi(ipc).beginDesktopSignIn(
    DesktopSignInMethod.Email,
    "kerensa+desktop@closedloop.ai",
    DesktopSignInFraming.SignIn
  );

  const call = calls.find((c) => c.channel === BEGIN_SIGN_IN_CHANNEL);
  assert.ok(call, "the begin-sign-in channel was invoked");
  assert.deepEqual(call.args, [
    DesktopSignInMethod.Email,
    "kerensa+desktop@closedloop.ai",
    DesktopSignInFraming.SignIn,
    undefined,
  ]);
});

test("beginDesktopSignIn sends no provider when the caller names none", async () => {
  // An older caller that names nothing lands here. `undefined` has to reach
  // main as an absent hint rather than being substituted for something.
  const { ipc, calls } = createIpcStub();

  await createDesktopApi(ipc).beginDesktopSignIn();

  const call = calls.find((c) => c.channel === BEGIN_SIGN_IN_CHANNEL);
  assert.ok(call, "the begin-sign-in channel was invoked");
  assert.deepEqual(call.args, [undefined, undefined, undefined, undefined]);
});

// ISS-11345 — the fourth argument is what holds a gated card's sign-in for the
// account confirmation; dropped here, main adopts the browser's account unseen.
test("beginDesktopSignIn forwards the sign-in options over IPC", async () => {
  const { ipc, calls } = createIpcStub();

  await createDesktopApi(ipc).beginDesktopSignIn(
    undefined,
    undefined,
    undefined,
    { confirmAccount: true }
  );

  const call = calls.find((c) => c.channel === BEGIN_SIGN_IN_CHANNEL);
  assert.ok(call, "the begin-sign-in channel was invoked");
  assert.deepEqual(call.args, [
    undefined,
    undefined,
    undefined,
    { confirmAccount: true },
  ]);
});
