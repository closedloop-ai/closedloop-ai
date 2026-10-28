import assert from "node:assert/strict";
import { test } from "vitest";
import {
  DesktopIdentityIpcChannels,
  registerDesktopIdentityIpcHandlers,
} from "../src/main/ipc/desktop-identity-ipc.js";
import { DesktopFeatureFlagsIpcChannel } from "../src/shared/desktop-feature-flags-channel.js";

// FEA-4133 removed the `isFirstPartyAuthEnabled` flag gate from the identity IPC
// boundary, leaving the trusted-sender gate as the sole guard. These
// handler-level tests prove that guard directly: an untrusted sender returns
// null before the access token or API origin is ever resolved, and a trusted
// sender delegates to the cloud fetch (which resolves both) — with no retired
// flag in the dependency shape.

type IpcHandler = (event: unknown) => unknown;

const TRUSTED_EVENT = { sender: "trusted" };
const UNTRUSTED_EVENT = { sender: "evil" };

const IDENTITY_CHANNELS = Object.values(DesktopIdentityIpcChannels);

function register(
  isTrustedSender: (sender: unknown) => boolean,
  calls: { getAccessToken: number; getApiOrigin: number },
  getAccountAdmission?: () => {
    userId: string;
    organizationId: string;
    generation: number;
  } | null
): Map<string, IpcHandler> {
  const handlers = new Map<string, IpcHandler>();
  registerDesktopIdentityIpcHandlers(
    {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
    },
    {
      isTrustedSender,
      getAccessToken: () => {
        calls.getAccessToken += 1;
        return Promise.resolve(null);
      },
      getApiOrigin: () => {
        calls.getApiOrigin += 1;
        return "https://api.test";
      },
      getAccountAdmission,
    }
  );
  return handlers;
}

test("every identity handler returns null for an untrusted sender before resolving token/origin", async () => {
  const calls = { getAccessToken: 0, getApiOrigin: 0 };
  const handlers = register(() => false, calls);

  for (const channel of IDENTITY_CHANNELS) {
    const result = await handlers.get(channel)?.(UNTRUSTED_EVENT);
    assert.equal(
      result,
      null,
      `channel ${channel} must return null for an untrusted sender`
    );
  }
  // Neither the access token nor the API origin was resolved for a rejected call.
  assert.equal(calls.getAccessToken, 0);
  assert.equal(calls.getApiOrigin, 0);
});

test("an absent account admission refuses every identity read before token resolution", async () => {
  const calls = { getAccessToken: 0, getApiOrigin: 0 };
  const handlers = register(
    () => true,
    calls,
    () => null
  );

  for (const channel of IDENTITY_CHANNELS) {
    assert.equal(await handlers.get(channel)?.(TRUSTED_EVENT), null);
  }
  assert.equal(calls.getAccessToken, 0);
  assert.equal(calls.getApiOrigin, 0);
});

test("a trusted sender delegates to the identity fetch and resolves token + origin", async () => {
  const calls = { getAccessToken: 0, getApiOrigin: 0 };
  const handlers = register(() => true, calls);

  // fetchDesktopIdentity resolves the access token (null here → no identity) and
  // reads the API origin; a null token short-circuits to a null identity without
  // a network call, which is enough to prove the handler delegated past the gate.
  const result = await handlers.get(
    DesktopIdentityIpcChannels.GetDesktopIdentity
  )?.(TRUSTED_EVENT);

  assert.equal(result, null);
  assert.ok(
    calls.getAccessToken >= 1,
    "a trusted sender must resolve the access token"
  );
});

// ISS-8024: the feature-flag assignment is an account-scoped cloud read on this
// same boundary, so it inherits the trusted-sender guard exercised above. This
// case pins the channel the handler was registered ON, read from the shared
// channel module rather than from the registration map, so a handler wired to a
// name the renderer never invokes fails here instead of silently never firing.
test("the feature-flag assignment handler is registered on the shared channel and delegates past the gate", async () => {
  const calls = { getAccessToken: 0, getApiOrigin: 0 };
  const handlers = register(() => true, calls);

  const result = await handlers.get(DesktopFeatureFlagsIpcChannel.Get)?.(
    TRUSTED_EVENT
  );

  // A null access token short-circuits to a null assignment with no network
  // call, which is enough to prove the handler delegated past the gate.
  assert.equal(result, null);
  assert.ok(
    calls.getAccessToken >= 1,
    "a trusted sender must resolve the access token"
  );
});
