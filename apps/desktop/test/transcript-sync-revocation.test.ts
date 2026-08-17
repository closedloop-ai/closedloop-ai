/**
 * @file transcript-sync-revocation.test.ts
 * @description FEA-3907: the privacy gate must take effect at the EXECUTOR
 * boundary, not only on the next drain tick. When the user lowers the Data &
 * Sync level to Off (or the consent tier closes) WHILE a transcript upload is in
 * flight, the executor must stop sending bytes immediately (throwing
 * `TranscriptSyncRevokedError`) and the service must settle the row back to a
 * retryable state without dead-lettering or advancing the failure ladder.
 */
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { TranscriptSyncStore } from "../src/main/database/transcript-sync-store.js";
import type { DesktopTranscriptsClient } from "../src/main/transcript/desktop-transcripts-client.js";
import {
  createTranscriptSyncExecutor,
  TranscriptSyncRevokedError,
} from "../src/main/transcript-sync/transcript-sync-executor.js";
import type { TranscriptFingerprint } from "../src/main/transcript-sync/transcript-sync-types.js";

const NOW = "2026-07-23T00:00:00.000Z";

function fingerprint(): TranscriptFingerprint {
  return {
    externalSessionId: "sess-1",
    fileKey: "main",
    sourceHarness: "claude",
    sourcePath: "/home/.claude/projects/p/sess-1.jsonl",
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
    missingSourceCount: 0,
    nextAttemptAt: null,
    lastError: null,
  };
}

type Counters = {
  syncPlans: number;
  puts: number;
  parts: number;
  completes: number;
  uploadingMarks: number;
  idles: number;
};

function fakeStore(counters: Counters): TranscriptSyncStore {
  const store = {
    get: () => Promise.resolve(null),
    listAll: () => Promise.resolve([]),
    listReady: () => Promise.resolve([]),
    observe: () => Promise.resolve(fingerprint()),
    markUploading: () => {
      counters.uploadingMarks += 1;
      return Promise.resolve();
    },
    markIdle: () => {
      counters.idles += 1;
      return Promise.resolve();
    },
    markDead: () => Promise.resolve(),
    recordUploaded: () => Promise.resolve(),
    recordFailure: () => Promise.resolve(),
    requeueStale: () => Promise.resolve(0),
  };
  return store as unknown as TranscriptSyncStore;
}

function fakeClient(
  plan: Awaited<ReturnType<DesktopTranscriptsClient["syncPlan"]>>,
  counters: Counters
): DesktopTranscriptsClient {
  const client = {
    syncPlan: () => {
      counters.syncPlans += 1;
      return Promise.resolve(plan);
    },
    uploadPut: () => {
      counters.puts += 1;
      return Promise.resolve();
    },
    uploadPart: () => {
      counters.parts += 1;
      return Promise.resolve();
    },
    complete: () => {
      counters.completes += 1;
      return Promise.resolve({
        status: "uploaded" as const,
        syncedByteOffset: 500,
        storedEtag: "etag",
        sessionDetailId: null,
      });
    },
    skip: () => Promise.resolve(),
  };
  return client as unknown as DesktopTranscriptsClient;
}

function fakeFsDeps(size: number) {
  return {
    statFile: () => Promise.resolve({ size, mtimeMs: 1000 }),
    prepareUploadWindow: () =>
      Promise.resolve({
        planEndOffset: size,
        checksums: {
          sha256Hex: `sha-${size}`,
          crc64NvmeBase64: `crc-${size}`,
          byteLength: size,
        },
        openRangeStream: () => Readable.from([Buffer.alloc(size, 1)]),
        dispose: () => Promise.resolve(),
      }),
    findNewlineBoundary: (_path: string, maxOffset: number) =>
      Promise.resolve(maxOffset),
  };
}

function newCounters(): Counters {
  return {
    syncPlans: 0,
    puts: 0,
    parts: 0,
    completes: 0,
    uploadingMarks: 0,
    idles: 0,
  };
}

test("executor aborts before any byte egress when the gate is already revoked", async () => {
  const counters = newCounters();
  const executor = createTranscriptSyncExecutor({
    store: fakeStore(counters),
    client: fakeClient(
      {
        mode: "fullPut",
        url: "s3",
        planEndOffset: 500,
        syncedByteOffset: 0,
        storedEtag: null,
      },
      counters
    ),
    getComputeTargetId: () => "ct-1",
    isSyncStillPermitted: () => false,
    now: () => NOW,
    ...fakeFsDeps(500),
  });

  await assert.rejects(
    () => executor.syncFile(fingerprint()),
    (error) => error instanceof TranscriptSyncRevokedError
  );
  // Fail-closed BEFORE claiming the row or sending anything.
  assert.equal(counters.uploadingMarks, 0);
  assert.equal(counters.puts, 0);
  assert.equal(counters.completes, 0);
});

test("executor stops mid-multipart the instant the gate flips to revoked", async () => {
  const counters = newCounters();
  // Permit the plan + first part, then revoke before the second part.
  let calls = 0;
  const executor = createTranscriptSyncExecutor({
    store: fakeStore(counters),
    client: fakeClient(
      {
        mode: "multipart",
        uploadId: "up-1",
        parts: [
          { partNumber: 1, url: "s3/1", offset: 0, byteLength: 250 },
          { partNumber: 2, url: "s3/2", offset: 250, byteLength: 250 },
        ],
        // A full 500-byte upload split into two 250-byte parts.
        planEndOffset: 500,
        syncedByteOffset: 0,
        storedEtag: null,
      },
      counters
    ),
    getComputeTargetId: () => "ct-1",
    isSyncStillPermitted: () => {
      calls += 1;
      // Gate checks in order: syncFile top-check (1), pre-syncPlan (2, ISS-4623),
      // first-part (3) — all pass; second-part (4) revokes.
      return calls < 4;
    },
    now: () => NOW,
    ...fakeFsDeps(500),
  });

  await assert.rejects(
    () => executor.syncFile(fingerprint()),
    (error) => error instanceof TranscriptSyncRevokedError
  );
  // Exactly one part left the device; `complete` never fired, so the object is
  // never finalized/readable in the cloud.
  assert.equal(counters.parts, 1);
  assert.equal(counters.completes, 0);
});

test("permitted upload proceeds unchanged (no false revocation)", async () => {
  const counters = newCounters();
  const executor = createTranscriptSyncExecutor({
    store: fakeStore(counters),
    client: fakeClient(
      {
        mode: "fullPut",
        url: "s3",
        planEndOffset: 500,
        syncedByteOffset: 0,
        storedEtag: null,
      },
      counters
    ),
    getComputeTargetId: () => "ct-1",
    isSyncStillPermitted: () => true,
    now: () => NOW,
    ...fakeFsDeps(500),
  });

  const result = await executor.syncFile(fingerprint());
  assert.deepEqual(result, { kind: "uploaded", caughtUp: true });
  assert.equal(counters.puts, 1);
  assert.equal(counters.completes, 1);
});

// ISS-4623 (shafty023 review): `syncFile` samples the gate + target ONCE, then
// awaits stat / newline-scan / redacted-window prep before `syncPlan` — the FIRST
// server egress, which POSTs session id + content hashes. A gate close in that
// gap must abort BEFORE `syncPlan`, not send the identity and only stop the later
// upload parts.
test("executor aborts before syncPlan when the gate closes after entry (no identity POST)", async () => {
  const counters = newCounters();
  let permitted = true;
  const executor = createTranscriptSyncExecutor({
    store: fakeStore(counters),
    client: fakeClient(
      {
        mode: "fullPut",
        url: "s3",
        planEndOffset: 500,
        syncedByteOffset: 0,
        storedEtag: null,
      },
      counters
    ),
    getComputeTargetId: () => "ct-1",
    isSyncStillPermitted: () => permitted,
    now: () => NOW,
    // The window-prep await is where the gate closes (user lowers the level /
    // org policy flips off) between the entry check and syncPlan.
    statFile: () => Promise.resolve({ size: 500, mtimeMs: 1000 }),
    prepareUploadWindow: () => {
      permitted = false;
      return Promise.resolve({
        planEndOffset: 500,
        checksums: {
          sha256Hex: "sha-500",
          crc64NvmeBase64: "crc-500",
          byteLength: 500,
        },
        openRangeStream: () => Readable.from([Buffer.alloc(500, 1)]),
        dispose: () => Promise.resolve(),
      });
    },
    findNewlineBoundary: (_path: string, maxOffset: number) =>
      Promise.resolve(maxOffset),
  });

  await assert.rejects(
    () => executor.syncFile(fingerprint()),
    (error) => error instanceof TranscriptSyncRevokedError
  );
  // syncPlan (and everything after) never fired: no session id / hash left.
  assert.equal(counters.syncPlans, 0);
  assert.equal(counters.puts, 0);
  assert.equal(counters.completes, 0);
});

// ISS-4623 (shafty023 review): if the online compute target switches (reconnect /
// account switch) during those same awaits, the attempt must not pair the PREVIOUS
// target with newly-resolved credentials — it aborts and re-plans against the new
// target on the next drain.
test("executor aborts before syncPlan when the compute target switches after entry", async () => {
  const counters = newCounters();
  let target = "ct-1";
  const executor = createTranscriptSyncExecutor({
    store: fakeStore(counters),
    client: fakeClient(
      {
        mode: "fullPut",
        url: "s3",
        planEndOffset: 500,
        syncedByteOffset: 0,
        storedEtag: null,
      },
      counters
    ),
    getComputeTargetId: () => target,
    isSyncStillPermitted: () => true,
    now: () => NOW,
    statFile: () => Promise.resolve({ size: 500, mtimeMs: 1000 }),
    prepareUploadWindow: () => {
      // The target reconnects to a different id mid-attempt.
      target = "ct-2";
      return Promise.resolve({
        planEndOffset: 500,
        checksums: {
          sha256Hex: "sha-500",
          crc64NvmeBase64: "crc-500",
          byteLength: 500,
        },
        openRangeStream: () => Readable.from([Buffer.alloc(500, 1)]),
        dispose: () => Promise.resolve(),
      });
    },
    findNewlineBoundary: (_path: string, maxOffset: number) =>
      Promise.resolve(maxOffset),
  });

  await assert.rejects(
    () => executor.syncFile(fingerprint()),
    (error) => error instanceof TranscriptSyncRevokedError
  );
  assert.equal(counters.syncPlans, 0);
  assert.equal(counters.puts, 0);
  assert.equal(counters.completes, 0);
});
