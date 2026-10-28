import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopBrowserBridgeEvent } from "../../shared/desktop-browser-bridge-contract.mjs";
import { isWithinBridgePayloadLimit } from "../../shared/desktop-browser-bridge-schema.mjs";
import type { TranscriptPrepareResult } from "../../shared/transcript-read-contract";
import { selectReadOnlyDesktopApi } from "../desktop-browser-bridge-projection";
import {
  applyBrowserClientTranscriptApi,
  projectTranscriptPrepare,
} from "../desktop-browser-bridge-transcript";
import { base64ToBytes } from "../shared/bytes-base64";
import {
  CLIENT_ID,
  currentSocket,
  type FakeBridgeSocket,
  flushHostRequest,
  lastRequestPayload,
  lastResponsePayload,
  sentPayloads,
} from "./desktop-browser-bridge-fake-socket";
import {
  cloudRelayFor,
  connectFakeClient,
  connectFakeHost,
  createHostApiStub,
  issueLaunchToken,
  resetBridgeDocument,
} from "./desktop-browser-bridge-harness";

vi.mock("socket.io-client", async () => {
  const { io } = await import("./desktop-browser-bridge-fake-socket");
  return { io };
});

// ISS-12135: transcript reads in the browser bridge tab. The host runs the real
// preload prepare and pushes the prepared bytes; the tab never sees the app://
// URL or the signed URL behind it, and nothing that writes crosses.

const objectUrls = new Map<string, Blob>();
const revokedUrls: string[] = [];

beforeEach(() => {
  resetBridgeDocument(LAUNCH_TOKEN);
  objectUrls.clear();
  revokedUrls.length = 0;
  let next = 0;
  // jsdom implements neither half of the object-URL API.
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL(blob: Blob): string {
        next += 1;
        const url = `blob:bridge-test/${next}`;
        objectUrls.set(url, blob);
        return url;
      }

      static revokeObjectURL(url: string): void {
        revokedUrls.push(url);
      }
    }
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("transcript capability surface", () => {
  it("projects prepare and cancel, and leaves the force-archive write off the bridge", () => {
    const selected = selectReadOnlyDesktopApi(
      createHostApiStub(transcriptHostApi())
    );

    expect(selected.prepareTranscript).toBeTypeOf("function");
    expect(selected.cancelTranscriptPrepare).toBeTypeOf("function");
    expect(Object.hasOwn(selected, "forceArchiveTranscript")).toBe(false);
  });

  it("leaves both keys absent on a host whose preload has no transcript read", () => {
    const selected = selectReadOnlyDesktopApi(createHostApiStub());

    expect(Object.hasOwn(selected, "prepareTranscript")).toBe(false);
    expect(Object.hasOwn(selected, "cancelTranscriptPrepare")).toBe(false);
  });

  it("relays a cancel to the host's own preload method", async () => {
    const cancelTranscriptPrepare = vi.fn(() => Promise.resolve());
    const selected = selectReadOnlyDesktopApi(
      createHostApiStub(transcriptHostApi({ cancelTranscriptPrepare }))
    );

    await (selected.cancelTranscriptPrepare as (r: unknown) => Promise<void>)({
      requestId: "r-1",
    });

    expect(cancelTranscriptPrepare).toHaveBeenCalledWith({ requestId: "r-1" });
  });

  it("still refuses the signed-URL transcript route on the cloud read relay", () => {
    const cloudApiFetch = vi.fn(() => Promise.resolve({ status: 200 }));

    expect(() =>
      cloudRelayFor(cloudApiFetch)({ path: "/agent-sessions/s-1/transcript" })
    ).toThrow(TRANSCRIPT_DENIAL_PATTERN);
    expect(cloudApiFetch).not.toHaveBeenCalled();
  });
});

describe("projectTranscriptPrepare (host half)", () => {
  it("hands the request to the preload, reads the prepared file, and pushes its bytes without the URL", async () => {
    const bytes = transcriptBytes(2.5 * CHUNK_BYTES);
    const prepare = vi.fn(() => Promise.resolve(readyAt(APP_URL, "cloud")));
    const fetchPrepared = vi.fn(() => Promise.resolve(new Response(bytes)));
    const chunks: string[] = [];

    const result = await projectTranscriptPrepare(prepare, fetchPrepared)(
      PREPARE_REQUEST,
      (chunk: string) => chunks.push(chunk)
    );

    expect(prepare).toHaveBeenCalledWith(PREPARE_REQUEST);
    expect(fetchPrepared).toHaveBeenCalledWith(APP_URL);
    expect(result).toEqual({
      byteLength: bytes.byteLength,
      kind: "ready",
      source: "cloud",
    });
    expect(chunks).toHaveLength(3);
    expect(sameBytes(concat(chunks.map(base64ToBytes)), bytes)).toBe(true);
    for (const chunk of chunks) {
      expect(chunk).not.toContain("app:");
      // The push envelope the host emits, at the largest chunk size.
      expect(
        isWithinBridgePayloadLimit({
          args: [chunk],
          callbackId: "c".repeat(36),
          clientId: CLIENT_ID,
        })
      ).toBe(true);
    }
  });

  it("passes an oversized or error answer through without reading anything", async () => {
    const fetchPrepared = vi.fn();
    const oversized: TranscriptPrepareResult = {
      byteSize: 99,
      kind: "oversized",
      source: "local",
    };
    const failed: TranscriptPrepareResult = {
      kind: "error",
      message: "not readable",
    };

    for (const answer of [oversized, failed]) {
      const project = projectTranscriptPrepare(
        () => Promise.resolve(answer),
        fetchPrepared
      );
      await expect(project(PREPARE_REQUEST, vi.fn())).resolves.toEqual(answer);
    }
    expect(fetchPrepared).not.toHaveBeenCalled();
  });

  it("refuses a call with no chunk callback before it reaches the preload", async () => {
    const prepare = vi.fn();

    await expect(
      projectTranscriptPrepare(prepare)(PREPARE_REQUEST, "not-a-callback")
    ).rejects.toThrow("Desktop browser bridge transcript read is invalid");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("lets the preload's own refusal reach the caller", async () => {
    const project = projectTranscriptPrepare(() =>
      Promise.reject(new Error("untrusted sender"))
    );

    await expect(project(PREPARE_REQUEST, vi.fn())).rejects.toThrow(
      "untrusted sender"
    );
  });

  it("refuses a preload answer of an unknown shape", async () => {
    const project = projectTranscriptPrepare(() =>
      Promise.resolve({ kind: "ready", source: "cloud" })
    );

    await expect(project(PREPARE_REQUEST, vi.fn())).rejects.toThrow(
      "Desktop browser bridge transcript result is invalid"
    );
  });

  it("fails when the prepared file cannot be read, pushing nothing", async () => {
    const onChunk = vi.fn();
    const project = projectTranscriptPrepare(
      () => Promise.resolve(readyAt(APP_URL, "local")),
      () => Promise.resolve(new Response("gone", { status: 404 }))
    );

    await expect(project(PREPARE_REQUEST, onChunk)).rejects.toThrow("HTTP 404");
    expect(onChunk).not.toHaveBeenCalled();
  });
});

describe("applyBrowserClientTranscriptApi (tab half)", () => {
  it("reassembles the pushed chunks into an object URL holding the same bytes", async () => {
    const bytes = transcriptBytes(CHUNK_BYTES + 10);
    const desktopApi = clientApiPushing(bytes, "local");

    const result = await prepareThrough(desktopApi);

    expect(result).toEqual({
      kind: "ready",
      source: "local",
      url: "blob:bridge-test/1",
    });
    const blob = objectUrls.get("blob:bridge-test/1");
    expect(
      sameBytes(new Uint8Array(await (blob as Blob).arrayBuffer()), bytes)
    ).toBe(true);
  });

  it("refuses a transcript whose pushed bytes fall short of the announced length", async () => {
    const desktopApi: Record<string, unknown> = {
      prepareTranscript: (_request: unknown, onChunk: (c: string) => void) => {
        onChunk(btoa("partial"));
        return Promise.resolve({
          byteLength: 100,
          kind: "ready",
          source: "cloud",
        });
      },
    };
    applyBrowserClientTranscriptApi(desktopApi);

    await expect(prepareThrough(desktopApi)).rejects.toThrow(
      "Desktop browser bridge transcript arrived incomplete"
    );
    expect(objectUrls.size).toBe(0);
  });

  it("passes an oversized answer through as the preload shape", async () => {
    const oversized = { byteSize: 5, kind: "oversized", source: "cloud" };
    const desktopApi: Record<string, unknown> = {
      prepareTranscript: () => Promise.resolve(oversized),
    };
    applyBrowserClientTranscriptApi(desktopApi);

    await expect(prepareThrough(desktopApi)).resolves.toEqual(oversized);
  });

  it("revokes the oldest object URLs once more than the live bound are held", async () => {
    const desktopApi = clientApiPushing(transcriptBytes(4), "cloud");

    for (let index = 0; index < 18; index += 1) {
      await prepareThrough(desktopApi);
    }

    expect(revokedUrls).toEqual(["blob:bridge-test/1", "blob:bridge-test/2"]);
  });

  it("leaves the key absent when the manifest carried no transcript read", () => {
    const desktopApi: Record<string, unknown> = {};

    applyBrowserClientTranscriptApi(desktopApi);

    expect(Object.hasOwn(desktopApi, "prepareTranscript")).toBe(false);
  });
});

describe("transcript read across the bridge wire", () => {
  it("delivers the host's prepared bytes to the tab and nothing else of the answer", async () => {
    const bytes = transcriptBytes(CHUNK_BYTES * 2 + 3);
    const prepareTranscript = vi.fn(() =>
      Promise.resolve(readyAt(APP_URL, "cloud"))
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(bytes)))
    );
    const { disconnect, socket: hostSocket } = connectFakeHost(
      transcriptHostApi({ prepareTranscript })
    );
    issueLaunchToken(LAUNCH_TOKEN);
    const desktopApi = await connectFakeClient(transcriptManifest);
    const clientSocket = currentSocket();

    const settling = prepareThrough(desktopApi);
    relayRequest(clientSocket, hostSocket);
    await flushHostRequest();

    expect(prepareTranscript).toHaveBeenCalledWith(PREPARE_REQUEST);
    const pushes = sentPayloads(hostSocket, desktopBrowserBridgeEvent.callback);
    expect(pushes).toHaveLength(3);
    for (const push of pushes) {
      clientSocket.deliver(desktopBrowserBridgeEvent.callback, push);
    }
    const response = lastResponsePayload(hostSocket);
    expect(JSON.stringify(response)).not.toContain(APP_URL);
    clientSocket.deliver(desktopBrowserBridgeEvent.response, response);

    const result = (await settling) as { url: string };
    const blob = objectUrls.get(result.url) as Blob;
    expect(sameBytes(new Uint8Array(await blob.arrayBuffer()), bytes)).toBe(
      true
    );
    disconnect();
  });
});

function transcriptHostApi(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    cancelTranscriptPrepare: () => Promise.resolve(),
    forceArchiveTranscript: () => Promise.resolve({ kind: "queued" }),
    prepareTranscript: () => Promise.resolve(readyAt(APP_URL, "cloud")),
    ...overrides,
  };
}

function clientApiPushing(
  bytes: Uint8Array,
  source: "cloud" | "local"
): Record<string, unknown> {
  const desktopApi: Record<string, unknown> = {
    prepareTranscript: (_request: unknown, onChunk: (c: string) => void) =>
      projectTranscriptPrepare(
        () => Promise.resolve(readyAt(APP_URL, source)),
        () => Promise.resolve(new Response(bytes.slice()))
      )(_request, onChunk),
  };
  applyBrowserClientTranscriptApi(desktopApi);
  return desktopApi;
}

function prepareThrough(desktopApi: Record<string, unknown>): Promise<unknown> {
  return (desktopApi.prepareTranscript as (r: unknown) => Promise<unknown>)(
    PREPARE_REQUEST
  );
}

/** Carry the client's last request frame to the host as the broker would. */
function relayRequest(
  clientSocket: FakeBridgeSocket,
  hostSocket: FakeBridgeSocket
): void {
  hostSocket.deliver(desktopBrowserBridgeEvent.request, {
    ...lastRequestPayload(clientSocket),
    clientId: CLIENT_ID,
  });
}

function readyAt(
  url: string,
  source: "cloud" | "local"
): TranscriptPrepareResult {
  return { kind: "ready", source, url };
}

/** Bytes covering every value, so base64 round-tripping is fully exercised. */
function transcriptBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(Math.floor(length));
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = index % 256;
  }
  return bytes;
}

/**
 * A deep `toEqual` walks a multi-MB array element by element and dominates the
 * suite's runtime; a byte comparison asserts the same thing.
 */
function sameBytes(actual: Uint8Array, expected: Uint8Array): boolean {
  return Buffer.compare(actual, expected) === 0;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined;
}

const LAUNCH_TOKEN = "bridge-token";
const CHUNK_BYTES = 1024 * 1024;
const APP_URL = "app://renderer/transcripts/abc123.jsonl";
const PREPARE_REQUEST = {
  fileKey: "main",
  requestId: "req-1",
  sessionId: "ses-1",
};
const TRANSCRIPT_DENIAL_PATTERN =
  /^Desktop browser bridge does not relay transcript reads$/;
const transcriptManifest = {
  entries: { prepareTranscript: { kind: "method" } },
  kind: "object",
} as const;
