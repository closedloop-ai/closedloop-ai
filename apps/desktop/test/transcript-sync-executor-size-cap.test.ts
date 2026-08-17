/**
 * @file transcript-sync-executor-size-cap.test.ts
 * @description The transcript executor's FILE-SIZE policy, end to end: the
 * oversize dead-letter (and its retryable unacked-skip path), the FEA-3489
 * `bypassSizeCap` override and resume-in-progress drain, the shared
 * dead-letter reason prefix the force-revive matches on, and the FEA-3583
 * raised cap plus its runaway backstop.
 *
 * #4150: split out of `transcript-sync-executor.test.ts` (a shrink-only
 * grandfathered file) so the size-cap policy has one owner and that suite
 * finishes below its pinned base instead of growing with the ISS-4647
 * source-recovery cluster. Shares the executor fakes with its siblings via
 * `./helpers/transcript-sync-executor-fixtures.js`.
 */
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import {
  TranscriptSkipReason,
  TranscriptUploadStatus,
} from "@repo/api/src/types/desktop-transcripts";
import { createTranscriptSyncExecutor } from "../src/main/transcript-sync/transcript-sync-executor.js";
import {
  TRANSCRIPT_OVERSIZED_DEAD_LETTER_PREFIX,
  TRANSCRIPT_SYNC_MAX_FILE_BYTES,
} from "../src/main/transcript-sync/transcript-sync-types.js";
import {
  fakeUploadWindow,
  fingerprint,
  NOW,
  recordingClient,
  recordingStore,
} from "./helpers/transcript-sync-executor-fixtures.js";

test("an oversize file is dead-lettered before any read or upload", async () => {
  const store = recordingStore();
  const client = recordingClient(
    { mode: "noop", syncedByteOffset: 0, storedEtag: null },
    0
  );
  const oversize = TRANSCRIPT_SYNC_MAX_FILE_BYTES + 1;
  const executor = createTranscriptSyncExecutor({
    store,
    client,
    getComputeTargetId: () => "ct-1",
    now: () => NOW,
    // Report an oversize file without allocating it. The expensive newline scan
    // and full-window checksum MUST NOT run — they'd throw here if reached.
    statFile: () => Promise.resolve({ size: oversize, mtimeMs: 1000 }),
    prepareUploadWindow: () => {
      throw new Error("must not prepare upload window for an oversize file");
    },
    findNewlineBoundary: () => {
      throw new Error("must not scan an oversize file");
    },
  });

  const result = await executor.syncFile(fingerprint());
  assert.deepEqual(result, { kind: "skipped", reason: "file too large" });
  // Claimed the row, then dead-lettered it — no plan, no bytes uploaded.
  assert.equal(store.uploadingMarks.length, 1);
  assert.equal(store.dead.length, 1);
  assert.equal(store.dead[0].id, "sess-1");
  assert.equal(store.dead[0].key, "main");
  assert.ok(store.dead[0].reason.includes("exceeds"));
  assert.equal(client.planRequests.length, 0);
  assert.equal(client.puts.length, 0);
  assert.equal(client.parts.length, 0);
  assert.equal(store.idled.length, 0);
  // FEA-3476: the terminal skip is mirrored to the cloud so the read path can
  // derive `failedPermanent` — identity + reason only, no bytes/checksums.
  assert.equal(client.skipRequests.length, 1);
  assert.deepEqual(client.skipRequests[0], {
    computeTargetId: "ct-1",
    externalSessionId: "sess-1",
    fileKey: "main",
    sourceHarness: "claude",
    reason: "too_large",
  });
});

test("ISS-4621: an oversize file stays retryable when the cloud skip is NOT acknowledged", async () => {
  const store = recordingStore();
  const client = recordingClient(
    { mode: "noop", syncedByteOffset: 0, storedEtag: null },
    0
  );
  client.skip = () => Promise.reject(new Error("relay 502"));
  const oversize = TRANSCRIPT_SYNC_MAX_FILE_BYTES + 1;
  const executor = createTranscriptSyncExecutor({
    store,
    client,
    getComputeTargetId: () => "ct-1",
    now: () => NOW,
    statFile: () => Promise.resolve({ size: oversize, mtimeMs: 1000 }),
    prepareUploadWindow: () => {
      throw new Error("must not prepare upload window for an oversize file");
    },
    findNewlineBoundary: () => {
      throw new Error("must not scan an oversize file");
    },
  });

  const result = await executor.syncFile(fingerprint());
  // NOT dead: an unchanged oversized file never re-observes a dead row, so a
  // lost skip POST would strand the cloud on `syncing`. The row backs off and
  // the whole cap transition (skip, then dead) re-runs on the next drain.
  assert.deepEqual(result, { kind: "skipped", reason: "file too large" });
  assert.equal(store.dead.length, 0);
  assert.equal(store.failures.length, 1);
  assert.equal(store.failures[0].dead, false);
  assert.equal(store.failures[0].missingSourceCount, 0);
  assert.ok(store.failures[0].nextAttemptAt !== null);
});

test("ISS-4695: an oversize file the cloud already holds (status uploaded) settles readable, NOT dead", async () => {
  const store = recordingStore();
  const client = recordingClient(
    { mode: "noop", syncedByteOffset: 0, storedEtag: null },
    0
  );
  // The server refused to mask a verified archive with a late skip and answered
  // `uploaded` — the cloud STILL holds readable bytes for this file.
  client.skip = (request: unknown) => {
    client.skipRequests.push(request);
    return Promise.resolve({
      status: TranscriptUploadStatus.Uploaded,
      permanentFailureReason: TranscriptSkipReason.TooLarge,
      sessionDetailId: null,
    });
  };
  const oversize = TRANSCRIPT_SYNC_MAX_FILE_BYTES + 1;
  const executor = createTranscriptSyncExecutor({
    store,
    client,
    getComputeTargetId: () => "ct-1",
    now: () => NOW,
    statFile: () => Promise.resolve({ size: oversize, mtimeMs: 1000 }),
    prepareUploadWindow: () => {
      throw new Error("must not prepare upload window for an oversize file");
    },
    findNewlineBoundary: () => {
      throw new Error("must not scan an oversize file");
    },
  });

  const result = await executor.syncFile(fingerprint());

  // The skip WAS emitted, but the row must NOT be dead-lettered — the cloud
  // truth is that the file is uploaded, so marking it `dead` would project
  // `failedPermanent` for a synced transcript (the ISS-4695 lie). Settle
  // readable — and, per ISS-4815, through the DURABLE cloud-uploaded terminal
  // rather than a bare `idle` the stranded-blob recovery would re-arm on the
  // next launch.
  assert.deepEqual(result, { kind: "skipped", reason: "file too large" });
  assert.equal(client.skipRequests.length, 1);
  assert.equal(store.dead.length, 0);
  assert.deepEqual(store.cloudUploaded, ["sess-1:main"]);
  assert.deepEqual(store.idled, []);
  assert.equal(store.failures.length, 0);
  // Non-permanent: no `permanent: true` flag, so the force-archive path does not
  // surface a terminal dead end for a file the cloud actually holds.
  assert.equal((result as { permanent?: boolean }).permanent, undefined);
});

test("ISS-4695: an oversize file the cloud recorded as skipped IS dead-lettered (regression pin)", async () => {
  const store = recordingStore();
  const client = recordingClient(
    { mode: "noop", syncedByteOffset: 0, storedEtag: null },
    0
  );
  // Server RECORDED the terminal skip -> the cloud agrees the file is
  // permanently absent, so the local row goes `dead` as before.
  client.skip = (request: unknown) => {
    client.skipRequests.push(request);
    return Promise.resolve({
      status: TranscriptUploadStatus.Skipped,
      permanentFailureReason: TranscriptSkipReason.TooLarge,
      sessionDetailId: null,
    });
  };
  const oversize = TRANSCRIPT_SYNC_MAX_FILE_BYTES + 1;
  const executor = createTranscriptSyncExecutor({
    store,
    client,
    getComputeTargetId: () => "ct-1",
    now: () => NOW,
    statFile: () => Promise.resolve({ size: oversize, mtimeMs: 1000 }),
    prepareUploadWindow: () => {
      throw new Error("must not prepare upload window for an oversize file");
    },
    findNewlineBoundary: () => {
      throw new Error("must not scan an oversize file");
    },
  });

  const result = await executor.syncFile(fingerprint());
  assert.deepEqual(result, { kind: "skipped", reason: "file too large" });
  assert.equal(client.skipRequests.length, 1);
  assert.equal(store.dead.length, 1);
  assert.equal(store.idled.length, 0);
  assert.equal(store.failures.length, 0);
});

test("ISS-4695: an unknown skip status (version-skewed server) leaves the row retryable, never dead", async () => {
  const store = recordingStore();
  const client = recordingClient(
    { mode: "noop", syncedByteOffset: 0, storedEtag: null },
    0
  );
  // A newer/older server answered a non-terminal status the desktop did not
  // expect for a skip (`pending`). That is NOT a permanent skip signal, so the
  // row must stay on the retry ladder rather than dead-letter on ambiguity.
  client.skip = (request: unknown) => {
    client.skipRequests.push(request);
    return Promise.resolve({
      status: TranscriptUploadStatus.Pending,
      permanentFailureReason: TranscriptSkipReason.TooLarge,
      sessionDetailId: null,
    });
  };
  const oversize = TRANSCRIPT_SYNC_MAX_FILE_BYTES + 1;
  const executor = createTranscriptSyncExecutor({
    store,
    client,
    getComputeTargetId: () => "ct-1",
    now: () => NOW,
    statFile: () => Promise.resolve({ size: oversize, mtimeMs: 1000 }),
    prepareUploadWindow: () => {
      throw new Error("must not prepare upload window for an oversize file");
    },
    findNewlineBoundary: () => {
      throw new Error("must not scan an oversize file");
    },
  });

  const result = await executor.syncFile(fingerprint());
  assert.deepEqual(result, { kind: "skipped", reason: "file too large" });
  assert.equal(client.skipRequests.length, 1);
  // Neither dead nor idled: recorded as a retryable failure so the transition
  // re-runs on the next drain instead of committing to a permanent state.
  assert.equal(store.dead.length, 0);
  assert.equal(store.idled.length, 0);
  assert.equal(store.failures.length, 1);
  assert.equal(store.failures[0].dead, false);
  assert.ok(store.failures[0].nextAttemptAt !== null);
});

test("FEA-3489: bypassSizeCap uploads an oversize file instead of dead-lettering it", async () => {
  const store = recordingStore();
  const client = recordingClient(
    {
      mode: "fullPut",
      url: "https://s3/put-oversize",
      planEndOffset: 500,
      syncedByteOffset: 0,
      storedEtag: null,
    },
    500
  );
  // A file that WOULD trip the automatic size-cap dead-letter above.
  const oversizeBytes = Buffer.alloc(500, 1);
  const executor = createTranscriptSyncExecutor({
    store,
    client,
    getComputeTargetId: () => "ct-1",
    now: () => NOW,
    // Report the file's size as over the cap, but serve only 500 bytes for the
    // window (the cap gate keys off `statFile`, not the streamed length).
    statFile: () =>
      Promise.resolve({
        size: TRANSCRIPT_SYNC_MAX_FILE_BYTES + 1,
        mtimeMs: 1000,
      }),
    prepareUploadWindow: () => Promise.resolve(fakeUploadWindow(oversizeBytes)),
    findNewlineBoundary: (_path: string, maxOffset: number) =>
      Promise.resolve(maxOffset),
  });

  // The user-initiated override waives the file-size gate for THIS call.
  const result = await executor.syncFile(fingerprint(), {
    bypassSizeCap: true,
  });

  assert.deepEqual(result, { kind: "uploaded", caughtUp: true });
  // The oversize backstop did NOT fire: the row was not dead-lettered and no
  // terminal skip was emitted — the bytes uploaded through the normal lane.
  assert.equal(store.dead.length, 0);
  assert.equal(client.skipRequests.length, 0);
  assert.equal(client.puts.length, 1);
  assert.equal(client.completeRequests.length, 1);
});

test("FEA-3489: without bypassSizeCap an oversize file still dead-letters (default is enforced)", async () => {
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
    statFile: () =>
      Promise.resolve({
        size: TRANSCRIPT_SYNC_MAX_FILE_BYTES + 1,
        mtimeMs: 1000,
      }),
    prepareUploadWindow: () => {
      throw new Error("must not prepare upload window without bypass");
    },
    findNewlineBoundary: () => {
      throw new Error("must not scan without bypass");
    },
  });

  // Same file, but no override (and an explicit `false`): the cap backstop wins.
  const result = await executor.syncFile(fingerprint(), {
    bypassSizeCap: false,
  });
  assert.deepEqual(result, { kind: "skipped", reason: "file too large" });
  assert.equal(store.dead.length, 1);
  assert.equal(client.skipRequests.length, 1);
});

test("FEA-3489: an oversize RESUME IN PROGRESS (syncedByteOffset > 0) is finished by the automatic drain, not re-dead-lettered", async () => {
  const store = recordingStore();
  const client = recordingClient(
    {
      mode: "fullPut",
      url: "https://s3/put-resume",
      planEndOffset: 500,
      syncedByteOffset: 200,
      storedEtag: "etag-resume",
    },
    500
  );
  const bytes = Buffer.alloc(500, 1);
  const executor = createTranscriptSyncExecutor({
    store,
    client,
    getComputeTargetId: () => "ct-1",
    now: () => NOW,
    statFile: () =>
      Promise.resolve({
        size: TRANSCRIPT_SYNC_MAX_FILE_BYTES + 1,
        mtimeMs: 1000,
      }),
    prepareUploadWindow: () => Promise.resolve(fakeUploadWindow(bytes)),
    findNewlineBoundary: (_path: string, maxOffset: number) =>
      Promise.resolve(maxOffset),
  });

  // NO bypass option — this is the ordinary drain. Because a prior forced window
  // already committed bytes to the cloud (syncedByteOffset > 0), the cap must be
  // waived so the resume completes instead of stranding the partial upload.
  const result = await executor.syncFile(
    fingerprint({ syncedByteOffset: 200, syncedSha256: "prefix-sha" })
  );

  assert.deepEqual(result, { kind: "uploaded", caughtUp: true });
  assert.equal(store.dead.length, 0);
  assert.equal(client.skipRequests.length, 0);
  assert.equal(client.puts.length, 1);
  assert.equal(client.completeRequests.length, 1);
});

test("FEA-3489: the oversize dead-letter reason carries the shared cap prefix so the force-revive can match it", async () => {
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
    statFile: () =>
      Promise.resolve({
        size: TRANSCRIPT_SYNC_MAX_FILE_BYTES + 1,
        mtimeMs: 1000,
      }),
    prepareUploadWindow: () => {
      throw new Error("must not prepare upload window for an oversize file");
    },
    findNewlineBoundary: () => {
      throw new Error("must not scan an oversize file");
    },
  });

  await executor.syncFile(fingerprint());
  assert.equal(store.dead.length, 1);
  assert.ok(
    store.dead[0].reason.startsWith(TRANSCRIPT_OVERSIZED_DEAD_LETTER_PREFIX)
  );
});

test("FEA-3583: a large main transcript (over the old 25 MiB cap) is synced, not dropped", async () => {
  // Regression for the large-session symptom: the main `<sessionId>.jsonl` of a
  // long session is tens of MB and used to be dead-lettered (`too_large`) while
  // its small subagent sidechains synced — leaving the session detail with
  // subagent transcripts but no primary trace. With the raised cap the main file
  // now streams through plan -> upload -> complete like any other file.
  const OLD_CAP = 25 * 1024 * 1024;
  const largeMainSize = OLD_CAP * 4; // ~100 MiB main transcript
  assert.ok(
    largeMainSize < TRANSCRIPT_SYNC_MAX_FILE_BYTES,
    "a realistic large main transcript must be under the pathological backstop"
  );
  const store = recordingStore();
  const client = recordingClient(
    {
      mode: "multipart",
      uploadId: "up-big",
      parts: [
        { partNumber: 1, offset: 0, byteLength: largeMainSize, url: "u1" },
      ],
      planEndOffset: largeMainSize,
      syncedByteOffset: 0,
      storedEtag: null,
    },
    largeMainSize
  );
  const executor = createTranscriptSyncExecutor({
    store,
    client,
    getComputeTargetId: () => "ct-1",
    now: () => NOW,
    // Report a large main transcript without allocating ~100 MiB: the streamed
    // upload/checksum/newline deps ignore the reported size and stream empty.
    statFile: () => Promise.resolve({ size: largeMainSize, mtimeMs: 1000 }),
    prepareUploadWindow: (_path: string, rawEndOffset: number) =>
      Promise.resolve({
        planEndOffset: rawEndOffset,
        checksums: {
          sha256Hex: `sha-${rawEndOffset}`,
          crc64NvmeBase64: `crc-${rawEndOffset}`,
          byteLength: rawEndOffset,
        },
        openRangeStream: () => Readable.from([]),
        dispose: () => Promise.resolve(),
      }),
    findNewlineBoundary: (_path: string, maxOffset: number) =>
      Promise.resolve(maxOffset),
  });

  const result = await executor.syncFile(fingerprint());
  // Uploaded, not skipped/dead-lettered.
  assert.equal(result.kind, "uploaded");
  assert.equal(store.dead.length, 0);
  assert.equal(client.skipRequests.length, 0);
  // It really went through the sync plan + multipart upload + complete path.
  assert.equal(client.planRequests.length, 1);
  assert.equal(client.parts.length, 1);
  assert.equal(client.completeRequests.length, 1);
});

test("FEA-3583: a pathological runaway file above the backstop is still dead-lettered", async () => {
  // The cap is retained as a backstop only. A file beyond any realistic session
  // still terminally skips before any read/upload.
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
    statFile: () =>
      Promise.resolve({
        size: TRANSCRIPT_SYNC_MAX_FILE_BYTES + 1,
        mtimeMs: 1000,
      }),
    prepareUploadWindow: () => {
      throw new Error("must not prepare a pathological file");
    },
    findNewlineBoundary: () => {
      throw new Error("must not scan a pathological file");
    },
  });

  const result = await executor.syncFile(fingerprint());
  assert.deepEqual(result, { kind: "skipped", reason: "file too large" });
  assert.equal(store.dead.length, 1);
  assert.equal(client.planRequests.length, 0);
  assert.equal(client.skipRequests.length, 1);
});
