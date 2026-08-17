/**
 * @file transcript-drain-batch.test.ts
 * @description ISS-4723 PR2 — the drain batches a whole `drainOnce`'s TERMINAL
 * settle writes into ONE `prisma.write` (one queued write-queue entry, so one
 * checkpoint-eligible write) via `recordBatchSettled`, while `markUploading`
 * stays a SEPARATE per-file write (the FEA-2827 growth-signal guard). Runs
 * against the real libSQL store through the production write queue (wrapped with
 * a `runs` counter) so the write-count and the observable row transitions are
 * both asserted — no logs, no wall-clock timing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { TranscriptUploadStatus } from "@repo/api/src/types/desktop-transcripts";
import type { TranscriptSettle } from "../src/main/database/transcript-sync-settle.js";
import {
  createTranscriptSyncStore,
  type TranscriptObserveInput,
  type TranscriptSyncStore,
} from "../src/main/database/transcript-sync-store.js";
import { TranscriptDrainQueue } from "../src/main/transcript-sync/transcript-drain-queue.js";
import {
  type TranscriptSyncExecutor,
  type TranscriptSyncFileOptions,
  type TranscriptSyncResult,
  TranscriptSyncRevokedError,
} from "../src/main/transcript-sync/transcript-sync-executor.js";
import type { TranscriptFingerprint } from "../src/main/transcript-sync/transcript-sync-types.js";
import { makeRecordingQueue, openTestPrisma } from "./prisma-test-utils.js";

const NOW = "2026-07-09T00:00:00.000Z";
const COMPUTE_TARGET = "ct-1";
/** The crash-safety test's simulated batch-flush failure message. */
const CRASH_BEFORE_FLUSH = /crash before flush/;
/** The mid-batch sibling test's simulated drain-queue write failure message. */
const REQUEUE_REVOKED_WRITE_FAILED = /requeueRevoked write failed/;

function observeInput(
  externalSessionId: string,
  overrides: Partial<TranscriptObserveInput> = {}
): TranscriptObserveInput {
  return {
    externalSessionId,
    fileKey: "main",
    sourceHarness: "claude",
    sourcePath: `/home/.claude/projects/p/${externalSessionId}.jsonl`,
    sourcePathHash: `hash-${externalSessionId}`,
    mtimeMs: 1000,
    size: 500,
    syncClass: "live",
    now: NOW,
    ...overrides,
  };
}

/**
 * A fake executor that, on `syncFile`, marks the row `uploading` per-file (the
 * real FEA-2827 claim write) and then routes its TERMINAL settle through the
 * batch collector when one is supplied — mirroring the production executor's
 * uploaded/idle settle without touching disk or the network. When
 * `settleCollector` is absent it settles immediately through the store (the
 * direct/force-archive behavior).
 */
function batchingFakeExecutor(
  store: TranscriptSyncStore,
  makeSettle: (fp: TranscriptFingerprint) => TranscriptSettle,
  result: TranscriptSyncResult
): TranscriptSyncExecutor {
  return {
    async syncFile(
      fp: TranscriptFingerprint,
      options?: TranscriptSyncFileOptions
    ): Promise<TranscriptSyncResult> {
      // The claim is a separate per-file write, exactly as production does it
      // before any stat/redaction work — this is the growth-signal guard that
      // must NOT be coalesced.
      await store.markUploading(fp.externalSessionId, fp.fileKey, NOW);
      const settle = makeSettle(fp);
      if (options?.settleCollector) {
        options.settleCollector(settle);
      } else {
        // No collector: settle immediately (direct caller / force-archive).
        await applyImmediateSettle(store, settle);
      }
      return result;
    },
    notifyPermanentSkip: () =>
      Promise.resolve({
        acked: true as const,
        status: TranscriptUploadStatus.Skipped,
      }),
  };
}

function applyImmediateSettle(
  store: TranscriptSyncStore,
  settle: TranscriptSettle
): Promise<void> {
  if (settle.kind === "uploaded") {
    return store.recordUploaded(settle);
  }
  if (settle.kind === "idle") {
    return store.markIdle(settle.externalSessionId, settle.fileKey, settle.now);
  }
  return Promise.resolve();
}

function makeDrainQueue(
  store: TranscriptSyncStore,
  executor: TranscriptSyncExecutor,
  concurrency: number
): TranscriptDrainQueue {
  return new TranscriptDrainQueue({
    shouldRun: () => true,
    resolveRuntime: () => ({ store, executor }),
    getComputeTargetId: () => COMPUTE_TARGET,
    now: () => NOW,
    log: () => undefined,
    concurrency,
  });
}

function uploadedSettle(fp: TranscriptFingerprint): TranscriptSettle {
  return {
    kind: "uploaded",
    externalSessionId: fp.externalSessionId,
    fileKey: fp.fileKey,
    syncedByteOffset: 500,
    syncedSha256: "sha-500",
    storedEtag: "etag-1",
    syncedComputeTargetId: COMPUTE_TARGET,
    caughtUp: true,
    now: NOW,
  };
}

test("ISS-4723: a drain batch coalesces every SETTLE into ONE write while markUploading stays per-file", async () => {
  const queue = makeRecordingQueue();
  const { prisma, close } = await openTestPrisma(queue);
  try {
    const store = createTranscriptSyncStore(prisma);
    const fileCount = 5;
    for (let i = 0; i < fileCount; i += 1) {
      await store.observe(observeInput(`sess-${i}`));
    }

    const executor = batchingFakeExecutor(store, uploadedSettle, {
      kind: "uploaded",
      caughtUp: true,
    });
    // Concurrency >= fileCount so a single drainOnce processes the whole batch.
    const drain = makeDrainQueue(store, executor, fileCount);

    // Reset the counter AFTER seeding so it counts only the drain's writes.
    const writesBeforeDrain = queue.runs;
    await drain.drainOnce();
    const drainWrites = queue.runs - writesBeforeDrain;

    // The drain wrote exactly one `markUploading` per file (the growth-signal
    // guard) PLUS exactly ONE coalesced `recordBatchSettled` for all settles.
    assert.equal(
      drainWrites,
      fileCount + 1,
      "markUploading is per-file (fileCount writes) and all settles coalesce into one batch write"
    );

    // Every row reached the terminal uploaded/idle state (caughtUp === true).
    for (let i = 0; i < fileCount; i += 1) {
      const fp = await store.get(`sess-${i}`, "main");
      assert.equal(fp?.status, "idle", `sess-${i} settled to idle`);
      assert.equal(fp?.syncedByteOffset, 500);
      assert.equal(fp?.syncedComputeTargetId, COMPUTE_TARGET);
    }
  } finally {
    await close();
  }
});

test("ISS-4723/ISS-4849 crash-safety: a settle lost before the batch flush never fakes `idle`, and is re-armed (in-process, then by requeueStale)", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    const store = createTranscriptSyncStore(prisma);
    await store.observe(observeInput("sess-crash"));

    // Model a crash BETWEEN the per-file claim and the batched settle flush: the
    // real store claims the row `uploading` (the FEA-2827 write that always
    // lands per-file), the executor hands its settle to the collector, but the
    // process dies before `recordBatchSettled` persists it. A store wrapper that
    // throws from `recordBatchSettled` reproduces "the flush never landed".
    const crashingStore: TranscriptSyncStore = {
      ...store,
      recordBatchSettled: () => Promise.reject(new Error("crash before flush")),
    };
    const executor = batchingFakeExecutor(crashingStore, uploadedSettle, {
      kind: "uploaded",
      caughtUp: true,
    });
    const drain = makeDrainQueue(crashingStore, executor, 4);

    // The drain claims the row, collects the settle, then the flush throws — the
    // settle never persists. drainOnce rejects.
    await assert.rejects(
      () => drain.drainOnce(),
      CRASH_BEFORE_FLUSH,
      "the batch flush failure surfaces (models the crash)"
    );

    // The invariant this test has always owned: a settle that never landed must
    // NOT leave the row looking settled. A false `idle` would tell the cloud the
    // transcript is archived when it is not.
    const afterFlushFailure = await store.get("sess-crash", "main");
    assert.notEqual(
      afterFlushFailure?.status,
      "idle",
      "the dropped settle never produces a false idle"
    );

    // ISS-4849 CHANGED what happens next. It used to stay `uploading` — a status
    // `listReady` excludes — until the next app launch ran `requeueStale`, so a
    // transient flush failure stranded the row for a whole session. The drain now
    // re-arms it in-process, bounded, so the very next tick retries it.
    assert.equal(
      afterFlushFailure?.status,
      "queued",
      "ISS-4849: the drain re-queues the unsettled row in-process, not at next boot"
    );

    // Boot recovery is still the backstop for rows past the in-process cap (see
    // transcript-drain-flush-recovery.test.ts): requeueStale re-arms every
    // `uploading` row so the next drain re-plans it from the server-authoritative
    // cursor. Nothing is left behind either way.
    await store.markUploading("sess-crash", "main", NOW);
    const revived = await store.requeueStale(NOW);
    assert.equal(revived, 1);
    const recovered = await store.get("sess-crash", "main");
    assert.equal(
      recovered?.status,
      "queued",
      "requeueStale still revives a stranded uploading row to queued"
    );
  } finally {
    await close();
  }
});

/** Resolve on the next macrotask so a "slow" worker settles after a fast peer. */
function nextTick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

test("ISS-4723: a sibling worker's terminal settle is NOT lost when another worker's own write rejects mid-batch", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    const store = createTranscriptSyncStore(prisma);
    // sess-revoked's OWN drain-queue write rejects; sess-slow is a slower sibling
    // still uploading when that rejection lands. With `Promise.all`, the aggregate
    // would reject before sess-slow collected its settle and the flush would run
    // without it — stranding sess-slow `uploading`. `allSettled` waits for every
    // worker, so sess-slow's settle is always in the batch that flushes.
    await store.observe(observeInput("sess-revoked"));
    await store.observe(observeInput("sess-slow"));

    // A store wrapper whose `requeueRevoked` REJECTS — this is the drain-queue's
    // own `catch`-path write failing (the bot's exact trigger). It surfaces out
    // of `processFile`, rejecting that worker's promise.
    const rejectingStore: TranscriptSyncStore = {
      ...store,
      requeueRevoked: () =>
        Promise.reject(new Error("requeueRevoked write failed")),
    };

    const executor: TranscriptSyncExecutor = {
      async syncFile(
        fp: TranscriptFingerprint,
        options?: TranscriptSyncFileOptions
      ): Promise<TranscriptSyncResult> {
        await store.markUploading(fp.externalSessionId, fp.fileKey, NOW);
        if (fp.externalSessionId === "sess-revoked") {
          // Reject fast so `Promise.all` would short-circuit first.
          throw new TranscriptSyncRevokedError();
        }
        // The slow sibling hands its settle to the collector only AFTER a tick,
        // i.e. after the fast worker has already rejected.
        await nextTick();
        options?.settleCollector?.(uploadedSettle(fp));
        return { kind: "uploaded", caughtUp: true };
      },
      notifyPermanentSkip: () =>
        Promise.resolve({
          acked: true as const,
          status: TranscriptUploadStatus.Skipped,
        }),
    };
    const drain = makeDrainQueue(rejectingStore, executor, 4);

    // The drain still surfaces the failing worker's rejection...
    await assert.rejects(
      () => drain.drainOnce(),
      REQUEUE_REVOKED_WRITE_FAILED,
      "the failing worker's write rejection is propagated after the flush"
    );

    // ...but the slow sibling's settle DID land — its row is terminal, not
    // stranded `uploading`.
    const sibling = await store.get("sess-slow", "main");
    assert.equal(
      sibling?.status,
      "idle",
      "the slower sibling settled to idle despite the peer worker's rejection"
    );
    assert.equal(sibling?.syncedByteOffset, 500);
  } finally {
    await close();
  }
});

test("ISS-4723: recordBatchSettled applies every terminal settle kind in one write and no-ops an empty batch", async () => {
  const queue = makeRecordingQueue();
  const { prisma, close } = await openTestPrisma(queue);
  try {
    const store = createTranscriptSyncStore(prisma);
    for (const id of ["up", "idle", "dead", "fail"]) {
      await store.observe(observeInput(id));
    }

    // An empty batch does no write.
    const before = queue.runs;
    await store.recordBatchSettled([]);
    assert.equal(queue.runs, before, "empty batch does no write");

    const settles: TranscriptSettle[] = [
      {
        kind: "uploaded",
        externalSessionId: "up",
        fileKey: "main",
        syncedByteOffset: 500,
        syncedSha256: "sha",
        storedEtag: "etag",
        syncedComputeTargetId: COMPUTE_TARGET,
        caughtUp: true,
        now: NOW,
      },
      { kind: "idle", externalSessionId: "idle", fileKey: "main", now: NOW },
      {
        kind: "dead",
        externalSessionId: "dead",
        fileKey: "main",
        reason: "skipped: terminal",
        now: NOW,
      },
      {
        kind: "failure",
        externalSessionId: "fail",
        fileKey: "main",
        retryCount: 2,
        missingSourceCount: 0,
        dead: false,
        nextAttemptAt: "2026-07-09T00:05:00.000Z",
        lastError: "boom",
        now: NOW,
      },
    ];
    const writesBefore = queue.runs;
    await store.recordBatchSettled(settles);
    assert.equal(
      queue.runs - writesBefore,
      1,
      "the whole mixed-kind batch is ONE write"
    );

    const up = await store.get("up", "main");
    assert.equal(up?.status, "idle");
    assert.equal(up?.syncedByteOffset, 500);
    const idle = await store.get("idle", "main");
    assert.equal(idle?.status, "idle");
    const dead = await store.get("dead", "main");
    assert.equal(dead?.status, "dead");
    assert.equal(dead?.lastError, "skipped: terminal");
    const fail = await store.get("fail", "main");
    assert.equal(fail?.status, "failed");
    assert.equal(fail?.retryCount, 2);
    assert.equal(fail?.nextAttemptAt, "2026-07-09T00:05:00.000Z");
  } finally {
    await close();
  }
});

// wongk (#4253): the automatic drain persists the cloud acknowledgement through
// `recordBatchSettled`, not through `markCloudUploaded` — so the batch path
// needs its own real-store proof, or a builder that dropped the ack from the
// batched `data` would still pass every direct-call and fake-store test.
test("ISS-4815: a cloudUploaded settle persists its acknowledgement through the BATCH flush", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    const store = createTranscriptSyncStore(prisma);
    await store.observe(observeInput("ack"));
    await store.recordFailure({
      externalSessionId: "ack",
      fileKey: "main",
      retryCount: 2,
      missingSourceCount: 2,
      dead: false,
      nextAttemptAt: NOW,
      lastError: "local transcript source missing",
      now: NOW,
    });

    await store.recordBatchSettled([
      {
        kind: "cloudUploaded",
        externalSessionId: "ack",
        fileKey: "main",
        now: NOW,
        computeTargetId: COMPUTE_TARGET,
      },
    ]);

    const row = await store.get("ack", "main");
    assert.equal(row?.status, "idle");
    // The successful settle retires the failure ladder here too.
    assert.equal(row?.retryCount, 0);
    assert.equal(row?.lastError, null);
    const [blobState] = await store.listMainBlobStates(["ack"]);
    assert.equal(blobState?.cloudUploadedAt, NOW);
    assert.equal(blobState?.cloudUploadedComputeTargetId, COMPUTE_TARGET);
    // And the acknowledgement is what keeps the row out of the stranded sweep.
    assert.equal(
      await store.requeueStrandedMissingBlobs({
        now: NOW,
        computeTargetId: COMPUTE_TARGET,
      }),
      0
    );
  } finally {
    await close();
  }
});

test("ISS-4723: a settle for a vanished row is a no-op and does NOT abort later settles in the same batch", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    const store = createTranscriptSyncStore(prisma);
    // Only `after` exists; `gone` was never observed (models a row pruned
    // between claim and flush). `update` would throw P2025 on `gone` and, since
    // the statements autocommit in order, skip `after` entirely. `updateMany` is
    // zero-row-safe, so `gone` is a 0-count no-op and `after` still lands.
    await store.observe(observeInput("after"));
    const settles: TranscriptSettle[] = [
      { kind: "idle", externalSessionId: "gone", fileKey: "main", now: NOW },
      {
        kind: "uploaded",
        externalSessionId: "after",
        fileKey: "main",
        syncedByteOffset: 500,
        syncedSha256: "sha",
        storedEtag: "etag",
        syncedComputeTargetId: COMPUTE_TARGET,
        caughtUp: true,
        now: NOW,
      },
    ];

    await store.recordBatchSettled(settles);

    const after = await store.get("after", "main");
    assert.equal(
      after?.status,
      "idle",
      "the settle after the vanished row still applied — no P2025 abort"
    );
    assert.equal(after?.syncedByteOffset, 500);
    const gone = await store.get("gone", "main");
    assert.equal(gone, null, "the vanished row stays absent (no-op)");
  } finally {
    await close();
  }
});
