/**
 * @file transcript-read-ipc.test.ts
 * @description Behavioral tests for the main-process cloud-transcript read
 * bridge (FEA-3324 Option B2). Verifies trusted-sender rejection, the
 * signed-out short-circuit, that main mints the signed URL itself (read route,
 * with the first-party token — never a renderer-supplied URL) and streams the
 * bytes into the cache, and that it returns an opaque `app://` URL. No Electron.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { ORG_IDENTITY_HEADER } from "@repo/api/src/types/headers";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import {
  registerTranscriptReadIpcHandler,
  type TranscriptReadDeps,
} from "../src/main/ipc/transcript-read-ipc.js";
import { buildTranscriptAppUrl } from "../src/main/transcript/transcript-read-cache.js";
import {
  TRANSCRIPT_CANCEL_CHANNEL,
  TRANSCRIPT_PREPARE_CHANNEL,
  type TranscriptPrepareResult,
} from "../src/shared/transcript-read-contract.js";

const TRUSTED_SENDER = { id: 1 } as unknown as WebContents;
const UNTRUSTED_SENDER = { id: 2 } as unknown as WebContents;
const TRUSTED_EVENT = { sender: TRUSTED_SENDER } as IpcMainInvokeEvent;
const UNTRUSTED_EVENT = { sender: UNTRUSTED_SENDER } as IpcMainInvokeEvent;
const API_ORIGIN = "https://api.closedloop.test";
const SESSION_ID = "sess-1";
// Harness session id — deliberately DIFFERENT from the cloud SESSION_ID so the
// tests catch a regression that keys the local lookup by the wrong id.
const EXTERNAL_SESSION_ID = "ext-harness-1";
const RAW_SHA = "a".repeat(64);
const SIGNED_S3 = "https://bucket.s3.us-east-1.amazonaws.com/main.jsonl?sig=x";
const TRANSCRIPT_BYTES = "line1\nline2\n";
const UNTRUSTED_SENDER_ERROR = /untrusted sender/;

const testRoot = mkdtempSync(path.join(tmpdir(), "transcript-read-ipc-test-"));
let counter = 0;
after(() => rmSync(testRoot, { recursive: true, force: true }));

type FileDescriptorOverrides = {
  url?: string | null;
  rawSha256?: string | null;
  fileKey?: string;
};

function descriptorResponse(file: FileDescriptorOverrides = {}) {
  return {
    sessionId: SESSION_ID,
    files: [
      {
        fileKey: file.fileKey ?? "main",
        availability: "available",
        url: file.url === undefined ? SIGNED_S3 : file.url,
        byteSize: TRANSCRIPT_BYTES.length,
        rawSha256: file.rawSha256 === undefined ? RAW_SHA : file.rawSha256,
        uploadedAt: "2026-07-16T00:00:00.000Z",
        lastObservedAt: "2026-07-16T00:00:00.000Z",
      },
    ],
  };
}

const LOCAL_BYTES = "local-line-1\nlocal-line-2\n";
const LOCAL_SHA = createHash("sha256").update(LOCAL_BYTES).digest("hex");

type HarnessOptions = {
  token?: string | null;
  identity?: { userId: string; organizationId: string } | null;
  descriptor?: unknown;
  accessStatus?: number;
  /**
   * Trusted server-side lookup result for the local `.jsonl` (the sync store's
   * `sourcePath`), or undefined to omit the local-fallback deps entirely (web
   * shape — no fallback attempted).
   */
  localPath?: string | null;
  /**
   * Emulate `resolveTrustedClaudeTranscriptPath`: return the vetted real path,
   * or null to refuse (untrusted / traversal / nonexistent). Defaults to a
   * pass-through that accepts the resolved path when `localPath` is set.
   */
  resolveTrustedTranscriptPath?: (candidate: string) => string | null;
  /** Fail the S3 byte download (descriptor is still readable). */
  downloadStatus?: number;
  /** Override the eviction age bound (for the post-staging sweep test). */
  maxAgeMs?: number;
  /** Override the eviction total-byte bound. */
  maxTotalBytes?: number;
};

type FetchCall = { url: string; headers: Headers | undefined };

function createHarness(options: HarnessOptions = {}) {
  counter += 1;
  const cacheDir = path.join(testRoot, `case-${counter}`);
  const fetchCalls: FetchCall[] = [];
  let handler:
    | ((
        event: IpcMainInvokeEvent,
        request: unknown
      ) => Promise<TranscriptPrepareResult>)
    | undefined;
  let cancelHandler:
    | ((event: IpcMainInvokeEvent, request: unknown) => Promise<void>)
    | undefined;

  const fetchImpl = ((input: string | URL, init?: RequestInit) => {
    const url = String(input);
    fetchCalls.push({ url, headers: init?.headers as Headers | undefined });
    if (url.endsWith("/transcript")) {
      const descriptor = options.descriptor ?? descriptorResponse();
      return Promise.resolve(
        new Response(JSON.stringify(descriptor), {
          status: options.accessStatus ?? 200,
        })
      );
    }
    return Promise.resolve(
      new Response(TRANSCRIPT_BYTES, { status: options.downloadStatus ?? 200 })
    );
  }) as typeof fetch;

  const hasLocalDeps = "localPath" in options;
  // Record every arg the local-path resolver was called with, so tests can
  // assert the lookup key (must be the harness externalSessionId, not the cloud
  // sessionId).
  const localLookupArgs: Array<{ externalSessionId: string; fileKey: string }> =
    [];
  const deps: TranscriptReadDeps = {
    isTrustedSender: (sender) => sender === TRUSTED_SENDER,
    getAccessToken: () =>
      Promise.resolve("token" in options ? (options.token ?? null) : "tok-123"),
    getIdentity: () =>
      options.identity === undefined
        ? { userId: "u1", organizationId: "org-1" }
        : options.identity,
    resolveApiOrigin: () => API_ORIGIN,
    cacheDir,
    fetchImpl,
    now: () => 1_700_000_000_000,
    ...(options.maxAgeMs === undefined ? {} : { maxAgeMs: options.maxAgeMs }),
    ...(options.maxTotalBytes === undefined
      ? {}
      : { maxTotalBytes: options.maxTotalBytes }),
    ...(hasLocalDeps
      ? {
          getLocalTranscriptPath: (externalSessionId, fileKey) => {
            localLookupArgs.push({ externalSessionId, fileKey });
            return Promise.resolve(options.localPath ?? null);
          },
          resolveTrustedTranscriptPath:
            options.resolveTrustedTranscriptPath ?? ((candidate) => candidate),
        }
      : {}),
  };

  registerTranscriptReadIpcHandler(
    {
      handle: (channel, fn) => {
        if (channel === TRANSCRIPT_CANCEL_CHANNEL) {
          cancelHandler = fn as typeof cancelHandler;
        } else {
          handler = fn as typeof handler;
        }
      },
    },
    deps
  );
  if (!(handler && cancelHandler)) {
    throw new Error("transcript handlers were not registered");
  }
  return { handler, cancelHandler, fetchCalls, cacheDir, localLookupArgs };
}

// Local-fallback requests carry the harness externalSessionId (the desktop
// renderer forwards `session.externalSessionId`); without it no local fallback
// is attempted.
const REQUEST = {
  sessionId: SESSION_ID,
  externalSessionId: EXTERNAL_SESSION_ID,
  fileKey: "main",
};

test("rejects an untrusted sender", () => {
  const { handler } = createHarness();
  // The trusted-sender guard throws synchronously (Electron converts it to a
  // rejected invoke); assert the synchronous throw directly.
  assert.throws(
    () => handler(UNTRUSTED_EVENT, REQUEST),
    UNTRUSTED_SENDER_ERROR
  );
});

test("rejects a malformed request", async () => {
  const { handler } = createHarness();
  const result = await handler(TRUSTED_EVENT, { sessionId: SESSION_ID });
  assert.deepEqual(result, {
    kind: "error",
    message: "Malformed transcript request.",
  });
});

test("short-circuits to an error when signed out (no network)", async () => {
  const { handler, fetchCalls } = createHarness({ token: null });
  const result = await handler(TRUSTED_EVENT, REQUEST);
  assert.deepEqual(result, {
    kind: "error",
    message: "Desktop is not signed in.",
  });
  assert.equal(fetchCalls.length, 0);
});

test("mints the URL via the read route, caches the bytes, and returns an app:// URL", async () => {
  const { handler, fetchCalls, cacheDir } = createHarness();
  const result = await handler(TRUSTED_EVENT, REQUEST);
  assert.deepEqual(result, {
    kind: "ready",
    url: buildTranscriptAppUrl(RAW_SHA),
    source: "cloud",
  });

  // Read route was called first with the first-party token + org header.
  const accessCall = fetchCalls.find((call) =>
    call.url.endsWith("/transcript")
  );
  assert.ok(accessCall);
  assert.equal(
    accessCall.url,
    `${API_ORIGIN}/agent-sessions/${SESSION_ID}/transcript`
  );
  assert.equal(accessCall.headers?.get("authorization"), "Bearer tok-123");
  assert.equal(accessCall.headers?.get(ORG_IDENTITY_HEADER), "org-1");

  // Then the signed S3 URL was fetched and streamed to the content-addressed file.
  assert.ok(fetchCalls.some((call) => call.url === SIGNED_S3));
  assert.equal(
    readFileSync(path.join(cacheDir, `${RAW_SHA}.jsonl`), "utf8"),
    TRANSCRIPT_BYTES
  );
});

test("errors when the requested fileKey is absent from the descriptor", async () => {
  const { handler } = createHarness({
    descriptor: descriptorResponse({ fileKey: "subagent:other" }),
  });
  const result = await handler(TRUSTED_EVENT, REQUEST);
  assert.deepEqual(result, {
    kind: "error",
    message: "Transcript file not found.",
  });
});

test("errors when the file is not readable (null signed URL)", async () => {
  const { handler, fetchCalls } = createHarness({
    descriptor: descriptorResponse({ url: null }),
  });
  const result = await handler(TRUSTED_EVENT, REQUEST);
  assert.deepEqual(result, {
    kind: "error",
    message: "Transcript is not available for reading.",
  });
  // Never attempted the S3 download.
  assert.equal(
    fetchCalls.some((call) => call.url === SIGNED_S3),
    false
  );
});

test("errors when the read route fails", async () => {
  const { handler } = createHarness({ accessStatus: 403 });
  const result = await handler(TRUSTED_EVENT, REQUEST);
  assert.equal(result.kind, "error");
});

/** Write a real local `.jsonl` and return its absolute path. */
function writeLocalTranscript(): string {
  counter += 1;
  const dir = mkdtempSync(path.join(testRoot, `local-${counter}-`));
  const file = path.join(dir, "session.jsonl");
  writeFileSync(file, LOCAL_BYTES);
  return file;
}

test("falls back to the local copy when the cloud file is not readable (null URL)", async () => {
  const localPath = writeLocalTranscript();
  const { handler, fetchCalls, cacheDir } = createHarness({
    descriptor: descriptorResponse({ url: null, rawSha256: null }),
    localPath,
  });
  const result = await handler(TRUSTED_EVENT, REQUEST);
  assert.deepEqual(result, {
    kind: "ready",
    url: buildTranscriptAppUrl(LOCAL_SHA),
    source: "local",
  });
  // The cloud copy was never downloaded; the local bytes are staged under their
  // own content address.
  assert.equal(
    fetchCalls.some((call) => call.url === SIGNED_S3),
    false
  );
  assert.equal(
    readFileSync(path.join(cacheDir, `${LOCAL_SHA}.jsonl`), "utf8"),
    LOCAL_BYTES
  );
});

test("falls back to the local copy when the read route (descriptor) fails", async () => {
  const localPath = writeLocalTranscript();
  const { handler } = createHarness({ accessStatus: 500, localPath });
  const result = await handler(TRUSTED_EVENT, REQUEST);
  assert.deepEqual(result, {
    kind: "ready",
    url: buildTranscriptAppUrl(LOCAL_SHA),
    source: "local",
  });
});

test("falls back to the local copy when the S3 byte download fails", async () => {
  const localPath = writeLocalTranscript();
  const { handler } = createHarness({ downloadStatus: 500, localPath });
  const result = await handler(TRUSTED_EVENT, REQUEST);
  assert.deepEqual(result, {
    kind: "ready",
    url: buildTranscriptAppUrl(LOCAL_SHA),
    source: "local",
  });
});

test("falls back to the local copy when the requested fileKey is absent", async () => {
  const localPath = writeLocalTranscript();
  const { handler } = createHarness({
    descriptor: descriptorResponse({ fileKey: "subagent:other" }),
    localPath,
  });
  const result = await handler(TRUSTED_EVENT, REQUEST);
  assert.deepEqual(result, {
    kind: "ready",
    url: buildTranscriptAppUrl(LOCAL_SHA),
    source: "local",
  });
});

test("falls back to the local copy when signed out (no token, no network)", async () => {
  const localPath = writeLocalTranscript();
  const { handler, fetchCalls } = createHarness({ token: null, localPath });
  const result = await handler(TRUSTED_EVENT, REQUEST);
  assert.deepEqual(result, {
    kind: "ready",
    url: buildTranscriptAppUrl(LOCAL_SHA),
    source: "local",
  });
  assert.equal(fetchCalls.length, 0);
});

test("refuses an untrusted local path — no SSRF/traversal regression", async () => {
  // The trusted-path resolver rejects (as `resolveTrustedClaudeTranscriptPath`
  // would for a path outside the transcript root); the handler must NOT read it
  // and must surface the original cloud error instead.
  const { handler } = createHarness({
    descriptor: descriptorResponse({ url: null, rawSha256: null }),
    localPath: "/etc/passwd",
    resolveTrustedTranscriptPath: () => null,
  });
  const result = await handler(TRUSTED_EVENT, REQUEST);
  assert.deepEqual(result, {
    kind: "error",
    message: "Transcript is not available for reading.",
  });
});

test("returns the cloud error when there is no local copy tracked", async () => {
  const { handler } = createHarness({
    descriptor: descriptorResponse({ url: null, rawSha256: null }),
    localPath: null,
  });
  const result = await handler(TRUSTED_EVENT, REQUEST);
  assert.deepEqual(result, {
    kind: "error",
    message: "Transcript is not available for reading.",
  });
});

test("prefers the cloud copy when it is readable (fallback deps present)", async () => {
  const localPath = writeLocalTranscript();
  const { handler } = createHarness({ localPath });
  const result = await handler(TRUSTED_EVENT, REQUEST);
  // Cloud is preferred: the readable descriptor wins, source is cloud.
  assert.deepEqual(result, {
    kind: "ready",
    url: buildTranscriptAppUrl(RAW_SHA),
    source: "cloud",
  });
});

/** Write a real local `.jsonl` of a given byte size and return its path. */
function writeLargeLocalTranscript(size: number): string {
  counter += 1;
  const dir = mkdtempSync(path.join(testRoot, `local-big-${counter}-`));
  const file = path.join(dir, "session.jsonl");
  writeFileSync(file, "x".repeat(size));
  return file;
}

test("gates an oversized local fallback file behind the load cap without staging", async () => {
  const localPath = writeLargeLocalTranscript(64);
  const { handler, cacheDir } = createHarness({
    descriptor: descriptorResponse({ url: null, rawSha256: null }),
    localPath,
  });
  const result = await handler(TRUSTED_EVENT, {
    ...REQUEST,
    maxAutoLoadBytes: 16,
  });
  assert.deepEqual(result, {
    kind: "oversized",
    byteSize: 64,
    source: "local",
  });
  // Nothing was staged — the cache dir has no <sha>.jsonl for the big file.
  assert.throws(() =>
    readFileSync(
      path.join(
        cacheDir,
        `${createHash("sha256").update("x".repeat(64)).digest("hex")}.jsonl`
      )
    )
  );
});

test("stages the oversized local file once the user opts in (allowOversized)", async () => {
  const localPath = writeLargeLocalTranscript(64);
  const bigSha = createHash("sha256").update("x".repeat(64)).digest("hex");
  const { handler, cacheDir } = createHarness({
    descriptor: descriptorResponse({ url: null, rawSha256: null }),
    localPath,
  });
  const result = await handler(TRUSTED_EVENT, {
    ...REQUEST,
    maxAutoLoadBytes: 16,
    allowOversized: true,
  });
  assert.deepEqual(result, {
    kind: "ready",
    url: buildTranscriptAppUrl(bigSha),
    source: "local",
  });
  assert.equal(
    readFileSync(path.join(cacheDir, `${bigSha}.jsonl`), "utf8"),
    "x".repeat(64)
  );
});

test("serves an under-cap local file directly (no oversize gate)", async () => {
  const localPath = writeLocalTranscript();
  const { handler } = createHarness({
    descriptor: descriptorResponse({ url: null, rawSha256: null }),
    localPath,
  });
  const result = await handler(TRUSTED_EVENT, {
    ...REQUEST,
    maxAutoLoadBytes: 1024 * 1024,
  });
  assert.deepEqual(result, {
    kind: "ready",
    url: buildTranscriptAppUrl(LOCAL_SHA),
    source: "local",
  });
});

test("keys the local lookup by the harness externalSessionId, not the cloud sessionId", async () => {
  // The whole fallback silently no-ops if the local store/discovery is queried
  // with the cloud artifact id instead of the harness id. Assert the resolver
  // receives externalSessionId.
  const localPath = writeLocalTranscript();
  const { handler, localLookupArgs } = createHarness({
    descriptor: descriptorResponse({ url: null, rawSha256: null }),
    localPath,
  });
  const result = await handler(TRUSTED_EVENT, REQUEST);
  assert.equal(result.kind, "ready");
  assert.equal(localLookupArgs.length, 1);
  assert.deepEqual(localLookupArgs[0], {
    externalSessionId: EXTERNAL_SESSION_ID,
    fileKey: "main",
  });
  // Guard the exact regression: the cloud id must NOT be used as the key.
  assert.notEqual(localLookupArgs[0].externalSessionId, SESSION_ID);
});

test("does not attempt a local fallback when externalSessionId is absent", async () => {
  // Older callers / the web transport omit externalSessionId — with no harness
  // id there is nothing to resolve, so the cloud error stands and the resolver
  // is never called (no wasted discovery sweep).
  const localPath = writeLocalTranscript();
  const { handler, localLookupArgs } = createHarness({
    descriptor: descriptorResponse({ url: null, rawSha256: null }),
    localPath,
  });
  const result = await handler(TRUSTED_EVENT, {
    sessionId: SESSION_ID,
    fileKey: "main",
  });
  assert.deepEqual(result, {
    kind: "error",
    message: "Transcript is not available for reading.",
  });
  assert.equal(localLookupArgs.length, 0);
});

test("runs the cache eviction sweep after staging a local fallback", async () => {
  // A locally-staged copy is a cache entry too; the post-download sweep that
  // bounds cloud downloads must also run after local staging, else the cache
  // grows unbounded with local copies when cloud reads keep failing.
  const localPath = writeLocalTranscript();
  const { handler, cacheDir } = createHarness({
    descriptor: descriptorResponse({ url: null, rawSha256: null }),
    localPath,
    // Any entry older than 1 ms is stale relative to the fixed `now`.
    maxAgeMs: 1,
  });
  // Seed a stale cache entry with an old mtime so the sweep must evict it.
  mkdirSync(cacheDir, { recursive: true });
  const staleSha = "b".repeat(64);
  const stalePath = path.join(cacheDir, `${staleSha}.jsonl`);
  writeFileSync(stalePath, "stale\n");
  // mtime well before the harness's fixed `now` (1.7e12 ms ⇒ 1.7e9 s).
  utimesSync(stalePath, 1_600_000_000, 1_600_000_000);

  const result = await handler(TRUSTED_EVENT, REQUEST);
  assert.equal(result.kind, "ready");
  // The freshly-staged local copy is present…
  assert.equal(
    readFileSync(path.join(cacheDir, `${LOCAL_SHA}.jsonl`), "utf8"),
    LOCAL_BYTES
  );
  // …and the stale entry was swept (eviction ran after local staging).
  assert.throws(() => readFileSync(stalePath));
});

test("registers on the transcript-prepare and cancel channels", () => {
  const channels: string[] = [];
  registerTranscriptReadIpcHandler(
    {
      handle: (ch) => {
        channels.push(ch);
      },
    },
    {
      isTrustedSender: () => false,
      getAccessToken: () => Promise.resolve(null),
      getIdentity: () => null,
      resolveApiOrigin: () => API_ORIGIN,
      cacheDir: testRoot,
    }
  );
  assert.ok(channels.includes(TRANSCRIPT_PREPARE_CHANNEL));
  assert.ok(channels.includes(TRANSCRIPT_CANCEL_CHANNEL));
});

/**
 * A controllable S3-download fetch (FEA-3678): the descriptor read resolves
 * immediately, but the byte download hangs until its `AbortSignal` fires — so a
 * test can observe the in-flight download and cancel it mid-stream. Returns the
 * registered prepare/cancel handlers plus a getter for the signal the download
 * received.
 */
function createHangingDownloadHarness() {
  counter += 1;
  const cacheDir = path.join(testRoot, `cancel-${counter}`);
  let downloadSignal: AbortSignal | undefined;
  const fetchImpl = ((input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/transcript")) {
      return Promise.resolve(
        new Response(JSON.stringify(descriptorResponse()), { status: 200 })
      );
    }
    // The (potentially large) S3 byte download: hang until the combined
    // timeout+cancel signal aborts, then reject like a torn-down fetch.
    downloadSignal = init?.signal as AbortSignal | undefined;
    return new Promise<Response>((_resolve, reject) => {
      downloadSignal?.addEventListener("abort", () =>
        reject(new Error("The operation was aborted"))
      );
    });
  }) as typeof fetch;

  let handler:
    | ((event: IpcMainInvokeEvent, req: unknown) => Promise<unknown>)
    | undefined;
  let cancelHandler:
    | ((event: IpcMainInvokeEvent, req: unknown) => Promise<void>)
    | undefined;
  registerTranscriptReadIpcHandler(
    {
      handle: (channel, fn) => {
        if (channel === TRANSCRIPT_CANCEL_CHANNEL) {
          cancelHandler = fn as typeof cancelHandler;
        } else {
          handler = fn as typeof handler;
        }
      },
    },
    {
      isTrustedSender: (sender) => sender === TRUSTED_SENDER,
      getAccessToken: () => Promise.resolve("tok-123"),
      getIdentity: () => null,
      resolveApiOrigin: () => API_ORIGIN,
      cacheDir,
      fetchImpl,
    }
  );
  if (!(handler && cancelHandler)) {
    throw new Error("transcript handlers were not registered");
  }
  return {
    handler,
    cancelHandler,
    getDownloadSignal: () => downloadSignal,
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

test("cancelTranscriptPrepare aborts the in-flight main-process download", async () => {
  const { handler, cancelHandler, getDownloadSignal } =
    createHangingDownloadHarness();
  const requestId = "req-cancel-1";
  // Prepare with NO local fallback deps — so an aborted cloud download surfaces
  // the error (rather than silently serving a local copy) and we can assert it.
  const pending = handler(TRUSTED_EVENT, {
    sessionId: SESSION_ID,
    fileKey: "main",
    requestId,
  });
  // Let the descriptor read resolve and the byte download kick off (and hang).
  await tick();
  const signal = getDownloadSignal();
  assert.ok(signal, "download should have started");
  assert.equal(signal.aborted, false);

  // The user clicks Cancel → renderer invokes the cancel channel with the same id.
  await cancelHandler(TRUSTED_EVENT, { requestId });
  // The main-process download's signal is aborted mid-stream (egress stops).
  assert.equal(signal.aborted, true);
  const result = (await pending) as TranscriptPrepareResult;
  assert.equal(result.kind, "error");
});

test("cancelTranscriptPrepare rejects an untrusted sender", () => {
  const { cancelHandler } = createHangingDownloadHarness();
  assert.throws(
    () => cancelHandler(UNTRUSTED_EVENT, { requestId: "x" }),
    UNTRUSTED_SENDER_ERROR
  );
});

test("cancelTranscriptPrepare is a no-op for an unknown requestId", async () => {
  const { cancelHandler, getDownloadSignal } = createHangingDownloadHarness();
  // No prepare is in flight for this id — must not throw.
  await cancelHandler(TRUSTED_EVENT, { requestId: "never-registered" });
  assert.equal(getDownloadSignal(), undefined);
});

test("cancelTranscriptPrepare ignores a malformed request", async () => {
  const { cancelHandler } = createHangingDownloadHarness();
  await cancelHandler(TRUSTED_EVENT, { requestId: "" });
  await cancelHandler(TRUSTED_EVENT, {});
});
