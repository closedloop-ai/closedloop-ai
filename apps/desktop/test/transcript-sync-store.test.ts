/**
 * @file transcript-sync-store.test.ts
 * @description FEA-2715 fingerprint/upload-cursor store against a real libSQL
 * database (the production migration runner). Covers observe/change-detection,
 * enqueue vs stay-idle, upload/failure cursor transitions, dead-letter
 * revival-on-change, and the live-before-backfill ready ordering.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TranscriptObserveInput } from "../src/main/database/transcript-sync-store.js";
import {
  createTranscriptSyncStore,
  type TranscriptSyncStore,
} from "../src/main/database/transcript-sync-store.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const T0 = "2026-07-09T00:00:00.000Z";

function observeInput(
  overrides: Partial<TranscriptObserveInput> = {}
): TranscriptObserveInput {
  return {
    externalSessionId: "sess-1",
    fileKey: "main",
    sourceHarness: "claude",
    sourcePath: "/home/.claude/projects/p/sess-1.jsonl",
    sourcePathHash: "hash-1",
    mtimeMs: 1000,
    size: 500,
    syncClass: "backfill",
    now: T0,
    ...overrides,
  };
}

async function withStore(
  run: (store: TranscriptSyncStore) => Promise<void>
): Promise<void> {
  const { prisma, close } = await openTestPrisma();
  try {
    await run(createTranscriptSyncStore(prisma));
  } finally {
    await close();
  }
}

test("observe creates a queued row with the fingerprint fields", async () => {
  await withStore(async (store) => {
    const fp = await store.observe(observeInput());
    assert.equal(fp.status, "queued");
    assert.equal(fp.syncClass, "backfill");
    assert.equal(fp.lastSize, 500);
    assert.equal(fp.syncedByteOffset, 0);
    const persisted = await store.get("sess-1", "main");
    assert.equal(persisted?.status, "queued");
  });
});

test("recordUploaded advances the cursor and idles a caught-up file", async () => {
  await withStore(async (store) => {
    await store.observe(observeInput());
    await store.recordUploaded({
      externalSessionId: "sess-1",
      fileKey: "main",
      syncedByteOffset: 500,
      syncedSha256: "sha-500",
      storedEtag: "etag-1",
      syncedComputeTargetId: "ct-1",
      caughtUp: true,
      now: T0,
    });
    const fp = await store.get("sess-1", "main");
    assert.equal(fp?.status, "idle");
    assert.equal(fp?.syncedByteOffset, 500);
    assert.equal(fp?.syncedSha256, "sha-500");
    assert.equal(fp?.syncedComputeTargetId, "ct-1");
  });
});

test("re-observing an unchanged, fully-synced file stays idle", async () => {
  await withStore(async (store) => {
    await store.observe(observeInput());
    await store.recordUploaded({
      externalSessionId: "sess-1",
      fileKey: "main",
      syncedByteOffset: 500,
      syncedSha256: "sha-500",
      storedEtag: "etag-1",
      syncedComputeTargetId: "ct-1",
      caughtUp: true,
      now: T0,
    });
    const fp = await store.observe(observeInput());
    assert.equal(fp.status, "idle");
  });
});

test("a fractional-mtime file re-observed identically stays idle (FEA-2834)", async () => {
  await withStore(async (store) => {
    // Real filesystems (APFS/ext4) report sub-ms `fs.stat` mtimeMs. The stored
    // `lastMtimeMs` is truncated to an integer, so the comparison must truncate
    // the observed mtime too — otherwise change-detection is defeated and every
    // sweep re-queues the file.
    const mtimeMs = 1_704_067_200_123.4;
    await store.observe(observeInput({ mtimeMs }));
    await store.recordUploaded({
      externalSessionId: "sess-1",
      fileKey: "main",
      syncedByteOffset: 500,
      syncedSha256: "sha-500",
      storedEtag: "etag-1",
      syncedComputeTargetId: "ct-1",
      caughtUp: true,
      now: T0,
    });
    // The next discovery sweep observes the same file with the same fractional
    // mtime: it must settle to idle and NOT re-queue.
    const fp = await store.observe(observeInput({ mtimeMs }));
    assert.equal(fp.status, "idle");
  });
});

test("a grown file re-queues on observe", async () => {
  await withStore(async (store) => {
    await store.observe(observeInput());
    await store.recordUploaded({
      externalSessionId: "sess-1",
      fileKey: "main",
      syncedByteOffset: 500,
      syncedSha256: "sha-500",
      storedEtag: "etag-1",
      syncedComputeTargetId: "ct-1",
      caughtUp: true,
      now: T0,
    });
    const fp = await store.observe(observeInput({ mtimeMs: 2000, size: 900 }));
    assert.equal(fp.status, "queued");
    assert.equal(fp.retryCount, 0);
  });
});

test("an unchanged file with an unsynced trailing tail stays idle (no flap)", async () => {
  await withStore(async (store) => {
    await store.observe(observeInput({ size: 500 }));
    // Synced only through the last complete newline (480 < size 500) but caught
    // up — the tail is a partial line the executor defers.
    await store.recordUploaded({
      externalSessionId: "sess-1",
      fileKey: "main",
      syncedByteOffset: 480,
      syncedSha256: "sha-480",
      storedEtag: "etag-1",
      syncedComputeTargetId: "ct-1",
      caughtUp: true,
      now: T0,
    });
    // Re-observe the SAME file: must not re-queue despite syncedByteOffset < size.
    const fp = await store.observe(observeInput({ size: 500 }));
    assert.equal(fp.status, "idle");
  });
});

test("requeueStale revives a crash-stranded uploading row", async () => {
  await withStore(async (store) => {
    await store.observe(observeInput());
    await store.markUploading("sess-1", "main", T0);
    assert.equal((await store.get("sess-1", "main"))?.status, "uploading");
    assert.equal(await store.requeueStale(T0), 1);
    assert.equal((await store.get("sess-1", "main"))?.status, "queued");
  });
});

test("growth observed while uploading is not lost after the upload settles", async () => {
  await withStore(async (store) => {
    await store.observe(observeInput({ size: 500 }));
    await store.markUploading("sess-1", "main", T0);
    // File grows to 900 mid-upload. This observation must NOT advance the
    // recorded size while `uploading`, or the growth signal is erased.
    await store.observe(observeInput({ mtimeMs: 2000, size: 900 }));
    // The in-flight [0,500] window completes and settles the row to idle.
    await store.recordUploaded({
      externalSessionId: "sess-1",
      fileKey: "main",
      syncedByteOffset: 500,
      syncedSha256: "sha-500",
      storedEtag: "etag-1",
      syncedComputeTargetId: "ct-1",
      caughtUp: true,
      now: T0,
    });
    // The next observation of the now-idle 900-byte file must re-queue the
    // 500->900 delta (the appended lines are not lost).
    const fp = await store.observe(observeInput({ mtimeMs: 2000, size: 900 }));
    assert.equal(fp.status, "queued");
  });
});

test("a compute-target switch re-queues a caught-up file", async () => {
  await withStore(async (store) => {
    await store.observe(observeInput());
    await store.recordUploaded({
      externalSessionId: "sess-1",
      fileKey: "main",
      syncedByteOffset: 500,
      syncedSha256: "sha-500",
      storedEtag: "etag-1",
      syncedComputeTargetId: "ct-1",
      caughtUp: true,
      now: T0,
    });
    // Same target -> nothing to do, stays idle.
    let fp = await store.observe(
      observeInput({ currentComputeTargetId: "ct-1" })
    );
    assert.equal(fp.status, "idle");
    // Different target -> re-queue: the cached cursor points at the old target's
    // S3 object, so the file must re-upload to the new one.
    fp = await store.observe(observeInput({ currentComputeTargetId: "ct-2" }));
    assert.equal(fp.status, "queued");
  });
});

test("recordFailure schedules a retry; dead marks the row dead", async () => {
  await withStore(async (store) => {
    await store.observe(observeInput());
    await store.recordFailure({
      externalSessionId: "sess-1",
      fileKey: "main",
      retryCount: 1,
      dead: false,
      nextAttemptAt: "2026-07-09T00:05:00.000Z",
      lastError: "boom",
      now: T0,
    });
    let fp = await store.get("sess-1", "main");
    assert.equal(fp?.status, "failed");
    assert.equal(fp?.retryCount, 1);
    assert.equal(fp?.lastError, "boom");

    await store.recordFailure({
      externalSessionId: "sess-1",
      fileKey: "main",
      retryCount: 5,
      dead: true,
      nextAttemptAt: null,
      lastError: "still boom",
      now: T0,
    });
    fp = await store.get("sess-1", "main");
    assert.equal(fp?.status, "dead");
  });
});

test("a dead file stays dead until it changes, then revives", async () => {
  await withStore(async (store) => {
    await store.observe(observeInput());
    await store.recordFailure({
      externalSessionId: "sess-1",
      fileKey: "main",
      retryCount: 5,
      dead: true,
      nextAttemptAt: null,
      lastError: "dead",
      now: T0,
    });
    // Same fingerprint -> stays dead (no retry storm).
    let fp = await store.observe(observeInput());
    assert.equal(fp.status, "dead");
    // A changed file -> revived, backoff reset.
    fp = await store.observe(observeInput({ mtimeMs: 9999, size: 800 }));
    assert.equal(fp.status, "queued");
    assert.equal(fp.retryCount, 0);
  });
});

test("listReady drains live before backfill and skips future retries", async () => {
  await withStore(async (store) => {
    await store.observe(
      observeInput({
        externalSessionId: "b",
        fileKey: "main",
        syncClass: "backfill",
      })
    );
    await store.observe(
      observeInput({
        externalSessionId: "a",
        fileKey: "main",
        syncClass: "live",
      })
    );
    // A failed row with a FUTURE nextAttemptAt must be excluded now.
    await store.observe(
      observeInput({
        externalSessionId: "c",
        fileKey: "main",
        syncClass: "live",
      })
    );
    await store.recordFailure({
      externalSessionId: "c",
      fileKey: "main",
      retryCount: 1,
      dead: false,
      nextAttemptAt: "2026-07-09T01:00:00.000Z",
      lastError: "later",
      now: T0,
    });

    const ready = await store.listReady("2026-07-09T00:10:00.000Z", 10);
    const ids = ready.map((r) => r.externalSessionId);
    assert.deepEqual(ids, ["a", "b"]); // live first, future-retry 'c' excluded
  });
});

test("markIdle settles a row with no actionable work", async () => {
  await withStore(async (store) => {
    await store.observe(observeInput());
    await store.markIdle("sess-1", "main", T0);
    const fp = await store.get("sess-1", "main");
    assert.equal(fp?.status, "idle");
  });
});
