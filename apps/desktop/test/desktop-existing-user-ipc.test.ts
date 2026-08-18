import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DESKTOP_EXISTING_USER_IPC_CHANNELS,
  DesktopExistingUserIpcChannel,
  type DesktopExistingUserManagerPort,
  registerDesktopExistingUserIpcHandlers,
} from "../src/main/ipc/desktop-existing-user-ipc.js";
import type { DesktopExistingUserResolution } from "../src/main/session/desktop-session-manager.js";

type IpcHandler = (event: unknown) => unknown;

const UNTRUSTED_SENDER_ERROR = /untrusted sender/;
const TRUSTED_EVENT = { sender: "trusted" };

const PROMPT_RESOLUTION: DesktopExistingUserResolution = {
  kind: "prompt",
  dismissed: false,
};

function createManagerStub(): {
  manager: DesktopExistingUserManagerPort;
  calls: { get: number; dismiss: number };
} {
  const calls = { get: 0, dismiss: 0 };
  const manager: DesktopExistingUserManagerPort = {
    getExistingUserResolution: () => {
      calls.get += 1;
      return PROMPT_RESOLUTION;
    },
    dismissExistingUserPrompt: () => {
      calls.dismiss += 1;
    },
  };
  return { manager, calls };
}

function register(
  manager: DesktopExistingUserManagerPort,
  isTrustedSender: (sender: unknown) => boolean = () => true
): Map<string, IpcHandler> {
  const handlers = new Map<string, IpcHandler>();
  registerDesktopExistingUserIpcHandlers(
    {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
    },
    { isTrustedSender, manager }
  );
  return handlers;
}

test("registers exactly the existing-user channels", () => {
  const { manager } = createManagerStub();
  const handlers = register(manager);
  assert.deepEqual(
    [...handlers.keys()].sort(),
    [...DESKTOP_EXISTING_USER_IPC_CHANNELS].sort()
  );
  assert.equal(DESKTOP_EXISTING_USER_IPC_CHANNELS.length, 2);
});

test("get-resolution returns the manager's current resolution", () => {
  const { manager } = createManagerStub();
  const handlers = register(manager);
  const result = handlers.get(DesktopExistingUserIpcChannel.GetResolution)?.(
    TRUSTED_EVENT
  );
  assert.deepEqual(result, PROMPT_RESOLUTION);
});

test("dismiss-prompt delegates to the manager", () => {
  const { manager, calls } = createManagerStub();
  const handlers = register(manager);
  handlers.get(DesktopExistingUserIpcChannel.DismissPrompt)?.(TRUSTED_EVENT);
  assert.equal(calls.dismiss, 1);
});

test("every handler rejects an untrusted sender before touching the manager", () => {
  const { manager, calls } = createManagerStub();
  const handlers = register(manager, () => false);
  const untrustedEvent = { sender: "evil" };

  for (const channel of DESKTOP_EXISTING_USER_IPC_CHANNELS) {
    assert.throws(
      () => handlers.get(channel)?.(untrustedEvent),
      UNTRUSTED_SENDER_ERROR,
      `channel ${channel} must reject untrusted senders`
    );
  }
  assert.deepEqual(calls, { get: 0, dismiss: 0 });
});

test("a missing sender is treated as untrusted", () => {
  const { manager } = createManagerStub();
  const handlers = register(manager, () => false);
  assert.throws(
    () => handlers.get(DesktopExistingUserIpcChannel.GetResolution)?.({}),
    UNTRUSTED_SENDER_ERROR
  );
});
