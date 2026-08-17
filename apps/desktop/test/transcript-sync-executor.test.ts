/**
 * @file transcript-sync-executor.test.ts
 * @description FEA-2715 per-file executor with an injected fake client + fake
 * filesystem. Covers the noop / fullPut / multipart plans, delta byte ranges,
 * newline-cut skips, the prefix-hash compute-target guard, the redacted
 * line-length terminal, and the not-caught-up (growth) result.
 *
 * Two policy clusters have their own owners: the file-size cap lives in
 * `transcript-sync-executor-size-cap.test.ts` (#4150) and the missing-source
 * recovery ladder in `transcript-sync-executor-missing-source.test.ts` (#4195).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TranscriptSkipReason,
  TranscriptUploadStatus,
} from "@repo/api/src/types/desktop-transcripts";
import { RedactedJsonlTranscriptLineTooLongError } from "@repo/lib/security/redacted-jsonl-transcript";
import type { TranscriptUploadedInput } from "../src/main/database/transcript-sync-settle.js";
import { createTranscriptSyncExecutor } from "../src/main/transcript-sync/transcript-sync-executor.js";
import { redactedArchiveCursorTargetId } from "../src/main/transcript-sync/transcript-sync-types.js";
// #4150 (shafty023 review): the executor fakes (recording store/client, fake fs
// deps, fingerprint + temp-transcript builders) moved to a focused sibling so
// this grandfathered test finishes below its pinned base rather than growing
// with the ISS-4647 source-recovery cluster. Shared with the parity suite.
import {
  A32,
  fakeFsDeps,
  fakeUploadWindow,
  fingerprint,
  NOW,
  recordingClient,
  recordingStore,
  SHA256_HEX_PATTERN,
  withTempTranscript,
} from "./helpers/transcript-sync-executor-fixtures.js";

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
  assert.equal(client.puts[0].body.length, 500);
  assert.equal(client.puts[0].crc, "crc-500");
  assert.equal(client.completeRequests.length, 1);
});

test("fullPut uploads redacted archive bytes and reports their object identity", async () => {
  const harmlessSecretShape = `sk_live_${A32}`;
  const rawLine = `${JSON.stringify({
    message: `token ${harmlessSecretShape} done`,
  })}\n`;
  const expectedRedacted = `${JSON.stringify({
    message: "token [REDACTED:sk_live] done",
  })}\n`;
  const expectedLength = Buffer.byteLength(expectedRedacted);

  await withTempTranscript(
    "redacted-full.jsonl",
    rawLine,
    async (sourcePath) => {
      const store = recordingStore();
      const client = recordingClient(
        {
          mode: "fullPut",
          url: "https://s3/put-redacted",
          planEndOffset: expectedLength,
          syncedByteOffset: 0,
          storedEtag: null,
        },
        expectedLength
      );
      const executor = createTranscriptSyncExecutor({
        store,
        client,
        getComputeTargetId: () => "ct-1",
        now: () => NOW,
      });

      const result = await executor.syncFile(fingerprint({ sourcePath }));

      assert.deepEqual(result, { kind: "uploaded", caughtUp: true });
      assert.equal(client.puts.length, 1);
      assert.equal(client.puts[0].length, expectedLength);
      assert.equal(client.puts[0].body.toString("utf8"), expectedRedacted);
      assert.equal(client.puts[0].body.includes(harmlessSecretShape), false);

      const planRequest = client.planRequests[0] as {
        planEndOffset: number;
        sha256: string;
        crc64nvme: string;
      };
      assert.equal(planRequest.planEndOffset, expectedLength);
      assert.match(planRequest.sha256, SHA256_HEX_PATTERN);
      assert.equal(planRequest.crc64nvme, client.puts[0].crc);

      const completeRequest = client.completeRequests[0] as {
        planEndOffset: number;
        sha256: string;
        crc64nvme: string;
      };
      assert.equal(completeRequest.planEndOffset, expectedLength);
      assert.equal(completeRequest.sha256, planRequest.sha256);
      assert.equal(completeRequest.crc64nvme, planRequest.crc64nvme);
    }
  );
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
    client.parts.map((p) => p.body.length),
    [300, 200]
  );
  const completeReq = client.completeRequests[0] as { uploadId?: string };
  assert.equal(completeReq.uploadId, "up-1");
});

test("multipart uploads redacted subagent bytes split across S3 part boundaries", async () => {
  const harmlessSecretShape = `sk_live_${A32}`;
  const rawContent =
    `${JSON.stringify({ message: `first ${harmlessSecretShape}` })}\n` +
    `${JSON.stringify({ message: "second line" })}\n`;
  const expectedRedacted =
    `${JSON.stringify({ message: "first [REDACTED:sk_live]" })}\n` +
    `${JSON.stringify({ message: "second line" })}\n`;
  const expectedBytes = Buffer.from(expectedRedacted);
  const splitOffset = expectedRedacted.indexOf("[REDACTED:sk_live]") + 8;

  await withTempTranscript(
    "redacted-subagent.jsonl",
    rawContent,
    async (sourcePath) => {
      const store = recordingStore();
      const client = recordingClient(
        {
          mode: "multipart",
          uploadId: "up-redacted",
          parts: [
            { partNumber: 1, offset: 0, byteLength: splitOffset, url: "u1" },
            {
              partNumber: 2,
              offset: splitOffset,
              byteLength: expectedBytes.length - splitOffset,
              url: "u2",
            },
          ],
          planEndOffset: expectedBytes.length,
          syncedByteOffset: 0,
          storedEtag: null,
        },
        expectedBytes.length
      );
      const executor = createTranscriptSyncExecutor({
        store,
        client,
        getComputeTargetId: () => "ct-1",
        now: () => NOW,
      });

      const result = await executor.syncFile(
        fingerprint({ fileKey: "subagent:agent-1", sourcePath })
      );

      assert.deepEqual(result, { kind: "uploaded", caughtUp: true });
      assert.deepEqual(
        client.parts.map((part) => part.length),
        [splitOffset, expectedBytes.length - splitOffset]
      );
      const storedBody = Buffer.concat(client.parts.map((part) => part.body));
      assert.equal(storedBody.toString("utf8"), expectedRedacted);
      assert.equal(storedBody.includes(harmlessSecretShape), false);

      const planRequest = client.planRequests[0] as {
        fileKey: string;
        planEndOffset: number;
      };
      assert.equal(planRequest.fileKey, "subagent:agent-1");
      assert.equal(planRequest.planEndOffset, expectedBytes.length);
      const completeRequest = client.completeRequests[0] as {
        fileKey: string;
        planEndOffset: number;
        mode: string;
        uploadId?: string;
      };
      assert.equal(completeRequest.fileKey, "subagent:agent-1");
      assert.equal(completeRequest.planEndOffset, expectedBytes.length);
      assert.equal(completeRequest.mode, "multipart");
      assert.equal(completeRequest.uploadId, "up-redacted");
    }
  );
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

test("prefixSha256 is sent only for redacted-domain cursors on the current compute target", async () => {
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
  // Legacy raw-domain cursor for this target -> omit prefixSha256 so the API
  // cannot copy raw S3 bytes into a new redacted archive object.
  await executor.syncFile(
    fingerprint({
      syncedByteOffset: 200,
      syncedSha256: "legacy-raw-sha",
      syncedComputeTargetId: "ct-1",
    })
  );
  // Cached prefix belongs to the CURRENT compute target -> include it.
  await executor.syncFile(
    fingerprint({
      syncedByteOffset: 200,
      syncedSha256: "good-sha",
      syncedComputeTargetId: redactedArchiveCursorTargetId("ct-1"),
    })
  );

  const first = client.planRequests[0] as { prefixSha256?: string };
  const second = client.planRequests[1] as { prefixSha256?: string };
  const third = client.planRequests[2] as { prefixSha256?: string };
  assert.equal(first.prefixSha256, undefined);
  assert.equal(second.prefixSha256, undefined);
  assert.equal(third.prefixSha256, "good-sha");
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
  const recorded = store.uploaded[0] as TranscriptUploadedInput;
  assert.equal(recorded.syncedByteOffset, 300);
  assert.equal(recorded.syncedSha256, "prior-prefix-sha");
  assert.equal(
    recorded.syncedComputeTargetId,
    redactedArchiveCursorTargetId("ct-1")
  );
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

test("successful sync is not failed when redacted temp cleanup fails", async () => {
  const store = recordingStore();
  const logs: string[] = [];
  const client = recordingClient(
    {
      mode: "fullPut",
      url: "u",
      planEndOffset: 5,
      syncedByteOffset: 0,
      storedEtag: null,
    },
    5
  );
  const executor = createTranscriptSyncExecutor({
    store,
    client,
    getComputeTargetId: () => "ct-1",
    now: () => NOW,
    log: (message) => logs.push(message),
    ...fakeFsDeps(Buffer.from("abcde")),
    prepareUploadWindow: () =>
      Promise.resolve({
        ...fakeUploadWindow(Buffer.from("abcde")),
        dispose: () => Promise.reject(new Error("rm failed")),
      }),
  });

  const result = await executor.syncFile(fingerprint());

  assert.deepEqual(result, { kind: "uploaded", caughtUp: true });
  assert.equal(store.uploaded.length, 1);
  assert.equal(store.failures.length, 0);
  assert.equal(
    logs.some((message) => message.includes("cleanup failed")),
    true
  );
});

test("redaction line-length overflow is terminally skipped, not retried", async () => {
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
    ...fakeFsDeps(Buffer.from("complete\n")),
    prepareUploadWindow: () =>
      Promise.reject(new RedactedJsonlTranscriptLineTooLongError()),
  });

  const result = await executor.syncFile(fingerprint());

  // Terminal skip: a single redacted line over the per-line wire limit can never
  // be fixed by re-uploading, so `permanent` marks it non-retryable (FEA-3489).
  assert.deepEqual(result, {
    kind: "skipped",
    reason: "redacted line too large",
    permanent: true,
  });
  assert.equal(store.dead.length, 1);
  assert.equal(store.failures.length, 0);
  assert.equal(client.planRequests.length, 0);
  assert.deepEqual(client.skipRequests[0], {
    computeTargetId: "ct-1",
    externalSessionId: "sess-1",
    fileKey: "main",
    sourceHarness: "claude",
    reason: "too_large",
  });
});

test("ISS-4621: a line-length overflow stays retryable when the cloud skip is NOT acknowledged", async () => {
  const store = recordingStore();
  const client = recordingClient(
    { mode: "noop", syncedByteOffset: 0, storedEtag: null },
    0
  );
  client.skip = () => Promise.reject(new Error("relay 502"));
  const executor = createTranscriptSyncExecutor({
    store,
    client,
    getComputeTargetId: () => "ct-1",
    now: () => NOW,
    ...fakeFsDeps(Buffer.from("complete\n")),
    prepareUploadWindow: () =>
      Promise.reject(new RedactedJsonlTranscriptLineTooLongError()),
  });

  const result = await executor.syncFile(fingerprint());

  // The overflow is deterministic, so a dead row would never re-observe and a
  // lost skip POST would strand the cloud on `syncing`. Back off and re-run the
  // whole terminal transition next drain; `permanent` is only reported once the
  // cloud acknowledged.
  assert.deepEqual(result, {
    kind: "skipped",
    reason: "redacted line too large",
  });
  assert.equal(store.dead.length, 0);
  assert.equal(store.failures.length, 1);
  assert.equal(store.failures[0].dead, false);

  // The transition converges: once the cloud comes back, the same file
  // dead-letters with the ack in hand.
  client.skip = (request: unknown) => {
    client.skipRequests.push(request);
    return Promise.resolve({
      status: "skipped" as const,
      permanentFailureReason: "too_large" as const,
      sessionDetailId: null,
    });
  };
  const retried = await executor.syncFile(fingerprint({ retryCount: 1 }));
  assert.deepEqual(retried, {
    kind: "skipped",
    reason: "redacted line too large",
    permanent: true,
  });
  assert.equal(store.dead.length, 1);
});

test("ISS-4621/ISS-4695: notifyPermanentSkip reports the cloud ack + status (acked skipped / transport-fail / offline)", async () => {
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

  // ISS-4695: the ack now carries the server's authoritative terminal status
  // (the default recordingClient answers `skipped`).
  assert.deepEqual(
    await executor.notifyPermanentSkip(
      fingerprint(),
      TranscriptSkipReason.RetriesExhausted
    ),
    { acked: true, status: TranscriptUploadStatus.Skipped }
  );
  assert.deepEqual(client.skipRequests[0], {
    computeTargetId: "ct-1",
    externalSessionId: "sess-1",
    fileKey: "main",
    sourceHarness: "claude",
    reason: "retries_exhausted",
  });

  // A caller-pinned target (the one the failed attempt ran against) wins over
  // the live target, so a reconnect between attempt and skip cannot split the
  // record across two target identities.
  assert.deepEqual(
    await executor.notifyPermanentSkip(
      fingerprint(),
      TranscriptSkipReason.RetriesExhausted,
      "ct-attempt"
    ),
    { acked: true, status: TranscriptUploadStatus.Skipped }
  );
  assert.deepEqual(
    (client.skipRequests[1] as { computeTargetId: string }).computeTargetId,
    "ct-attempt"
  );

  // ISS-4695: an `uploaded` answer is still acked, but carries the status the
  // drain-queue reads to AVOID dead-lettering (the cloud holds the bytes).
  client.skip = () =>
    Promise.resolve({
      status: TranscriptUploadStatus.Uploaded,
      permanentFailureReason: TranscriptSkipReason.RetriesExhausted,
      sessionDetailId: null,
    });
  assert.deepEqual(
    await executor.notifyPermanentSkip(
      fingerprint(),
      TranscriptSkipReason.RetriesExhausted
    ),
    { acked: true, status: TranscriptUploadStatus.Uploaded }
  );

  client.skip = () => Promise.reject(new Error("relay 502"));
  assert.deepEqual(
    await executor.notifyPermanentSkip(
      fingerprint(),
      TranscriptSkipReason.RetriesExhausted
    ),
    { acked: false }
  );

  const offline = createTranscriptSyncExecutor({
    store,
    client,
    getComputeTargetId: () => null,
    now: () => NOW,
    ...fakeFsDeps(null),
  });
  assert.deepEqual(
    await offline.notifyPermanentSkip(
      fingerprint(),
      TranscriptSkipReason.RetriesExhausted
    ),
    { acked: false }
  );
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
    prepareUploadWindow: (path: string, rawEndOffset: number) => {
      order.push("prepareUploadWindow");
      return fs.prepareUploadWindow(path, rawEndOffset);
    },
  });

  await executor.syncFile(fingerprint());
  // markUploading first proves it precedes every recorded read below it.
  assert.equal(order[0], "markUploading");
  assert.deepEqual(order, [
    "markUploading",
    "statFile",
    "findNewlineBoundary",
    "prepareUploadWindow",
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
