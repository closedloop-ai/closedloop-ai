import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DESKTOP_AUTH_IPC_CHANNELS,
  DesktopAuthIpcChannel,
  type DesktopAuthManagerPort,
  registerDesktopAuthIpcHandlers,
} from "../src/main/desktop-auth-ipc.js";
import type {
  DesktopAuthState,
  DesktopBrowserSignInResult,
} from "../src/main/desktop-session-manager.js";

type IpcHandler = (event: unknown) => unknown;

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
    cancel: number;
    signOut: number;
    accessToken: number;
  };
} {
  const calls = { begin: 0, cancel: 0, signOut: 0, accessToken: 0 };
  const manager: DesktopAuthManagerPort = {
    getState: () => AUTH_STATE,
    beginBrowserSignIn: () => {
      calls.begin += 1;
      return Promise.resolve<DesktopBrowserSignInResult>({ ok: true });
    },
    cancelSignIn: () => {
      calls.cancel += 1;
    },
    signOut: () => {
      calls.signOut += 1;
      return Promise.resolve();
    },
    getAccessToken: () => {
      calls.accessToken += 1;
      return Promise.resolve("access-token");
    },
    ...overrides,
  };
  return { manager, calls };
}

function register(
  manager: DesktopAuthManagerPort,
  isTrustedSender: (sender: unknown) => boolean = () => true,
  isFirstPartyAuthEnabled: () => boolean = () => true
): Map<string, IpcHandler> {
  const handlers = new Map<string, IpcHandler>();
  registerDesktopAuthIpcHandlers(
    {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
    },
    { isTrustedSender, isFirstPartyAuthEnabled, manager }
  );
  return handlers;
}

test("registers exactly the five desktop-auth channels", () => {
  const { manager } = createManagerStub();
  const handlers = register(manager);
  assert.deepEqual(
    [...handlers.keys()].sort(),
    [...DESKTOP_AUTH_IPC_CHANNELS].sort()
  );
  assert.equal(DESKTOP_AUTH_IPC_CHANNELS.length, 5);
});

test("get-state returns the manager's current auth state", () => {
  const { manager } = createManagerStub();
  const handlers = register(manager);
  const result = handlers.get(DesktopAuthIpcChannel.GetState)?.(TRUSTED_EVENT);
  assert.deepEqual(result, AUTH_STATE);
});

test("begin/cancel/sign-out/access-token delegate to the manager", async () => {
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

  const token = await handlers.get(DesktopAuthIpcChannel.GetAccessToken)?.(
    TRUSTED_EVENT
  );
  assert.equal(token, "access-token");
  assert.equal(calls.accessToken, 1);
});

test("begin-sign-in reports 'unavailable' at the IPC boundary when the flag is off", async () => {
  const { manager, calls } = createManagerStub();
  const handlers = register(
    manager,
    () => true,
    () => false
  );
  const result = await handlers.get(DesktopAuthIpcChannel.BeginSignIn)?.(
    TRUSTED_EVENT
  );
  // Resolves to the documented failure shape (never throws), so renderer
  // callers that check `!signIn.ok` degrade gracefully.
  assert.deepEqual(result, { ok: false, reason: "unavailable" });
  // The capability never reached the manager.
  assert.equal(calls.begin, 0);
});

test("the flag gate does not block reading state, tokens, or signing out", async () => {
  const { manager, calls } = createManagerStub();
  const handlers = register(
    manager,
    () => true,
    () => false
  );

  // A user signed in before the flag flipped off must still be able to read
  // their session and sign out — only initiating a new sign-in is gated.
  assert.deepEqual(
    handlers.get(DesktopAuthIpcChannel.GetState)?.(TRUSTED_EVENT),
    AUTH_STATE
  );
  const token = await handlers.get(DesktopAuthIpcChannel.GetAccessToken)?.(
    TRUSTED_EVENT
  );
  assert.equal(token, "access-token");
  await handlers.get(DesktopAuthIpcChannel.SignOut)?.(TRUSTED_EVENT);
  assert.equal(calls.signOut, 1);
});

test("an untrusted sender is rejected before the flag is even checked", () => {
  const { manager, calls } = createManagerStub();
  let flagChecked = false;
  const handlers = register(
    manager,
    () => false,
    () => {
      flagChecked = true;
      return true;
    }
  );
  assert.throws(
    () => handlers.get(DesktopAuthIpcChannel.BeginSignIn)?.({ sender: "evil" }),
    UNTRUSTED_SENDER_ERROR
  );
  assert.equal(flagChecked, false);
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
  // No manager method ran for any rejected call.
  assert.deepEqual(calls, {
    begin: 0,
    cancel: 0,
    signOut: 0,
    accessToken: 0,
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
