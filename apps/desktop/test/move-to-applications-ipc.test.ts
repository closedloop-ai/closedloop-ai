import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { registerMoveToApplicationsIpcHandler } from "../src/main/move-to-applications-ipc.js";
import { createDesktopApi } from "../src/main/preload-common.js";
import { MOVE_TO_APPLICATIONS_IPC_CHANNEL } from "../src/shared/move-to-applications-ipc-channel.js";

type IpcHandler = (event: { sender?: unknown }) => unknown;

const UPDATE_NOT_BLOCKED_ERROR = /update install is not blocked/;
const UNTRUSTED_SENDER_ERROR = /untrusted sender/;
const TRUSTED_SENDER = {};

function registerMoveHandler({
  canMoveToApplications = () => true,
  isTrustedSender = () => true,
}: {
  canMoveToApplications?: () => boolean;
  isTrustedSender?: (sender: unknown) => boolean;
} = {}): { calls: { move: number }; handler: IpcHandler } {
  const handlers = new Map<string, IpcHandler>();
  const calls = { move: 0 };
  registerMoveToApplicationsIpcHandler(
    {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
    },
    {
      canMoveToApplications,
      isTrustedSender,
      moveToApplications: () => {
        calls.move += 1;
        return true;
      },
    }
  );
  const handler = handlers.get(MOVE_TO_APPLICATIONS_IPC_CHANNEL);
  if (!handler) {
    throw new Error("move-to-Applications handler was not registered");
  }
  return { calls, handler };
}

describe("move-to-Applications IPC", () => {
  test("registered handler delegates trusted requests to the move action", async () => {
    const { calls, handler } = registerMoveHandler();

    assert.equal(await handler({ sender: TRUSTED_SENDER }), true);
    assert.equal(calls.move, 1);
  });

  test("registered handler rejects untrusted senders before moving", async () => {
    const { calls, handler } = registerMoveHandler({
      isTrustedSender: () => false,
    });

    await assert.rejects(
      async () => await handler({ sender: "evil" }),
      UNTRUSTED_SENDER_ERROR
    );
    assert.equal(calls.move, 0);
  });

  test("registered handler rejects trusted senders before moving when update install is not blocked", async () => {
    const { calls, handler } = registerMoveHandler({
      canMoveToApplications: () => false,
    });

    await assert.rejects(
      async () => await handler({ sender: TRUSTED_SENDER }),
      UPDATE_NOT_BLOCKED_ERROR
    );
    assert.equal(calls.move, 0);
  });

  test("preload moveToApplications invokes the shared move channel", async () => {
    const calls: string[] = [];
    const desktopApi = createDesktopApi({
      invoke: (channel) => {
        calls.push(channel);
        return Promise.resolve(true);
      },
      send: () => {},
    });

    assert.equal(await desktopApi.moveToApplications(), true);
    assert.deepEqual(calls, [MOVE_TO_APPLICATIONS_IPC_CHANNEL]);
  });

  test("preload moveToApplications normalizes non-true responses to false", async () => {
    const desktopApi = createDesktopApi({
      invoke: () => Promise.resolve(false),
      send: () => {},
    });

    assert.equal(await desktopApi.moveToApplications(), false);
  });
});
