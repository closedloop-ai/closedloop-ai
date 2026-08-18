import assert from "node:assert/strict";
import { test } from "node:test";
import { DesktopSignInProvider } from "@repo/api/src/types/desktop-authorize-url";
import {
  DESKTOP_AUTH_IPC_CHANNELS,
  DesktopAuthIpcChannel,
  type DesktopAuthManagerPort,
  registerDesktopAuthIpcHandlers,
} from "../src/main/ipc/desktop-auth-ipc.js";
import type {
  DesktopAuthState,
  DesktopBrowserSignInResult,
} from "../src/main/session/desktop-session-manager.js";

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

const UNTRUSTED_SENDER_ERROR = /untrusted sender/;
const TRUSTED_EVENT = { sender: "trusted" };

const AUTH_STATE: DesktopAuthState = {
  status: "authenticated",
  userId: "user-1",
  organizationId: "org-1",
};

function createManagerStub(overrides: Partial<DesktopAuthManagerPort> = {}): {
  manager: DesktopAuthManagerPort;
  calls: {
    begin: number;
    /** What the handler actually forwarded on the LAST begin call. */
    beginProvider: DesktopSignInProvider | undefined;
    cancel: number;
    signOut: number;
  };
} {
  const calls: {
    begin: number;
    beginProvider: DesktopSignInProvider | undefined;
    cancel: number;
    signOut: number;
  } = {
    begin: 0,
    beginProvider: undefined,
    cancel: 0,
    signOut: 0,
  };
  const manager: DesktopAuthManagerPort = {
    getState: () => AUTH_STATE,
    beginBrowserSignIn: (provider) => {
      calls.begin += 1;
      calls.beginProvider = provider;
      return Promise.resolve<DesktopBrowserSignInResult>({ ok: true });
    },
    cancelSignIn: () => {
      calls.cancel += 1;
    },
    signOut: () => {
      calls.signOut += 1;
      return Promise.resolve();
    },
    ...overrides,
  };
  return { manager, calls };
}

function register(
  manager: DesktopAuthManagerPort,
  isTrustedSender: (sender: unknown) => boolean = () => true
): Map<string, IpcHandler> {
  const handlers = new Map<string, IpcHandler>();
  registerDesktopAuthIpcHandlers(
    {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
    },
    { isTrustedSender, manager }
  );
  return handlers;
}

function registerWithGate(
  manager: DesktopAuthManagerPort,
  isFirstPartyAuthEnabled: () => boolean
): Map<string, IpcHandler> {
  const handlers = new Map<string, IpcHandler>();
  registerDesktopAuthIpcHandlers(
    {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
    },
    { isFirstPartyAuthEnabled, isTrustedSender: () => true, manager }
  );
  return handlers;
}

test("registers exactly the four desktop-auth channels", () => {
  const { manager } = createManagerStub();
  const handlers = register(manager);
  assert.deepEqual(
    [...handlers.keys()].sort(),
    [...DESKTOP_AUTH_IPC_CHANNELS].sort()
  );
  // No access-token channel: the credential has no renderer IPC path at all
  // (PLN-1138 D-G); cloud requests are authenticated in the main process by
  // the cloud-api-fetch bridge.
  assert.equal(DESKTOP_AUTH_IPC_CHANNELS.length, 4);
  assert.equal(handlers.has("desktop:get-desktop-access-token"), false);
});

test("get-state returns the manager's current auth state", () => {
  const { manager } = createManagerStub();
  const handlers = register(manager);
  const result = handlers.get(DesktopAuthIpcChannel.GetState)?.(TRUSTED_EVENT);
  assert.deepEqual(result, AUTH_STATE);
});

test("begin/cancel/sign-out delegate to the manager", async () => {
  const { manager, calls } = createManagerStub();
  const handlers = register(manager);

  const begun = await handlers.get(DesktopAuthIpcChannel.BeginSignIn)?.(
    TRUSTED_EVENT
  );
  assert.deepEqual(begun, { ok: true });
  assert.equal(calls.begin, 1);

  handlers.get(DesktopAuthIpcChannel.CancelSignIn)?.(TRUSTED_EVENT);
  assert.equal(calls.cancel, 1);

  await handlers.get(DesktopAuthIpcChannel.SignOut)?.(TRUSTED_EVENT);
  assert.equal(calls.signOut, 1);
});

test("begin-sign-in delegates by default (graduated always-on, no gate wired)", async () => {
  // FEA-4133: first-party desktop auth graduated to always-on. The new,
  // graduated wiring passes no `isFirstPartyAuthEnabled`, so begin-sign-in
  // delegates unconditionally — a missing gate is the always-on default.
  const { manager, calls } = createManagerStub();
  const handlers = register(manager);
  const result = await handlers.get(DesktopAuthIpcChannel.BeginSignIn)?.(
    TRUSTED_EVENT
  );
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.begin, 1);
});

test("version-skew: an old caller with the gate OFF still degrades to unavailable", async () => {
  // FEA-4133 compat shim: a version-skewed caller still on the pre-graduation
  // wiring (an older bundled app.ts) that hands us `isFirstPartyAuthEnabled`
  // returning false must have that off-behavior honored — report the capability
  // as unavailable and NOT start the flow, exactly as the retired gate did,
  // rather than silently ignoring the gate the old caller believes is enforced.
  const { manager, calls } = createManagerStub();
  const handlers = registerWithGate(manager, () => false);
  const result = await handlers.get(DesktopAuthIpcChannel.BeginSignIn)?.(
    TRUSTED_EVENT
  );
  assert.deepEqual(result, { ok: false, reason: "unavailable" });
  assert.equal(calls.begin, 0);
});

test("version-skew: an old caller with the gate ON delegates to the manager", async () => {
  // The same skewed caller with the gate on maps to the always-on behavior.
  const { manager, calls } = createManagerStub();
  const handlers = registerWithGate(manager, () => true);
  const result = await handlers.get(DesktopAuthIpcChannel.BeginSignIn)?.(
    TRUSTED_EVENT
  );
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.begin, 1);
});

test("an untrusted sender is rejected before the manager is touched", () => {
  const { manager, calls } = createManagerStub();
  const handlers = register(manager, () => false);
  assert.throws(
    () => handlers.get(DesktopAuthIpcChannel.BeginSignIn)?.({ sender: "evil" }),
    UNTRUSTED_SENDER_ERROR
  );
  assert.equal(calls.begin, 0);
});

test("every handler rejects an untrusted sender before touching the manager", () => {
  const { manager, calls } = createManagerStub();
  const handlers = register(manager, () => false);
  const untrustedEvent = { sender: "evil" };

  for (const channel of DESKTOP_AUTH_IPC_CHANNELS) {
    assert.throws(
      () => handlers.get(channel)?.(untrustedEvent),
      UNTRUSTED_SENDER_ERROR,
      `channel ${channel} must reject untrusted senders`
    );
  }
  // No manager method ran for any rejected call, and nothing was forwarded.
  assert.deepEqual(calls, {
    begin: 0,
    beginProvider: undefined,
    cancel: 0,
    signOut: 0,
  });
});

test("a missing sender is treated as untrusted", () => {
  const seen: unknown[] = [];
  const { manager } = createManagerStub();
  const handlers = register(manager, (sender) => {
    seen.push(sender);
    return false;
  });
  assert.throws(
    () => handlers.get(DesktopAuthIpcChannel.GetState)?.({}),
    UNTRUSTED_SENDER_ERROR
  );
  assert.deepEqual(seen, [undefined]);
});

// ISS-5112 — the provider hint's whole value is that it ARRIVES. Every other
// test on this channel only counts calls, so deleting the forward or breaking
// the parse would leave them all green while every user landed back on the
// chooser the hint exists to skip.
test("begin-sign-in forwards a recognized provider to the manager", async () => {
  const { manager, calls } = createManagerStub();
  const handlers = register(manager);

  await handlers.get(DesktopAuthIpcChannel.BeginSignIn)?.(
    TRUSTED_EVENT,
    DesktopSignInProvider.Google
  );

  assert.equal(calls.begin, 1);
  assert.equal(calls.beginProvider, DesktopSignInProvider.Google);
});

test("begin-sign-in from a renderer that sends no provider stays valid", async () => {
  // The version-skew case: an older renderer invokes this channel with no
  // argument at all. That must remain a normal sign-in with no hint, not a
  // rejected payload.
  const { manager, calls } = createManagerStub();
  const handlers = register(manager);

  const result = await handlers.get(DesktopAuthIpcChannel.BeginSignIn)?.(
    TRUSTED_EVENT
  );

  assert.deepEqual(result, { ok: true });
  assert.equal(calls.begin, 1);
  assert.equal(calls.beginProvider, undefined);
});

test("begin-sign-in degrades an unknown provider to no hint", async () => {
  // A NEWER renderer naming a provider this build has never heard of. The
  // sign-in must still start — the web page then shows its normal chooser —
  // rather than failing because one optional hint did not parse.
  const { manager, calls } = createManagerStub();
  const handlers = register(manager);

  const result = await handlers.get(DesktopAuthIpcChannel.BeginSignIn)?.(
    TRUSTED_EVENT,
    "gitlab"
  );

  assert.deepEqual(result, { ok: true });
  assert.equal(calls.begin, 1);
  assert.equal(calls.beginProvider, undefined);
});
