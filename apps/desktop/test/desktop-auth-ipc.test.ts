import assert from "node:assert/strict";
import {
  DesktopSignInFraming,
  DesktopSignInMethod,
  DesktopSignInProvider,
} from "@repo/api/src/types/desktop-authorize-url";
import { DESKTOP_BOOTSTRAP_ORGANIZATION_NAME_MAX_LENGTH } from "@repo/api/src/types/desktop-bootstrap";
import { expect, test, vi } from "vitest";
import {
  DESKTOP_AUTH_IPC_CHANNELS,
  type DesktopAuthManagerPort,
  registerDesktopAuthIpcHandlers,
} from "../src/main/ipc/desktop-auth-ipc.js";
import type { DesktopSignInConfirmation } from "../src/main/session/desktop-sign-in-confirmation.js";
import type {
  DesktopAuthState,
  DesktopBrowserSignInResult,
} from "../src/shared/contracts.js";
import { DesktopAuthIpcChannel } from "../src/shared/desktop-auth-ipc-channel.js";

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
    beginProvider: DesktopSignInMethod | undefined;
    beginEmailHint: string | undefined;
    beginFraming: DesktopSignInFraming | undefined;
    beginConfirmation: DesktopSignInConfirmation | undefined;
    cancel: number;
    confirm: number;
    signOut: number;
  };
} {
  const calls: {
    begin: number;
    beginProvider: DesktopSignInMethod | undefined;
    beginEmailHint: string | undefined;
    beginFraming: DesktopSignInFraming | undefined;
    beginConfirmation: DesktopSignInConfirmation | undefined;
    cancel: number;
    confirm: number;
    signOut: number;
  } = {
    begin: 0,
    beginProvider: undefined,
    beginEmailHint: undefined,
    beginFraming: undefined,
    beginConfirmation: undefined,
    cancel: 0,
    confirm: 0,
    signOut: 0,
  };
  const manager: DesktopAuthManagerPort = {
    getState: () => AUTH_STATE,
    beginBrowserSignIn: (provider, emailHint, framing, confirmation) => {
      calls.begin += 1;
      calls.beginProvider = provider;
      calls.beginEmailHint = emailHint;
      calls.beginFraming = framing;
      calls.beginConfirmation = confirmation;
      return Promise.resolve<DesktopBrowserSignInResult>({ ok: true });
    },
    cancelSignIn: () => {
      calls.cancel += 1;
    },
    confirmPendingSignIn: () => {
      calls.confirm += 1;
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
  isTrustedSender: (sender: unknown) => boolean = () => true,
  bringWindowToFront?: () => void,
  isSignInAllowed?: () => boolean
): Map<string, IpcHandler> {
  const handlers = new Map<string, IpcHandler>();
  registerDesktopAuthIpcHandlers(
    {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
    },
    { isTrustedSender, manager, bringWindowToFront, isSignInAllowed }
  );
  return handlers;
}

test("registers exactly the six desktop-auth channels", () => {
  const { manager } = createManagerStub();
  const handlers = register(manager);
  assert.deepEqual(
    [...handlers.keys()].sort(),
    [...DESKTOP_AUTH_IPC_CHANNELS].sort()
  );
  // No access-token channel: the credential has no renderer IPC path at all
  // (PLN-1138 D-G); cloud requests are authenticated in the main process by
  // the cloud-api-fetch bridge.
  assert.equal(DESKTOP_AUTH_IPC_CHANNELS.length, 6);
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
    beginEmailHint: undefined,
    beginFraming: undefined,
    beginConfirmation: undefined,
    cancel: 0,
    confirm: 0,
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

// ISS-5954 M2 — `email` is a first-class hint value now. Before the widening,
// the schema rejected it and every email pick degraded to the GitHub default;
// this pins that it survives the IPC parse and reaches the manager.
test("begin-sign-in forwards the email method to the manager", async () => {
  const { manager, calls } = createManagerStub();
  const handlers = register(manager);

  await handlers.get(DesktopAuthIpcChannel.BeginSignIn)?.(
    TRUSTED_EVENT,
    DesktopSignInMethod.Email
  );

  assert.equal(calls.begin, 1);
  assert.equal(calls.beginProvider, DesktopSignInMethod.Email);
});

// ISS-5954 M5 — the typed-address hint crosses the boundary alongside the
// method; a non-string value is dropped, never an error.
test("begin-sign-in forwards the email hint and drops a malformed one", async () => {
  const { manager, calls } = createManagerStub();
  const handlers = register(manager);

  await handlers.get(DesktopAuthIpcChannel.BeginSignIn)?.(
    TRUSTED_EVENT,
    DesktopSignInMethod.Email,
    "kerensa+desktop@closedloop.ai"
  );
  assert.equal(calls.beginEmailHint, "kerensa+desktop@closedloop.ai");

  await handlers.get(DesktopAuthIpcChannel.BeginSignIn)?.(
    TRUSTED_EVENT,
    DesktopSignInMethod.Email,
    { not: "a string" }
  );
  assert.equal(calls.begin, 2);
  assert.equal(calls.beginEmailHint, undefined);
});

// ISS-5954 — the door framing crosses alongside the method and hint; an
// unknown or malformed value degrades to `undefined` (the web side then
// renders its sign-up default), never a rejected sign-in.
test("begin-sign-in forwards the framing and degrades an unknown one", async () => {
  const { manager, calls } = createManagerStub();
  const handlers = register(manager);

  await handlers.get(DesktopAuthIpcChannel.BeginSignIn)?.(
    TRUSTED_EVENT,
    DesktopSignInMethod.Email,
    "dev@company.com",
    DesktopSignInFraming.SignIn
  );
  assert.equal(calls.beginFraming, DesktopSignInFraming.SignIn);

  await handlers.get(DesktopAuthIpcChannel.BeginSignIn)?.(
    TRUSTED_EVENT,
    DesktopSignInMethod.Email,
    "dev@company.com",
    "sideways"
  );
  assert.equal(calls.begin, 2);
  assert.equal(calls.beginFraming, undefined);
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

// ISS-10412 — the browser leg ends on a page telling the person to return to
// the desktop, and nothing brought it back: they dismissed tabs, landed on
// Slack, and reached the signed-in app by hand. This is the handback.
test("a successful sign-in brings the desktop window to the front", async () => {
  const { manager } = createManagerStub();
  let brought = 0;
  const handlers = register(
    manager,
    () => true,
    () => {
      brought += 1;
    }
  );

  await handlers.get(DesktopAuthIpcChannel.BeginSignIn)?.(TRUSTED_EVENT);

  assert.equal(brought, 1);
});

// The other half, and the one that keeps the case above honest: a sign-in that
// did not authorize must leave the foreground alone. A cancel already settles
// in the renderer the person is looking at, and a timeout means they walked
// away — popping the window into whatever they moved on to is not a handback.
test("a sign-in that did not authorize leaves the window alone", async () => {
  const { manager } = createManagerStub({
    beginBrowserSignIn: () =>
      Promise.resolve<DesktopBrowserSignInResult>({
        ok: false,
        reason: "cancelled",
      }),
  });
  let brought = 0;
  const handlers = register(
    manager,
    () => true,
    () => {
      brought += 1;
    }
  );

  const result = await handlers.get(DesktopAuthIpcChannel.BeginSignIn)?.(
    TRUSTED_EVENT
  );

  assert.deepEqual(result, { ok: false, reason: "cancelled" });
  assert.equal(brought, 0);
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

// ISS-11345 — `confirmAccount` is what makes the manager hold the redeemed
// session for the user. Dropping it at this parse would sign the connect CTA in
// with no prompt again while every manager test stayed green.
test("begin-sign-in turns confirmAccount into a confirmation that raises the window", async () => {
  const { manager, calls } = createManagerStub();
  let brought = 0;
  const handlers = register(
    manager,
    () => true,
    () => {
      brought += 1;
    }
  );

  await handlers.get(DesktopAuthIpcChannel.BeginSignIn)?.(
    TRUSTED_EVENT,
    undefined,
    undefined,
    undefined,
    { confirmAccount: true }
  );
  assert.equal(brought, 1, "the stub resolved ok, so the handback ran once");
  calls.beginConfirmation?.onAwaitingConfirmation?.();
  assert.equal(brought, 2, "awaiting confirmation raises the window again");

  await handlers.get(DesktopAuthIpcChannel.BeginSignIn)?.(TRUSTED_EVENT);
  assert.equal(calls.beginConfirmation, undefined);

  await handlers.get(DesktopAuthIpcChannel.BeginSignIn)?.(
    TRUSTED_EVENT,
    undefined,
    undefined,
    undefined,
    { confirmAccount: "yes" }
  );
  assert.equal(calls.begin, 3);
  assert.equal(calls.beginConfirmation, undefined);
});

test("confirm-sign-in delegates to the manager", () => {
  const { manager, calls } = createManagerStub();
  const handlers = register(manager);

  handlers.get(DesktopAuthIpcChannel.ConfirmSignIn)?.(TRUSTED_EVENT);

  assert.equal(calls.confirm, 1);
});

test("create-bootstrap-organization validates and delegates without exposing the token", async () => {
  const createBootstrapOrganization = vi.fn().mockResolvedValue({ ok: true });
  const { manager } = createManagerStub({ createBootstrapOrganization });
  const handler = register(manager).get(
    DesktopAuthIpcChannel.CreateBootstrapOrganization
  );

  await expect(
    handler?.(TRUSTED_EVENT, { name: "Acme", slug: "acme" })
  ).resolves.toEqual({ ok: true });
  expect(createBootstrapOrganization).toHaveBeenCalledWith({
    name: "Acme",
    slug: "acme",
  });
  const logo = { name: "logo.png", type: "image/png", base64: "bG9nbw==" };
  await expect(
    handler?.(TRUSTED_EVENT, { name: "Acme", slug: "acme", logo })
  ).resolves.toEqual({ ok: true });
  expect(createBootstrapOrganization).toHaveBeenLastCalledWith({
    name: "Acme",
    slug: "acme",
    logo,
  });
  await expect(
    handler?.(TRUSTED_EVENT, {
      name: "Acme",
      slug: "acme",
      logo: { ...logo, base64: "not base64" },
    })
  ).resolves.toEqual({ ok: false, error: "invalid_request" });
  await expect(
    handler?.(TRUSTED_EVENT, { name: "Acme", slug: "acme", token: "leak" })
  ).resolves.toEqual({ ok: false, error: "invalid_request" });
  await expect(
    handler?.(TRUSTED_EVENT, {
      name: "a".repeat(DESKTOP_BOOTSTRAP_ORGANIZATION_NAME_MAX_LENGTH + 1),
      slug: "acme",
    })
  ).resolves.toEqual({ ok: false, error: "invalid_request" });
});

test("begin-sign-in is refused while sign-out cleanup owns credentials", async () => {
  const { manager, calls } = createManagerStub();
  const handlers = register(
    manager,
    () => true,
    undefined,
    () => false
  );

  const result = await handlers.get(DesktopAuthIpcChannel.BeginSignIn)?.(
    TRUSTED_EVENT
  );

  assert.deepEqual(result, { ok: false, reason: "cancelled" });
  assert.equal(calls.begin, 0);
});
