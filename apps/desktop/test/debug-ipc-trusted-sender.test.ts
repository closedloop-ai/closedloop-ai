import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { LocalSessionStore } from "../src/main/auth/local-session-store.js";
import {
  DebugIpcChannel,
  registerDebugIpcHandlers,
} from "../src/main/ipc/debug-ipc.js";

type IpcHandler = (event: { sender?: unknown }, ...args: unknown[]) => unknown;

const UNTRUSTED_SENDER_ERROR = /untrusted sender/;
const TRUSTED_SENDER = {};

function registerMintHandler({
  isTrustedSender = () => true,
  isDebugAuthEnabled = () => true,
}: {
  isTrustedSender?: (sender: unknown) => boolean;
  isDebugAuthEnabled?: () => boolean;
} = {}): { handler: IpcHandler; createCalls: string[] } {
  const handlers = new Map<string, IpcHandler>();
  const createCalls: string[] = [];
  const sessionStore = {
    create: (origin: string) => {
      createCalls.push(origin);
      return { sessionToken: "tok", expiresAt: "2026-01-01T00:00:00.000Z" };
    },
  } as unknown as LocalSessionStore;
  registerDebugIpcHandlers(
    {
      handle: (channel, listener) => {
        handlers.set(channel, listener as IpcHandler);
      },
    },
    {
      isTrustedSender,
      getDangerousAutoApprove: () => false,
      setDangerousAutoApprove: () => undefined,
      isDebugAuthEnabled,
      sessionStore,
    }
  );
  const handler = handlers.get(DebugIpcChannel.MintDebugToken);
  if (!handler) {
    throw new Error("MintDebugToken handler was not registered");
  }
  return { handler, createCalls };
}

describe("debug MintDebugToken IPC trusted-sender gate", () => {
  test("rejects untrusted senders before minting a token", async () => {
    const { handler, createCalls } = registerMintHandler({
      isTrustedSender: () => false,
    });

    await assert.rejects(
      async () => await handler({ sender: "evil" }, "http://evil.example"),
      UNTRUSTED_SENDER_ERROR
    );
    assert.deepEqual(createCalls, []);
  });

  test("gates sender trust before the debug-auth-disabled check", async () => {
    // An untrusted sender must be rejected even when debug auth is disabled,
    // proving the trust gate runs first and does not leak the auth state.
    const { handler } = registerMintHandler({
      isTrustedSender: () => false,
      isDebugAuthEnabled: () => false,
    });

    await assert.rejects(
      async () => await handler({ sender: "evil" }, "http://evil.example"),
      UNTRUSTED_SENDER_ERROR
    );
  });

  test("mints a token for a trusted sender when debug auth is enabled", async () => {
    const { handler, createCalls } = registerMintHandler();

    const result = await handler(
      { sender: TRUSTED_SENDER },
      "http://localhost:3000"
    );

    assert.deepEqual(createCalls, ["http://localhost:3000"]);
    assert.deepEqual(result, {
      sessionToken: "tok",
      expiresAt: "2026-01-01T00:00:00.000Z",
      origin: "http://localhost:3000",
    });
  });
});
