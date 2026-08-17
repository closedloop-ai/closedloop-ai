/**
 * @file transcript-drain-flush-recovery.test.ts
 * @description ISS-4849 — the two follow-ups deferred from ISS-4723 PR2 (#4210).
 *
 * 1. IN-PROCESS recovery for a failed batch flush. When the coalesced
 *    `recordBatchSettled` rejects, every file in that batch is left `uploading`
 *    — a status `listReady` excludes — and the only thing that re-armed them
 *    (`requeueStale`) is boot-only. A transient blip therefore stranded a whole
 *    batch of already-uploaded transcripts until the operator restarted the app.
 * 2. REAL-executor batch coverage. The ISS-4723 tests drove a fake executor that
 *    hand-invoked `settleCollector`; nothing exercised `makeSettleSink` or a
 *    production terminal branch, so a branch that wrote inline (or forgot to
 *    collect its settle) would not have been caught.
 *
 * Runs against the real libSQL store through the production write queue, so the
 * assertions are observable row transitions — not logs, not timing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TranscriptSettle } from "../src/main/database/transcript-sync-settle.js";
import {
  createTranscriptSyncStore,
  type TranscriptObserveInput,
  type TranscriptSyncStore,
} from "../src/main/database/transcript-sync-store.js";
import { TranscriptDrainQueue } from "../src/main/transcript-sync/transcript-drain-queue.js";
import {
  createTranscriptSyncExecutor,
  type TranscriptSyncExecutor,
  type TranscriptSyncFileOptions,
  type TranscriptSyncResult,
} from "../src/main/transcript-sync/transcript-sync-executor.js";
import {
  redactedArchiveCursorTargetId,
  type TranscriptFingerprint,
} from "../src/main/transcript-sync/transcript-sync-types.js";
import { TranscriptSyncStatus } from "../src/shared/transcript-sync-status-contract.js";
import {
  fakeFsDeps,
  recordingClient,
} from "./helpers/transcript-sync-executor-fixtures.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const NOW = "2026-07-09T00:00:00.000Z";
const COMPUTE_TARGET = "ct-1";
/** The simulated batch-flush failure this suite drives. */
const FLUSH_FAILED = /flush failed/;
/** Matches the drain-queue's `MAX_FLUSH_RECOVERY_ATTEMPTS`. */
const MAX_FLUSH_RECOVERY_ATTEMPTS = 3;

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

function makeDrainQueue(
  store: TranscriptSyncStore,
  executor: TranscriptSyncExecutor,
  concurrency: number,
  log: (message: string) => void = () => undefined
): TranscriptDrainQueue {
  return new TranscriptDrainQueue({
    shouldRun: () => true,
    resolveRuntime: () => ({ store, executor }),
    getComputeTargetId: () => COMPUTE_TARGET,
    now: () => NOW,
    log,
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

/** Claims the row per-file (as production does) then hands its settle to the batch. */
function batchingFakeExecutor(
  store: TranscriptSyncStore,
  makeSettle: (fp: TranscriptFingerprint) => TranscriptSettle
): TranscriptSyncExecutor {
  return {
    async syncFile(
      fp: TranscriptFingerprint,
      options?: TranscriptSyncFileOptions
    ): Promise<TranscriptSyncResult> {
      await store.markUploading(fp.externalSessionId, fp.fileKey, NOW);
      options?.settleCollector?.(makeSettle(fp));
      return { kind: "uploaded", caughtUp: true };
    },
    notifyPermanentSkip: () => Promise.resolve({ acked: false as const }),
  };
}

test("ISS-4849: a REJECTED batch flush re-queues the stranded rows in-process (not left for the next boot)", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    const store = createTranscriptSyncStore(prisma);
    const fileCount = 3;
    for (let index = 0; index < fileCount; index += 1) {
      await store.observe(observeInput(`sess-${index}`));
    }

    const flushFailingStore: TranscriptSyncStore = {
      ...store,
      recordBatchSettled: () => Promise.reject(new Error("flush failed")),
    };
    const drain = makeDrainQueue(
      flushFailingStore,
      batchingFakeExecutor(flushFailingStore, uploadedSettle),
      fileCount
    );

    // The flush failure is still surfaced — recovery must not swallow it.
    await assert.rejects(() => drain.drainOnce(), FLUSH_FAILED);

    for (let index = 0; index < fileCount; index += 1) {
      const row = await store.get(`sess-${index}`, "main");
      assert.equal(
        row?.status,
        TranscriptSyncStatus.Queued,
        `sess-${index} was re-armed in-process instead of stranded uploading`
      );
    }
  } finally {
    await close();
  }
});

test("ISS-4849: recovery revives ONLY rows still uploading — a settle that landed is not resurrected", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    const store = createTranscriptSyncStore(prisma);
    await store.observe(observeInput("sess-applied"));
    await store.observe(observeInput("sess-stranded"));

    // Model a PARTIALLY applied flush: `recordBatchSettled` autocommits per
    // statement, so a rejection mid-loop can leave earlier settles written.
    const partialFlushStore: TranscriptSyncStore = {
      ...store,
      recordBatchSettled: async (settles: TranscriptSettle[]) => {
        const applied = settles.filter(
          (settle) => settle.externalSessionId === "sess-applied"
        );
        await store.recordBatchSettled(applied);
        throw new Error("flush failed");
      },
    };
    const drain = makeDrainQueue(
      partialFlushStore,
      batchingFakeExecutor(partialFlushStore, uploadedSettle),
      2
    );

    await assert.rejects(() => drain.drainOnce(), FLUSH_FAILED);

    const applied = await store.get("sess-applied", "main");
    assert.equal(
      applied?.status,
      TranscriptSyncStatus.Idle,
      "the settle that DID land stays terminal — recovery must not resurrect it"
    );
    assert.equal(
      applied?.syncedByteOffset,
      500,
      "its recorded cursor survives the recovery pass"
    );

    const stranded = await store.get("sess-stranded", "main");
    assert.equal(
      stranded?.status,
      TranscriptSyncStatus.Queued,
      "only the row that genuinely lost its settle is re-armed"
    );
  } finally {
    await close();
  }
});

test("ISS-4849: in-process recovery is BOUNDED — a persistently failing flush stops re-arming", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    const store = createTranscriptSyncStore(prisma);
    await store.observe(observeInput("sess-0"));

    const logs: string[] = [];
    const flushFailingStore: TranscriptSyncStore = {
      ...store,
      recordBatchSettled: () => Promise.reject(new Error("flush failed")),
    };
    const drain = makeDrainQueue(
      flushFailingStore,
      batchingFakeExecutor(flushFailingStore, uploadedSettle),
      1,
      (message) => logs.push(message)
    );

    // Each attempt re-queues the row, so the next drain re-picks it.
    for (let attempt = 0; attempt < MAX_FLUSH_RECOVERY_ATTEMPTS; attempt += 1) {
      await assert.rejects(() => drain.drainOnce(), FLUSH_FAILED);
    }
    assert.equal(
      logs.filter((line) => line.includes("re-queued")).length,
      MAX_FLUSH_RECOVERY_ATTEMPTS,
      "recovery runs up to the cap"
    );

    // One past the cap: the drain gives up rather than spinning re-queue/re-drain.
    await assert.rejects(() => drain.drainOnce(), FLUSH_FAILED);
    assert.equal(
      logs.filter((line) => line.includes("re-queued")).length,
      MAX_FLUSH_RECOVERY_ATTEMPTS,
      "no further in-process re-arm past the cap"
    );
    assert.ok(
      logs.some((line) => line.includes("leaving")),
      "the drain says it is deferring to boot recovery"
    );
    const row = await store.get("sess-0", "main");
    assert.equal(
      row?.status,
      TranscriptSyncStatus.Uploading,
      "past the cap the row is left uploading — exactly what requeueStale expects on boot"
    );
  } finally {
    await close();
  }
});

test("ISS-4849: a flush that LANDS resets the recovery budget (a transient blip never exhausts it)", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    const store = createTranscriptSyncStore(prisma);
    await store.observe(observeInput("sess-0"));

    const logs: string[] = [];
    let failNextFlush = true;
    const flakyStore: TranscriptSyncStore = {
      ...store,
      recordBatchSettled: (settles: TranscriptSettle[]) => {
        if (failNextFlush) {
          return Promise.reject(new Error("flush failed"));
        }
        return store.recordBatchSettled(settles);
      },
    };
    const drain = makeDrainQueue(
      flakyStore,
      batchingFakeExecutor(flakyStore, uploadedSettle),
      1,
      (message) => logs.push(message)
    );

    // Fail, recover, succeed — the successful flush clears the counter.
    await assert.rejects(() => drain.drainOnce(), FLUSH_FAILED);
    failNextFlush = false;
    await drain.drainOnce();
    assert.equal((await store.get("sess-0", "main"))?.status, "idle");

    // A LATER blip still gets the full budget rather than the residue of the first.
    await store.observe(observeInput("sess-1"));
    failNextFlush = true;
    for (let attempt = 0; attempt < MAX_FLUSH_RECOVERY_ATTEMPTS; attempt += 1) {
      await assert.rejects(() => drain.drainOnce(), FLUSH_FAILED);
    }
    assert.equal(
      logs.filter((line) => line.includes("re-queued")).length,
      MAX_FLUSH_RECOVERY_ATTEMPTS + 1,
      "the budget was reset by the successful flush, not carried over"
    );
  } finally {
    await close();
  }
});

test("ISS-4849: a batch driven through the REAL executor collects its settle instead of writing inline", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    const store = createTranscriptSyncStore(prisma);
    const bytes = Buffer.from(`${JSON.stringify({ line: 1 })}\n`, "utf8");
    await store.observe(
      observeInput("sess-live", { size: bytes.byteLength, mtimeMs: 1000 })
    );

    // A real `createTranscriptSyncExecutor`, so `makeSettleSink` and the
    // production uploaded/complete terminal branch are what run here.
    const client = recordingClient(
      {
        mode: "fullPut",
        url: "https://example.invalid/put",
        planEndOffset: bytes.byteLength,
        syncedByteOffset: 0,
        storedEtag: null,
      },
      bytes.byteLength
    );
    const executor = createTranscriptSyncExecutor({
      store,
      client,
      getComputeTargetId: () => COMPUTE_TARGET,
      now: () => NOW,
      ...fakeFsDeps(bytes),
    });

    const settles: TranscriptSettle[] = [];
    const recordingStore: TranscriptSyncStore = {
      ...store,
      recordBatchSettled: (batch: TranscriptSettle[]) => {
        settles.push(...batch);
        return store.recordBatchSettled(batch);
      },
    };
    const drain = makeDrainQueue(recordingStore, executor, 1);

    await drain.drainOnce();

    // The terminal settle went through the COLLECTOR, not an inline store write.
    assert.equal(
      settles.length,
      1,
      "the real executor's terminal branch collected exactly one settle for the batch"
    );
    assert.equal(settles[0].kind, "uploaded");
    const row = await store.get("sess-live", "main");
    assert.equal(
      row?.status,
      TranscriptSyncStatus.Idle,
      "and the batch flush applied it, settling the row terminal"
    );
    assert.equal(row?.syncedByteOffset, bytes.byteLength);
    // The real executor stamps the REDACTED-archive cursor identity, which a
    // hand-rolled fake settle would have gotten wrong — the point of driving
    // the production terminal branch end-to-end.
    assert.equal(
      row?.syncedComputeTargetId,
      redactedArchiveCursorTargetId(COMPUTE_TARGET)
    );
  } finally {
    await close();
  }
});

test("ISS-4849 (wongk review): an EMPTY overlapping flush does NOT reset the recovery budget", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    const store = createTranscriptSyncStore(prisma);
    await store.observe(observeInput("sess-0"));

    const logs: string[] = [];
    let emptyTick = false;
    const flakyStore: TranscriptSyncStore = {
      ...store,
      // Only a flush that actually CARRIES settles fails. An empty batch is the
      // no-op success production sees on an overlapping tick — and a no-op is no
      // evidence the settle path recovered.
      recordBatchSettled: (settles: TranscriptSettle[]) =>
        settles.length > 0
          ? Promise.reject(new Error("flush failed"))
          : store.recordBatchSettled(settles),
      listReady: (now: string, limit: number) =>
        emptyTick ? Promise.resolve([]) : store.listReady(now, limit),
    };
    const drain = makeDrainQueue(
      flakyStore,
      batchingFakeExecutor(flakyStore, uploadedSettle),
      1,
      (message) => logs.push(message)
    );

    // Attempt 1 fails and re-queues the stranded row in-process.
    await assert.rejects(() => drain.drainOnce(), FLUSH_FAILED);

    // A concurrent tick that finds nothing ready still reaches
    // `recordBatchSettled([])`. Reading that as "healthy again" would put the
    // NEXT real flush back at attempt 1 and let a persistent settle failure
    // re-queue forever instead of handing off to boot recovery.
    emptyTick = true;
    await drain.drainOnce();
    emptyTick = false;

    // The ladder must CONTINUE from attempt 2, so the budget is spent after
    // MAX_FLUSH_RECOVERY_ATTEMPTS real flushes in total — not 1 + MAX.
    for (let attempt = 1; attempt < MAX_FLUSH_RECOVERY_ATTEMPTS; attempt += 1) {
      await assert.rejects(() => drain.drainOnce(), FLUSH_FAILED);
    }
    await assert.rejects(() => drain.drainOnce(), FLUSH_FAILED);

    assert.equal(
      logs.filter((line) => line.includes("re-queued")).length,
      MAX_FLUSH_RECOVERY_ATTEMPTS,
      "the empty flush must not restart the ladder"
    );
    assert.ok(
      logs.some((line) => line.includes("for boot recovery")),
      "and the exhausted ladder hands off to boot recovery rather than looping"
    );
    assert.equal(
      (await store.get("sess-0", "main"))?.status,
      TranscriptSyncStatus.Uploading,
      "past the cap the row is left uploading — what requeueStale expects on boot"
    );
  } finally {
    await close();
  }
});
