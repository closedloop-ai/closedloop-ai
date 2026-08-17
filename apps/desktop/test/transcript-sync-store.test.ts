/**
 * @file transcript-sync-store.test.ts
 * @description FEA-2715 fingerprint/upload-cursor store against a real libSQL
 * database (the production migration runner). Covers observe/change-detection,
 * enqueue vs stay-idle, upload/failure cursor transitions, dead-letter
 * revival-on-change, listRecent/listReady ordering, and the terminal
 * markIdle/markDead/recordFailure transitions.
 *
 * ISS-4815: the RECOVERY cluster (requeueStale / requeueStrandedMissingBlobs /
 * requeueRevoked / reviveForForcedSync / redriveDeadLettered — every mutation
 * that re-arms or revives a settled row) lives in the sibling
 * `transcript-sync-store-recovery.test.ts`, so neither suite grows past the
 * file-size ceiling. Both share the harness in
 * `./helpers/transcript-sync-store-fixtures.js`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranscriptSyncStore } from "../src/main/database/transcript-sync-store.js";
import { redactedArchiveCursorTargetId } from "../src/main/transcript-sync/transcript-sync-types.js";
import {
  observeInput,
  T0,
  withStore,
} from "./helpers/transcript-sync-store-fixtures.js";
import { openTestPrisma } from "./prisma-test-utils.js";

test("ISS-4710: listReady drains on the reader pool while a writer transaction is held busy", async () => {
  // Root-cause regression: during a first-boot DATA_REVISION rebuild the single
  // writer connection is saturated with bulk `$transaction`s. `listReady` must
  // run on the READER pool (a committed WAL snapshot, concurrent with the writer)
  // so the transcript drain keeps discovering + uploading ready files instead of
  // stalling behind the busy writer. This holds a real `prisma.write`
  // transaction open and proves `listReady` still resolves with the queued row
  // BEFORE the held write is released.
  const { prisma, close } = await openTestPrisma();
  try {
    const store = createTranscriptSyncStore(prisma);
    await store.observe(observeInput({ syncClass: "live" }));

    // Model the rebuild: a writer `$transaction` that parks on a deferred, so the
    // single writer connection is occupied for the whole window.
    let releaseWrite!: () => void;
    const writeHeld = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    // @wongk: signal from INSIDE the transaction, AFTER it has opened and is
    // parked on `writeHeld` — so the test proves `listReady` resolves while the
    // writer is DEMONSTRABLY held, not merely before the write's own microtask
    // chain happened to start (which would pass trivially).
    let signalWriterHeld!: () => void;
    const writerHeld = new Promise<void>((resolve) => {
      signalWriterHeld = resolve;
    });
    let writeSettled = false;
    const busyWrite = prisma.write((client) =>
      client.$transaction(async (tx) => {
        await tx.$queryRawUnsafe("SELECT 1");
        signalWriterHeld();
        try {
          await writeHeld;
          writeSettled = true;
        } finally {
          // Belt-and-suspenders: even if the body above throws, mark settled so a
          // stuck writer can't be misread as still-held by a later assertion.
          writeSettled = true;
        }
      })
    );
    busyWrite.catch(() => undefined);

    try {
      // Wait until the writer transaction is provably open and parked.
      await writerHeld;

      // The reader-pool `listReady` must resolve WITHOUT the held write settling.
      const ready = await store.listReady(T0, 10);
      assert.equal(
        writeSettled,
        false,
        "listReady returned while the writer transaction was still held"
      );
      assert.equal(
        ready.length,
        1,
        "the queued row was discovered concurrently"
      );
      assert.equal(ready[0]?.externalSessionId, "sess-1");
    } finally {
      // Release the held writer even if an assertion above threw, so a failure
      // surfaces as the assertion — never a runner timeout on a wedged write.
      releaseWrite();
      await busyWrite;
    }
  } finally {
    await close();
  }
});

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

test("ISS-4647: listMainBlobStates returns the page's main rows only, narrowed and clone-safe", async () => {
  await withStore(async (store) => {
    await store.observe(observeInput());
    await store.observe(
      observeInput({ fileKey: "subagent:1", sourcePath: "/p/sub.jsonl" })
    );
    await store.observe(
      observeInput({ externalSessionId: "sess-2", sourcePath: "/p/s2.jsonl" })
    );
    await store.recordUploaded({
      externalSessionId: "sess-1",
      fileKey: "main",
      syncedByteOffset: 500,
      syncedSha256: "sha",
      storedEtag: "etag",
      syncedComputeTargetId: redactedArchiveCursorTargetId("target-1"),
      caughtUp: true,
      now: T0,
    });

    // Scoped to the requested identities (sess-2 is off-page) and to `main`
    // (the subagent row must not be mistaken for the session-level verdict).
    const states = await store.listMainBlobStates(["sess-1"]);

    assert.deepEqual(states, [
      {
        externalSessionId: "sess-1",
        status: "idle",
        syncedByteOffset: 500,
        syncedComputeTargetId: redactedArchiveCursorTargetId("target-1"),
        // ISS-4815: the durable cloud acknowledgement travels with the
        // projection so the Sessions disclosure and the stranded recovery read
        // the same fact. A plain `recordUploaded` clears it, hence null here.
        cloudUploadedAt: null,
        cloudUploadedComputeTargetId: null,
      },
    ]);
    assert.deepEqual(await store.listMainBlobStates([]), []);
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
    // Legacy raw-domain cursor for the same target -> re-queue so the stored
    // raw object is rewritten through the redaction lane.
    let fp = await store.observe(
      observeInput({ currentComputeTargetId: "ct-1" })
    );
    assert.equal(fp.status, "queued");

    await store.recordUploaded({
      externalSessionId: "sess-1",
      fileKey: "main",
      syncedByteOffset: 500,
      syncedSha256: "sha-500-redacted",
      storedEtag: "etag-2",
      syncedComputeTargetId: redactedArchiveCursorTargetId("ct-1"),
      caughtUp: true,
      now: T0,
    });
    // Redacted-domain cursor for the same target -> nothing to do, stays idle.
    fp = await store.observe(observeInput({ currentComputeTargetId: "ct-1" }));
    assert.equal(fp.status, "idle");

    // Different target -> re-queue: the cached cursor points at the old target's
    // S3 object, so the file must re-upload to the new one.
    fp = await store.observe(observeInput({ currentComputeTargetId: "ct-2" }));
    assert.equal(fp.status, "queued");
  });
});

test("a redacted-domain cursor marker does not look like a compute-target switch", async () => {
  await withStore(async (store) => {
    await store.observe(observeInput());
    await store.recordUploaded({
      externalSessionId: "sess-1",
      fileKey: "main",
      syncedByteOffset: 500,
      syncedSha256: "sha-500",
      storedEtag: "etag-1",
      syncedComputeTargetId: redactedArchiveCursorTargetId("ct-1"),
      caughtUp: true,
      now: T0,
    });

    const fp = await store.observe(
      observeInput({ currentComputeTargetId: "ct-1" })
    );

    assert.equal(fp.status, "idle");
    assert.equal(
      fp.syncedComputeTargetId,
      redactedArchiveCursorTargetId("ct-1")
    );
  });
});

test("recordFailure schedules a retry; dead marks the row dead", async () => {
  await withStore(async (store) => {
    await store.observe(observeInput());
    await store.recordFailure({
      externalSessionId: "sess-1",
      fileKey: "main",
      retryCount: 1,
      missingSourceCount: 2,
      dead: false,
      nextAttemptAt: "2026-07-09T00:05:00.000Z",
      lastError: "boom",
      now: T0,
    });
    let fp = await store.get("sess-1", "main");
    assert.equal(fp?.status, "failed");
    assert.equal(fp?.retryCount, 1);
    // FEA-3555: the isolated missing-source counter persists independently.
    assert.equal(fp?.missingSourceCount, 2);
    assert.equal(fp?.lastError, "boom");

    await store.recordFailure({
      externalSessionId: "sess-1",
      fileKey: "main",
      retryCount: 5,
      missingSourceCount: 0,
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
      missingSourceCount: 3,
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
    // FEA-3555: a reappeared/changed file restarts the missing-source run too.
    assert.equal(fp.missingSourceCount, 0);
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
      missingSourceCount: 0,
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

test("listReady pincer-interleaves oldest backfill so the tail never starves", async () => {
  await withStore(async (store) => {
    // Five backfill files with strictly increasing mtime: f0 (oldest) .. f4
    // (newest). Newest-first alone would always serve f4,f3,.. and starve f0.
    for (let i = 0; i < 5; i++) {
      await store.observe(
        observeInput({
          externalSessionId: `f${i}`,
          fileKey: "main",
          syncClass: "backfill",
          mtimeMs: 1000 + i,
        })
      );
    }

    const ready = await store.listReady("2026-07-09T00:10:00.000Z", 10);
    const ids = ready.map((r) => r.externalSessionId);
    // Pincer: newest (f4) in slot 0, oldest (f0) in slot 1, converging inward.
    assert.deepEqual(ids, ["f4", "f0", "f3", "f1", "f2"]);
    // With concurrency 2 the drain runs slots [0,1] = {newest, oldest} every
    // tick, so the oldest file is served immediately, not after all newer ones.
    assert.equal(ids[1], "f0");
  });
});

test("listReady keeps live ahead of the backfill pincer", async () => {
  await withStore(async (store) => {
    await store.observe(
      observeInput({
        externalSessionId: "old",
        syncClass: "backfill",
        mtimeMs: 1,
      })
    );
    await store.observe(
      observeInput({
        externalSessionId: "new",
        syncClass: "backfill",
        mtimeMs: 9,
      })
    );
    await store.observe(
      observeInput({ externalSessionId: "live", syncClass: "live", mtimeMs: 5 })
    );

    const ready = await store.listReady("2026-07-09T00:10:00.000Z", 10);
    // Live always drains first; backfill pincer (newest, oldest) follows.
    assert.deepEqual(
      ready.map((r) => r.externalSessionId),
      ["live", "new", "old"]
    );
  });
});

test("listRecent caps the read and returns newest files first (FEA-3385)", async () => {
  await withStore(async (store) => {
    // Five files with strictly increasing mtime: f0 (oldest) .. f4 (newest).
    for (let i = 0; i < 5; i++) {
      await store.observe(
        observeInput({
          externalSessionId: `f${i}`,
          fileKey: "main",
          syncClass: "backfill",
          mtimeMs: 1000 + i,
        })
      );
    }

    // The cap bounds the read regardless of how many rows exist.
    const capped = await store.listRecent(2);
    assert.deepEqual(
      capped.map((r) => r.externalSessionId),
      ["f4", "f3"]
    );

    // A limit wider than the row count returns all rows, newest-first.
    const all = await store.listRecent(100);
    assert.deepEqual(
      all.map((r) => r.externalSessionId),
      ["f4", "f3", "f2", "f1", "f0"]
    );
  });
});

test("ISS-5348: statusCounts censuses the WHOLE table, not a recent window", async () => {
  await withStore(async (store) => {
    // The status snapshot used to read the newest 100 rows. That was a sample:
    // a device whose dead-lettered rows were older than the window reported a
    // clean lane, so the footer missed the failure it exists to report.
    for (let i = 0; i < 3; i++) {
      await store.observe(
        observeInput({
          externalSessionId: `queued-${i}`,
          fileKey: "main",
          mtimeMs: 5000 + i,
        })
      );
    }
    // One OLD dead-lettered row, deliberately the least-recent by mtime.
    await store.observe(
      observeInput({
        externalSessionId: "ancient",
        fileKey: "main",
        mtimeMs: 1,
      })
    );
    await store.markDead("ancient", "main", "too big", T0);

    const counts = await store.statusCounts();

    assert.equal(counts.dead, 1, "an old dead row must still be counted");
    assert.equal(counts.queued, 3);
    assert.equal(counts.uploading, 0);
    assert.equal(counts.failed, 0);
    // A newest-2 window would have seen only `queued-2` and `queued-1`, and
    // reported a perfectly healthy lane.
    const window = await store.listRecent(2);
    assert.equal(
      window.some((row) => row.status === "dead"),
      false,
      "the old sampled read genuinely could not see this row"
    );
  });
});

test("ISS-5348: statusCounts starts every known status at zero", async () => {
  await withStore(async (store) => {
    // Every key present at 0 on an empty table. A MISSING key would read as
    // "no rows" at the call site and silently under-report a real state.
    assert.deepEqual(await store.statusCounts(), {
      idle: 0,
      queued: 0,
      uploading: 0,
      failed: 0,
      dead: 0,
    });
  });
});

test("ISS-5348: statusCounts drops an unknown status rather than throwing", async () => {
  // `status` is an unconstrained TEXT column, so a version-skewed or corrupt
  // value is reachable at runtime no matter what the types say. It must be
  // dropped — never thrown on, and never guessed into a known state that would
  // move the footer to a claim the row does not support.
  const { prisma, close } = await openTestPrisma();
  try {
    const store = createTranscriptSyncStore(prisma);
    await prisma.write((client) =>
      client.$executeRawUnsafe(
        `INSERT INTO transcript_sync_state (
           external_session_id, file_key, source_harness, source_path,
           source_path_hash, status, sync_class, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        "sess-rogue",
        "main",
        "claude",
        "/home/.claude/projects/p/sess-rogue.jsonl",
        "hash-rogue",
        "teleporting",
        "backfill",
        T0,
        T0
      )
    );

    const counts = await store.statusCounts();

    assert.deepEqual(counts, {
      idle: 0,
      queued: 0,
      uploading: 0,
      failed: 0,
      dead: 0,
    });
  } finally {
    await close();
  }
});

test("markDead terminally skips a file with a retained reason", async () => {
  await withStore(async (store) => {
    await store.observe(observeInput());
    await store.markDead("sess-1", "main", "skipped: too large", T0);
    const fp = await store.get("sess-1", "main");
    assert.equal(fp?.status, "dead");
    assert.equal(fp?.lastError, "skipped: too large");
    assert.equal(fp?.nextAttemptAt, null);
    // A dead row is excluded from the ready set (never re-picked without change).
    const ready = await store.listReady("2026-07-09T00:10:00.000Z", 10);
    assert.equal(ready.length, 0);
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

test("ISS-4716: listRecent reads on the reader pool while a writer transaction is held busy", async () => {
  // The import-splash footnote polls `getStatusSnapshot`, whose only store read
  // is `listRecent` — and it polls while the splash is on screen, i.e. straight
  // through the first-boot DATA_REVISION rebuild that saturates the single
  // writer connection. On `prisma.client` that poll would queue behind the
  // rebuild's `$transaction`s (the exact contention ISS-4710 fixed for
  // `listReady`). Mirrors that test: hold a real writer transaction open and
  // prove `listRecent` resolves with the row BEFORE the write is released.
  const { prisma, close } = await openTestPrisma();
  try {
    const store = createTranscriptSyncStore(prisma);
    await store.observe(observeInput({ syncClass: "live" }));

    let releaseWrite!: () => void;
    const writeHeld = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    // Signal from INSIDE the transaction, after it is open and parked, so the
    // assertion proves concurrency rather than merely winning a microtask race.
    let signalWriterHeld!: () => void;
    const writerHeld = new Promise<void>((resolve) => {
      signalWriterHeld = resolve;
    });
    let writeSettled = false;
    const busyWrite = prisma.write((client) =>
      client.$transaction(async (tx) => {
        await tx.$queryRawUnsafe("SELECT 1");
        signalWriterHeld();
        try {
          await writeHeld;
          writeSettled = true;
        } finally {
          writeSettled = true;
        }
      })
    );
    busyWrite.catch(() => undefined);

    try {
      await writerHeld;

      const recent = await store.listRecent(100);
      assert.equal(
        writeSettled,
        false,
        "listRecent returned while the writer transaction was still held"
      );
      assert.equal(recent.length, 1, "the row was read concurrently");
      assert.equal(recent[0]?.externalSessionId, "sess-1");
    } finally {
      releaseWrite();
      await busyWrite;
    }
  } finally {
    await close();
  }
});
