import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import { afterAll, afterEach, describe, it, vi } from "vitest";
import {
  localFallbackRefusalMessage,
  registerTranscriptReadIpcHandler,
} from "../src/main/ipc/transcript-read-ipc.js";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import {
  TRANSCRIPT_CANCEL_CHANNEL,
  type TranscriptPrepareResult,
} from "../src/shared/transcript-read-contract.js";

/**
 * ISS-12135 bug 55: a tracked transcript whose file is gone was logged as a
 * path that "failed the trusted-transcript-root check". The refusal itself is
 * unchanged; only the log now says which of the two it was.
 */

const testRoot = mkdtempSync(path.join(tmpdir(), "transcript-refusal-log-"));
afterAll(() => rmSync(testRoot, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

const TRUSTED_SENDER = { id: 1 } as unknown as WebContents;
const TRUSTED_EVENT = { sender: TRUSTED_SENDER } as IpcMainInvokeEvent;
const MISSING =
  "local fallback skipped: the tracked transcript file is missing";
const UNTRUSTED =
  "local fallback refused: path failed the trusted-transcript-root check";

describe("localFallbackRefusalMessage", () => {
  it("names a missing file, and keeps the root wording for a file that exists", () => {
    const present = path.join(testRoot, "present.jsonl");
    writeFileSync(present, "{}\n");

    assert.equal(
      localFallbackRefusalMessage(path.join(testRoot, "gone.jsonl")),
      MISSING
    );
    assert.equal(localFallbackRefusalMessage(present), UNTRUSTED);
  });
});

describe("the transcript read handler's refusal log", () => {
  it("logs a missing tracked file as missing, and still refuses to read it", async () => {
    const warn = vi.spyOn(gatewayLog, "warn").mockImplementation(() => {
      // keep test output quiet
    });
    const handler = registerHandler(path.join(testRoot, "never-written.jsonl"));

    const result = await handler(TRUSTED_EVENT, {
      sessionId: "cloud-1",
      externalSessionId: "ext-1",
      fileKey: "main",
    });

    assert.equal(result.kind, "error");
    assert.ok(
      warn.mock.calls.some(
        ([scope, message]) => scope === "transcript-read" && message === MISSING
      )
    );
  });
});

function registerHandler(localPath: string) {
  let handler:
    | ((
        event: IpcMainInvokeEvent,
        request: unknown
      ) => Promise<TranscriptPrepareResult>)
    | undefined;
  registerTranscriptReadIpcHandler(
    {
      handle: (channel, fn) => {
        if (channel !== TRANSCRIPT_CANCEL_CHANNEL) {
          handler = fn as typeof handler;
        }
      },
    },
    {
      isTrustedSender: (sender) => sender === TRUSTED_SENDER,
      getAccessToken: () => Promise.resolve("tok"),
      getIdentity: () => ({ userId: "u1", organizationId: "org-1" }),
      resolveApiOrigin: () => "https://api.closedloop.test",
      cacheDir: path.join(testRoot, "cache"),
      // The cloud copy is not readable, so the handler tries the local file.
      fetchImpl: (() =>
        Promise.resolve(new Response("{}", { status: 404 }))) as typeof fetch,
      now: () => 1_700_000_000_000,
      getLocalTranscriptPath: () => Promise.resolve(localPath),
      // The production resolver refuses a path that does not resolve.
      resolveTrustedTranscriptPath: () => null,
    }
  );
  if (!handler) {
    throw new Error("transcript handler was not registered");
  }
  return handler;
}
