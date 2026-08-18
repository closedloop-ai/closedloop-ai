/**
 * @file transcript-force-archive-ipc.test.ts
 * @description FEA-3489 (PRD-536) trust-boundary + input-validation coverage for
 * the user-initiated force-archive IPC handler. Follows the fake-registrar
 * pattern (see `ipc-profile-channels.test.ts`) required by apps/desktop/AGENTS.md
 * for a new IPC surface: a stub `handle` captures the listener, and we assert the
 * handler rejects an untrusted sender, rejects a malformed request WITHOUT
 * touching the sync lane, degrades to `unavailable` when the lane is not wired,
 * and forwards a well-formed request to `forceSyncOversized`.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { WebContents } from "electron";
import { registerTranscriptForceArchiveIpcHandler } from "../src/main/ipc/transcript-force-archive-ipc.js";
import { TRANSCRIPT_FORCE_ARCHIVE_CHANNEL } from "../src/shared/transcript-read-contract.js";

type ForceArchiveDeps = Parameters<
  typeof registerTranscriptForceArchiveIpcHandler
>[1];
type IpcHandler = (event: unknown, request: unknown) => unknown;

const UNTRUSTED_SENDER_ERROR = /untrusted sender/;
const VALID_REQUEST = { externalSessionId: "ext-1", fileKey: "main" };

function registerHandler(overrides: Partial<ForceArchiveDeps> = {}): {
  handler: IpcHandler;
  forceCalls: Array<{ externalSessionId: string; fileKey: string }>;
} {
  let handler: IpcHandler | undefined;
  const forceCalls: Array<{ externalSessionId: string; fileKey: string }> = [];
  const deps: ForceArchiveDeps = {
    isTrustedSender: () => true,
    forceSyncOversized: (externalSessionId, fileKey) => {
      forceCalls.push({ externalSessionId, fileKey });
      return Promise.resolve({ kind: "uploaded" as const, caughtUp: true });
    },
    ...overrides,
  };
  registerTranscriptForceArchiveIpcHandler(
    {
      handle: (_channel, listener) => {
        handler = listener as IpcHandler;
      },
    },
    deps
  );
  if (!handler) {
    throw new Error("handler was not registered");
  }
  return { handler, forceCalls };
}

describe("transcript force-archive IPC (FEA-3489)", () => {
  test("registers on the shared force-archive channel", () => {
    let channel: string | undefined;
    registerTranscriptForceArchiveIpcHandler(
      {
        handle: (registeredChannel) => {
          channel = registeredChannel;
        },
      },
      {
        isTrustedSender: () => true,
        forceSyncOversized: () =>
          Promise.resolve({ kind: "unavailable" as const }),
      }
    );
    assert.equal(channel, TRANSCRIPT_FORCE_ARCHIVE_CHANNEL);
  });

  test("rejects an untrusted sender before doing any work", async () => {
    const { handler, forceCalls } = registerHandler({
      isTrustedSender: () => false,
    });
    await assert.rejects(
      async () => await handler({ sender: {} as WebContents }, VALID_REQUEST),
      UNTRUSTED_SENDER_ERROR
    );
    // The untrusted call never reaches the sync lane.
    assert.equal(forceCalls.length, 0);
  });

  test("rejects a malformed request as failed without touching the sync lane", async () => {
    const { handler, forceCalls } = registerHandler();
    // Missing fileKey / extra key: the strict schema rejects it.
    const result = await handler(
      { sender: {} as WebContents },
      { externalSessionId: "ext-1", bogus: true }
    );
    assert.deepEqual(result, {
      kind: "failed",
      reason: "Malformed force-archive request.",
    });
    assert.equal(forceCalls.length, 0);
  });

  test("degrades to unavailable when the sync lane is not wired (flag off)", async () => {
    const { handler } = registerHandler({ forceSyncOversized: null });
    const result = await handler({ sender: {} as WebContents }, VALID_REQUEST);
    assert.deepEqual(result, { kind: "unavailable" });
  });

  test("forwards a well-formed request to forceSyncOversized", async () => {
    const { handler, forceCalls } = registerHandler();
    const result = await handler({ sender: {} as WebContents }, VALID_REQUEST);
    assert.deepEqual(result, { kind: "uploaded", caughtUp: true });
    assert.deepEqual(forceCalls, [
      { externalSessionId: "ext-1", fileKey: "main" },
    ]);
  });
});
