/**
 * @file transcript-sync-executor.test.ts
 * @description FEA-2715 per-file executor with an injected fake client + fake
 * filesystem. Covers the noop / fullPut / multipart plans, delta byte ranges,
 * newline-cut + missing-file skips, the prefix-hash compute-target guard, and
 * the not-caught-up (growth) result.
 */
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { TranscriptSyncStore } from "../src/main/database/transcript-sync-store.js";
import type { DesktopTranscriptsClient } from "../src/main/desktop-transcripts-client.js";
import { createTranscriptSyncExecutor } from "../src/main/transcript-sync/transcript-sync-executor.js";
import type { TranscriptFingerprint } from "../src/main/transcript-sync/transcript-sync-types.js";

const PATH = "/home/.claude/projects/p/sess-1.jsonl";
const NOW = "2026-07-09T00:00:00.000Z";

function fingerprint(
  overrides: Partial<TranscriptFingerprint> = {}
): TranscriptFingerprint {
  return {
    externalSessionId: "sess-1",
    fileKey: "main",
    sourceHarness: "claude",
    sourcePath: PATH,
    sourcePathHash: "hash-1",
    lastMtimeMs: 1000,
    lastSize: 500,
    syncedByteOffset: 0,
    syncedSha256: null,
    storedEtag: null,
    syncedComputeTargetId: null,
    status: "queued",
    syncClass: "live",
    retryCount: 0,
    nextAttemptAt: null,
    lastError: null,
    ...overrides,
  };
}

type RecordingStore = TranscriptSyncStore & {
  uploaded: unknown[];
  idled: string[];
  uploadingMarks: string[];
};

function recordingStore(): RecordingStore {
  const store = {
    uploaded: [] as unknown[],
    idled: [] as string[],
    uploadingMarks: [] as string[],
    get: () => Promise.resolve(null),
    listAll: () => Promise.resolve([]),
    listReady: () => Promise.resolve([]),
    observe: () => Promise.resolve(fingerprint()),
    markUploading: (id: string, key: string) => {
      store.uploadingMarks.push(`${id}:${key}`);
      return Promise.resolve();
    },
    markIdle: (id: string, key: string) => {
      store.idled.push(`${id}:${key}`);
      return Promise.resolve();
    },
    recordUploaded: (input: unknown) => {
      store.uploaded.push(input);
      return Promise.resolve();
    },
    recordFailure: () => Promise.resolve(),
    requeueStale: () => Promise.resolve(0),
  };
  return store as unknown as RecordingStore;
}

/** Drain a streamed upload body, returning the exact byte count received. */
async function streamedLength(body: Readable): Promise<number> {
  let total = 0;
  for await (const chunk of body) {
    total += (chunk as Buffer).length;
  }
  return total;
}

type RecordingClient = DesktopTranscriptsClient & {
  planRequests: unknown[];
  puts: { url: string; length: number; streamed: number; crc: string }[];
  parts: { url: string; length: number; streamed: number }[];
  completeRequests: unknown[];
};

function recordingClient(
  plan: Awaited<ReturnType<DesktopTranscriptsClient["syncPlan"]>>,
  completeOffset: number
): RecordingClient {
  const client = {
    planRequests: [] as unknown[],
    puts: [] as {
      url: string;
      length: number;
      streamed: number;
      crc: string;
    }[],
    parts: [] as { url: string; length: number; streamed: number }[],
    completeRequests: [] as unknown[],
    syncPlan: (request: unknown) => {
      client.planRequests.push(request);
      return Promise.resolve(plan);
    },
    uploadPut: async (
      url: string,
      body: Readable,
      contentLength: number,
      crc: string
    ) => {
      const streamed = await streamedLength(body);
      client.puts.push({ url, length: contentLength, streamed, crc });
    },
    uploadPart: async (url: string, body: Readable, contentLength: number) => {
      const streamed = await streamedLength(body);
      client.parts.push({ url, length: contentLength, streamed });
    },
    complete: (request: unknown) => {
      client.completeRequests.push(request);
      return Promise.resolve({
        status: "uploaded" as const,
        syncedByteOffset: completeOffset,
        storedEtag: "etag-final",
        sessionDetailId: null,
      });
    },
  };
  return client as unknown as RecordingClient;
}

function fakeFsDeps(fileBytes: Buffer | null) {
  return {
    statFile: () =>
      Promise.resolve(
        fileBytes ? { size: fileBytes.length, mtimeMs: 1000 } : null
      ),
    openByteRangeStream: (_path: string, start: number, end: number) =>
      Readable.from([(fileBytes ?? Buffer.alloc(0)).subarray(start, end)]),
    computeWindowChecksums: (_path: string, endOffset: number) =>
      Promise.resolve({
        sha256Hex: `sha-${endOffset}`,
        crc64NvmeBase64: `crc-${endOffset}`,
        byteLength: endOffset,
      }),
    findNewlineBoundary: (_path: string, maxOffset: number) =>
      Promise.resolve(maxOffset),
  };
}

test("fullPut uploads the whole window with the checksum header and completes", async () => {
  const store = recordingStore();
  const client = recordingClient(
    {
      mode: "fullPut",
      url: "https://s3/put",
      planEndOffset: 500,
      syncedByteOffset: 0,
      storedEtag: null,
    },
    500
  );
  const executor = createTranscriptSyncExecutor({
    store,
    client,
    getComputeTargetId: () => "ct-1",
    now: () => NOW,
    ...fakeFsDeps(Buffer.alloc(500, 1)),
  });

  const result = await executor.syncFile(fingerprint());
  assert.deepEqual(result, { kind: "uploaded", caughtUp: true });
  assert.equal(store.uploadingMarks.length, 1);
  assert.equal(client.puts.length, 1);
  assert.equal(client.puts[0].length, 500);
  // The declared Content-Length matches what was actually streamed (not buffered).
  assert.equal(client.puts[0].streamed, 500);
  assert.equal(client.puts[0].crc, "crc-500");
  assert.equal(client.completeRequests.length, 1);
});

test("multipart PUTs each delta part's byte range then completes with uploadId", async () => {
  const store = recordingStore();
  const client = recordingClient(
    {
      mode: "multipart",
      uploadId: "up-1",
      parts: [
        { partNumber: 1, offset: 0, byteLength: 300, url: "u1" },
        { partNumber: 2, offset: 300, byteLength: 200, url: "u2" },
      ],
      planEndOffset: 500,
      syncedByteOffset: 0,
      storedEtag: null,
    },
    500
  );
  const executor = createTranscriptSyncExecutor({
    store,
    client,
    getComputeTargetId: () => "ct-1",
    now: () => NOW,
    ...fakeFsDeps(Buffer.alloc(500, 2)),
  });

  const result = await executor.syncFile(fingerprint());
  assert.equal(result.kind, "uploaded");
  assert.deepEqual(
    client.parts.map((p) => p.length),
    [300, 200]
  );
  // Each part's declared Content-Length matches the streamed delta byte range.
  assert.deepEqual(
    client.parts.map((p) => p.streamed),
    [300, 200]
  );
  const completeReq = client.completeRequests[0] as { uploadId?: string };
  assert.equal(completeReq.uploadId, "up-1");
});

test("noop records the server offset without uploading", async () => {
  const store = recordingStore();
  const client = recordingClient(
    { mode: "noop", syncedByteOffset: 500, storedEtag: "etag-noop" },
    500
  );
  const executor = createTranscriptSyncExecutor({
    store,
    client,
    getComputeTargetId: () => "ct-1",
    now: () => NOW,
    ...fakeFsDeps(Buffer.alloc(500, 3)),
  });

  const result = await executor.syncFile(fingerprint());
  assert.deepEqual(result, { kind: "noop" });
  assert.equal(client.puts.length, 0);
  assert.equal(client.parts.length, 0);
  assert.equal(store.uploaded.length, 1);
});

test("a missing file is skipped and idled", async () => {
  const store = recordingStore();
  const client = recordingClient(
    { mode: "noop", syncedByteOffset: 0, storedEtag: null },
    0
  );
  const executor = createTranscriptSyncExecutor({
    store,
    client,
    getComputeTargetId: () => "ct-1",
    now: () => NOW,
    ...fakeFsDeps(null),
  });

  const result = await executor.syncFile(fingerprint());
  assert.deepEqual(result, { kind: "skipped", reason: "file missing" });
  assert.deepEqual(store.idled, ["sess-1:main"]);
});

test("no complete line yet is skipped and idled", async () => {
  const store = recordingStore();
  const client = recordingClient(
    { mode: "noop", syncedByteOffset: 0, storedEtag: null },
    0
  );
  const executor = createTranscriptSyncExecutor({
    store,
    client,
    getComputeTargetId: () => "ct-1",
    now: () => NOW,
    ...fakeFsDeps(Buffer.alloc(100, 4)),
    findNewlineBoundary: () => Promise.resolve(0),
  });

  const result = await executor.syncFile(fingerprint());
  assert.equal(result.kind, "skipped");
  assert.deepEqual(store.idled, ["sess-1:main"]);
});

test("prefixSha256 is sent only when the cached hash matches the compute target", async () => {
  const store = recordingStore();
  const client = recordingClient(
    { mode: "noop", syncedByteOffset: 500, storedEtag: null },
    500
  );
  const executor = createTranscriptSyncExecutor({
    store,
    client,
    getComputeTargetId: () => "ct-1",
    now: () => NOW,
    ...fakeFsDeps(Buffer.alloc(500, 5)),
  });

  // Cached prefix belongs to a DIFFERENT compute target -> omit prefixSha256.
  await executor.syncFile(
    fingerprint({
      syncedByteOffset: 200,
      syncedSha256: "old-sha",
      syncedComputeTargetId: "ct-OTHER",
    })
  );
  // Cached prefix belongs to the CURRENT compute target -> include it.
  await executor.syncFile(
    fingerprint({
      syncedByteOffset: 200,
      syncedSha256: "good-sha",
      syncedComputeTargetId: "ct-1",
    })
  );

  const first = client.planRequests[0] as { prefixSha256?: string };
  const second = client.planRequests[1] as { prefixSha256?: string };
  assert.equal(first.prefixSha256, undefined);
  assert.equal(second.prefixSha256, "good-sha");
});

test("a still-growing file reports not caught up (stays queued for the next tick)", async () => {
  const store = recordingStore();
  // Server acked only 300 of the 500-byte window (more appended concurrently).
  const client = recordingClient(
    {
      mode: "fullPut",
      url: "u",
      planEndOffset: 500,
      syncedByteOffset: 0,
      storedEtag: null,
    },
    300
  );
  const executor = createTranscriptSyncExecutor({
    store,
    client,
    getComputeTargetId: () => "ct-1",
    now: () => NOW,
    ...fakeFsDeps(Buffer.alloc(500, 6)),
  });

  const result = await executor.syncFile(
    fingerprint({
      syncedByteOffset: 200,
      syncedSha256: "prior-prefix-sha",
      syncedComputeTargetId: "ct-1",
    })
  );
  assert.deepEqual(result, { kind: "uploaded", caughtUp: false });
  // Not caught up: the recorded cursor advances to the server offset but the
  // prefix hash must NOT become the full `[0, planEndOffset)` window hash
  // (`sha-500`) — that would make the next sync send a `prefixSha256` for the
  // wrong range and force a full re-upload. Keep the prior prefix hash
  // (mirroring the noop branch).
  assert.equal(store.uploaded.length, 1);
  const recorded = store.uploaded[0] as {
    syncedByteOffset: number;
    syncedSha256: string | null;
    caughtUp: boolean;
  };
  assert.equal(recorded.syncedByteOffset, 300);
  assert.equal(recorded.syncedSha256, "prior-prefix-sha");
  assert.equal(recorded.caughtUp, false);
});

test("a caught-up upload records the fresh window hash as the prefix", async () => {
  const store = recordingStore();
  const client = recordingClient(
    {
      mode: "fullPut",
      url: "u",
      planEndOffset: 500,
      syncedByteOffset: 0,
      storedEtag: null,
    },
    500
  );
  const executor = createTranscriptSyncExecutor({
    store,
    client,
    getComputeTargetId: () => "ct-1",
    now: () => NOW,
    ...fakeFsDeps(Buffer.alloc(500, 6)),
  });

  const result = await executor.syncFile(
    fingerprint({ syncedSha256: "prior-prefix-sha" })
  );
  assert.deepEqual(result, { kind: "uploaded", caughtUp: true });
  const recorded = store.uploaded[0] as { syncedSha256: string | null };
  // Caught up -> adopt the just-computed `[0, planEndOffset)` window hash.
  assert.equal(recorded.syncedSha256, "sha-500");
});

test("marks the row uploading before any stat/checksum read (FEA-2827 race guard)", async () => {
  // The row must be claimed as `uploading` BEFORE the multi-second stat + newline
  // scan + checksum window, so a concurrent `observe` on a file that just grew
  // preserves the growth signal instead of advancing lastMtimeMs past the
  // appended bytes and dropping them permanently at session end.
  const order: string[] = [];
  const store = recordingStore();
  store.markUploading = () => {
    order.push("markUploading");
    return Promise.resolve();
  };
  const client = recordingClient(
    {
      mode: "fullPut",
      url: "u",
      planEndOffset: 500,
      syncedByteOffset: 0,
      storedEtag: null,
    },
    500
  );
  const fs = fakeFsDeps(Buffer.alloc(500, 8));
  const executor = createTranscriptSyncExecutor({
    store,
    client,
    getComputeTargetId: () => "ct-1",
    now: () => NOW,
    ...fs,
    statFile: (_path: string) => {
      order.push("statFile");
      return fs.statFile();
    },
    findNewlineBoundary: (path: string, maxOffset: number) => {
      order.push("findNewlineBoundary");
      return fs.findNewlineBoundary(path, maxOffset);
    },
    computeWindowChecksums: (path: string, endOffset: number) => {
      order.push("computeWindowChecksums");
      return fs.computeWindowChecksums(path, endOffset);
    },
  });

  await executor.syncFile(fingerprint());
  // markUploading first proves it precedes every recorded read below it.
  assert.equal(order[0], "markUploading");
  assert.deepEqual(order, [
    "markUploading",
    "statFile",
    "findNewlineBoundary",
    "computeWindowChecksums",
  ]);
});

test("syncing while offline throws", async () => {
  const store = recordingStore();
  const client = recordingClient(
    { mode: "noop", syncedByteOffset: 0, storedEtag: null },
    0
  );
  const executor = createTranscriptSyncExecutor({
    store,
    client,
    getComputeTargetId: () => null,
    now: () => NOW,
    ...fakeFsDeps(Buffer.alloc(10, 7)),
  });

  await assert.rejects(() => executor.syncFile(fingerprint()));
});
