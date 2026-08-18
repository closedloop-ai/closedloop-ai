/**
 * @file transcript-sync-store-recovery.test.ts
 * @description The transcript-sync store's RECOVERY mutations — every write
 * that re-arms or revives a row the lane already settled: `requeueStale`
 * (crash-stranded `uploading` rows), `requeueStrandedMissingBlobs` (the
 * ISS-4621 zero-byte `idle` strand, the ISS-4647 previous-target cursor guard,
 * and the ISS-4815 durable cloud-uploaded exclusion), `requeueRevoked`
 * (ISS-4621), `reviveForForcedSync` (FEA-3489) and `redriveDeadLettered`
 * (FEA-3932). Runs against a real libSQL database via the production migration
 * runner.
 *
 * ISS-4815: split out of `transcript-sync-store.test.ts` so that suite stays
 * under the file-size ceiling and the recovery predicates have one owner
 * (mirroring the #4195 executor-suite split). Shares the store harness with its
 * sibling via `./helpers/transcript-sync-store-fixtures.js`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranscriptSyncStore } from "../src/main/database/transcript-sync-store.js";
import {
  redactedArchiveCursorTargetId,
  TRANSCRIPT_OVERSIZED_DEAD_LETTER_PREFIX,
  TRANSCRIPT_SOURCE_GONE_DEAD_LETTER_PREFIX,
} from "../src/main/transcript-sync/transcript-sync-types.js";
import {
  observeInput,
  T0,
  withStore,
} from "./helpers/transcript-sync-store-fixtures.js";
import { openTestPrisma } from "./prisma-test-utils.js";

test("requeueStale revives a crash-stranded uploading row", async () => {
  await withStore(async (store) => {
    await store.observe(observeInput());
    await store.markUploading("sess-1", "main", T0);
    assert.equal((await store.get("sess-1", "main"))?.status, "uploading");
    assert.equal(await store.requeueStale(T0), 1);
    assert.equal((await store.get("sess-1", "main"))?.status, "queued");
  });
});

test("requeueStrandedMissingBlobs re-arms an idle row that never uploaded a byte (ISS-4621)", async () => {
  await withStore(async (store) => {
    // SES-78221 shape: a row observed once, then settled `idle` with
    // syncedByteOffset === 0 (source vanished before any byte synced). It is
    // invisible to both listReady (idle) and discovery (gone source), so nothing
    // terminates it — the transcript reads `missing`/`syncing` forever.
    await store.observe(observeInput());
    await store.markIdle("sess-1", "main", T0);
    const before = await store.get("sess-1", "main");
    assert.equal(before?.status, "idle");
    assert.equal(before?.syncedByteOffset, 0);

    assert.equal(
      await store.requeueStrandedMissingBlobs({
        now: T0,
        computeTargetId: "target-1",
      }),
      1
    );

    const after = await store.get("sess-1", "main");
    // Re-armed to `queued` so the drain can drive it to upload OR a terminal
    // source_gone dead-letter — never left stranded.
    assert.equal(after?.status, "queued");
    assert.equal(after?.retryCount, 0);
    assert.equal(after?.missingSourceCount, 0);
    assert.equal(after?.nextAttemptAt, null);
  });
});

test("requeueStrandedMissingBlobs leaves a fully-synced idle row untouched (ISS-4621)", async () => {
  await withStore(async (store) => {
    // A caught-up file settles to `idle` with syncedByteOffset > 0. It is NOT
    // stranded (the cloud already holds its bytes), so the recovery must skip it
    // and never re-upload a healthy transcript.
    await store.observe(observeInput());
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
    const synced = await store.get("sess-1", "main");
    assert.equal(synced?.status, "idle");
    assert.ok((synced?.syncedByteOffset ?? 0) > 0);

    assert.equal(
      await store.requeueStrandedMissingBlobs({
        now: T0,
        computeTargetId: "target-1",
      }),
      0
    );
    assert.equal((await store.get("sess-1", "main"))?.status, "idle");
  });
});

test("ISS-4647: requeueStrandedMissingBlobs re-arms an idle row whose bytes belong to a PREVIOUS compute target", async () => {
  await withStore(async (store) => {
    // The row uploaded 500 bytes — but to `target-old`. Against `target-new` the
    // cloud has nothing, so `syncedByteOffset > 0` must NOT count as "the cloud
    // holds it". `planObservation` already treats this cursor as stale; the
    // recovery now applies the same check instead of excluding the row.
    await store.observe(observeInput());
    await store.recordUploaded({
      externalSessionId: "sess-1",
      fileKey: "main",
      syncedByteOffset: 500,
      syncedSha256: "sha",
      storedEtag: "etag",
      syncedComputeTargetId: redactedArchiveCursorTargetId("target-old"),
      caughtUp: true,
      now: T0,
    });
    assert.equal((await store.get("sess-1", "main"))?.status, "idle");

    assert.equal(
      await store.requeueStrandedMissingBlobs({
        now: T0,
        computeTargetId: "target-new",
      }),
      1
    );
    assert.equal((await store.get("sess-1", "main"))?.status, "queued");
  });
});

test("ISS-4647: an offline recovery narrows back to never-uploaded rows only", async () => {
  await withStore(async (store) => {
    // With no compute target the cursor's domain is unknowable, so a row holding
    // bytes must be left alone rather than re-armed on a guess.
    await store.observe(observeInput());
    await store.recordUploaded({
      externalSessionId: "sess-1",
      fileKey: "main",
      syncedByteOffset: 500,
      syncedSha256: "sha",
      storedEtag: "etag",
      syncedComputeTargetId: redactedArchiveCursorTargetId("target-old"),
      caughtUp: true,
      now: T0,
    });

    assert.equal(
      await store.requeueStrandedMissingBlobs({
        now: T0,
        computeTargetId: null,
      }),
      0
    );
    assert.equal((await store.get("sess-1", "main"))?.status, "idle");
  });
});

test("ISS-4815: a cloud-acknowledged zero-offset row stays settled across relaunches", async () => {
  await withStore(async (store) => {
    // ISS-4695 shape: the local source is gone, the desktop never uploaded a
    // byte of it (`syncedByteOffset` 0), and the terminal skip came back
    // `uploaded` — the cloud holds a verified archive. Settling that as a bare
    // `idle` left it matching the stranded predicate, so EVERY launch re-armed
    // it, replayed the missing-source ladder and re-emitted the skip.
    await store.observe(observeInput());
    await store.markCloudUploaded("sess-1", "main", T0, "target-1");
    const settled = await store.get("sess-1", "main");
    assert.equal(settled?.status, "idle");
    assert.equal(settled?.syncedByteOffset, 0);

    // Boot 1: the sweep's stranded-blob recovery must leave it alone.
    assert.equal(
      await store.requeueStrandedMissingBlobs({
        now: "2026-07-09T01:00:00.000Z",
        computeTargetId: "target-1",
      }),
      0
    );
    assert.equal((await store.get("sess-1", "main"))?.status, "idle");

    // Boot 2: durable, not a one-shot in-process suppression — the exclusion
    // still holds after another relaunch's recovery pass.
    assert.equal(
      await store.requeueStrandedMissingBlobs({
        now: "2026-07-09T02:00:00.000Z",
        computeTargetId: "target-1",
      }),
      0
    );
    const after = await store.get("sess-1", "main");
    assert.equal(after?.status, "idle");
    assert.equal(after?.missingSourceCount, 0);
  });
});

// wongk (#4253): `markCloudUploaded` is a SUCCESSFUL settle, so it must retire
// the failure ladder like `recordUploaded` does. `getStatusSnapshot` forwards
// `lastError` verbatim, so a leftover message would surface an authoritative
// "the cloud already holds it" row as idle-with-a-stale-upload-error.
test("ISS-4815: the cloud acknowledgement clears the retry count and last error", async () => {
  await withStore(async (store) => {
    await store.observe(observeInput());
    await store.recordFailure({
      externalSessionId: "sess-1",
      fileKey: "main",
      retryCount: 3,
      missingSourceCount: 3,
      dead: false,
      nextAttemptAt: T0,
      lastError: "local transcript source missing",
      now: T0,
    });
    assert.equal((await store.get("sess-1", "main"))?.retryCount, 3);

    await store.markCloudUploaded("sess-1", "main", T0, "target-1");

    const row = await store.get("sess-1", "main");
    assert.equal(row?.status, "idle");
    assert.equal(row?.retryCount, 0);
    assert.equal(row?.lastError, null);
  });
});

test("ISS-4815: a genuinely stranded row is still re-armed alongside a cloud-acknowledged one", async () => {
  await withStore(async (store) => {
    // The exclusion must be scoped to the acknowledgement, NOT a blanket
    // widening that quietly disables the ISS-4621 recovery. Both rows are
    // `idle` at a zero cursor in the SAME sweep; only the acknowledged one is
    // spared.
    await store.observe(observeInput({ externalSessionId: "sess-ack" }));
    await store.markCloudUploaded("sess-ack", "main", T0, "target-1");
    await store.observe(observeInput({ externalSessionId: "sess-stranded" }));
    await store.markIdle("sess-stranded", "main", T0);

    assert.equal(
      await store.requeueStrandedMissingBlobs({
        now: T0,
        computeTargetId: "target-1",
      }),
      1
    );
    assert.equal((await store.get("sess-ack", "main"))?.status, "idle");
    assert.equal((await store.get("sess-stranded", "main"))?.status, "queued");
  });
});

test("ISS-4815: a pre-migration row (no cloud_uploaded_at value) is recovered exactly as before", async () => {
  // Version-skew: rows written by a build that predates the column hold SQL
  // NULL there. Absent must degrade to "not acknowledged" — still eligible for
  // the stranded-blob recovery — never to a silent exclusion that re-strands
  // the SES-78221 limbo this recovery exists to break.
  const { prisma, close } = await openTestPrisma();
  try {
    const store = createTranscriptSyncStore(prisma);
    await prisma.write((client) =>
      client.$executeRawUnsafe(
        `INSERT INTO transcript_sync_state (
           external_session_id, file_key, source_harness, source_path,
           source_path_hash, status, sync_class, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        "sess-legacy",
        "main",
        "claude",
        "/home/.claude/projects/p/sess-legacy.jsonl",
        "hash-legacy",
        "idle",
        "backfill",
        T0,
        T0
      )
    );

    assert.equal(
      await store.requeueStrandedMissingBlobs({
        now: T0,
        computeTargetId: "target-1",
      }),
      1
    );
    assert.equal((await store.get("sess-legacy", "main"))?.status, "queued");
  } finally {
    await close();
  }
});

test("ISS-4815: a changed file clears the persisted acknowledgement", async () => {
  // The acknowledgement is a claim about the bytes the cloud held when it was
  // written. Once the source reappears CHANGED, the row describes different
  // content the cloud does not have, so the claim must not survive the
  // re-queue — a row is never left asserting the cloud holds bytes it doesn't.
  const { prisma, close } = await openTestPrisma();
  try {
    const store = createTranscriptSyncStore(prisma);
    await store.observe(observeInput());
    await store.markCloudUploaded("sess-1", "main", T0, "target-1");
    const acknowledged = await prisma.client.transcriptSyncState.findUnique({
      where: {
        externalSessionId_fileKey: {
          externalSessionId: "sess-1",
          fileKey: "main",
        },
      },
    });
    assert.equal(acknowledged?.cloudUploadedAt, T0);

    await store.observe(observeInput({ mtimeMs: 2000, size: 900 }));
    const rearmed = await prisma.client.transcriptSyncState.findUnique({
      where: {
        externalSessionId_fileKey: {
          externalSessionId: "sess-1",
          fileKey: "main",
        },
      },
    });
    assert.equal(rearmed?.status, "queued");
    assert.equal(rearmed?.cloudUploadedAt, null);
  } finally {
    await close();
  }
});

test("requeueRevoked settles a revoked mid-upload row back to queued (ISS-4621)", async () => {
  await withStore(async (store) => {
    // A revocation lands while the row is `uploading` (the executor threw
    // TranscriptSyncRevokedError). The row must return to `queued` with a clean
    // ladder — NOT `idle`, which only re-queues on a file change and so strands
    // an ended session's transcript at zero bytes forever.
    await store.observe(observeInput());
    await store.markUploading("sess-1", "main", T0);

    assert.equal(await store.requeueRevoked("sess-1", "main", T0), 1);

    const after = await store.get("sess-1", "main");
    assert.equal(after?.status, "queued");
    assert.equal(after?.retryCount, 0);
    assert.equal(after?.missingSourceCount, 0);
    assert.equal(after?.nextAttemptAt, null);
  });
});

test("requeueRevoked is a 0-count no-op for an unknown identity (ISS-4621)", async () => {
  await withStore(async (store) => {
    // The row can be pruned concurrently; the recovery must not throw.
    assert.equal(await store.requeueRevoked("sess-none", "main", T0), 0);
  });
});

test("FEA-3489: reviveForForcedSync flips a dead row to queued and resets its counters", async () => {
  await withStore(async (store) => {
    await store.observe(observeInput());
    await store.recordFailure({
      externalSessionId: "sess-1",
      fileKey: "main",
      retryCount: 5,
      missingSourceCount: 2,
      dead: true,
      nextAttemptAt: null,
      // Whole-file-cap terminal — the ONLY reason the force-revive is scoped to.
      lastError: `${TRANSCRIPT_OVERSIZED_DEAD_LETTER_PREFIX}: 9 bytes exceeds cap`,
      now: T0,
    });
    assert.equal((await store.get("sess-1", "main"))?.status, "dead");

    // The user forces this one oversized transcript: the dead-letter flips back to
    // queued with a clean backoff so the next drain re-attempts it (queue unblocks).
    const revived = await store.reviveForForcedSync({
      externalSessionId: "sess-1",
      fileKey: "main",
      now: "2026-07-09T01:00:00.000Z",
    });
    assert.equal(revived, 1);
    const fp = await store.get("sess-1", "main");
    assert.equal(fp?.status, "queued");
    assert.equal(fp?.retryCount, 0);
    assert.equal(fp?.missingSourceCount, 0);
    assert.equal(fp?.nextAttemptAt, null);
    assert.equal(fp?.lastError, null);
  });
});

test("FEA-3489: reviveForForcedSync is a no-op for a non-dead row (returns 0)", async () => {
  await withStore(async (store) => {
    // A live queued row is NOT a dead-letter — force-revive must not touch it.
    await store.observe(observeInput());
    assert.equal((await store.get("sess-1", "main"))?.status, "queued");

    const revived = await store.reviveForForcedSync({
      externalSessionId: "sess-1",
      fileKey: "main",
      now: "2026-07-09T02:00:00.000Z",
    });
    assert.equal(revived, 0);

    // A wrong-identity force call also reports "nothing to do" (scoped to the key).
    const other = await store.reviveForForcedSync({
      externalSessionId: "sess-OTHER",
      fileKey: "main",
      now: "2026-07-09T02:00:00.000Z",
    });
    assert.equal(other, 0);
  });
});

test("FEA-3489: reviveForForcedSync revives only the whole-file-cap terminal, not source_gone / redacted-line", async () => {
  await withStore(async (store) => {
    // A `dead` row terminal for a reason the size-cap bypass CANNOT fix
    // (source gone) must NOT be revived — reviving it would loop the force-archive
    // action on the same terminal failure forever.
    await store.observe(observeInput());
    await store.recordFailure({
      externalSessionId: "sess-1",
      fileKey: "main",
      retryCount: 3,
      missingSourceCount: 3,
      dead: true,
      lastError: `${TRANSCRIPT_SOURCE_GONE_DEAD_LETTER_PREFIX} after 3 attempt(s)`,
      nextAttemptAt: null,
      now: T0,
    });
    assert.equal((await store.get("sess-1", "main"))?.status, "dead");

    const revived = await store.reviveForForcedSync({
      externalSessionId: "sess-1",
      fileKey: "main",
      now: "2026-07-09T03:00:00.000Z",
    });
    assert.equal(revived, 0);
    // Left dead — the force override cannot help a gone source.
    assert.equal((await store.get("sess-1", "main"))?.status, "dead");
  });
});

test("redriveDeadLettered flips only the target harness's dead rows to queued (FEA-3932)", async () => {
  await withStore(async (store) => {
    // One dead OpenCode row and one dead Claude row.
    await store.observe(
      observeInput({
        externalSessionId: "opencode-1",
        sourceHarness: "opencode",
        sourcePath:
          "/state/transcript-materialized/opencode/opencode-1/main.jsonl",
      })
    );
    await store.markDead("opencode-1", "main", "skipped: source gone", T0);
    await store.observe(
      observeInput({ externalSessionId: "claude-1", sourceHarness: "claude" })
    );
    await store.markDead("claude-1", "main", "skipped: too large", T0);

    const redriven = await store.redriveDeadLettered({
      sourceHarness: "opencode",
      now: "2026-07-09T00:10:00.000Z",
    });
    assert.equal(redriven, 1);

    const opencode = await store.get("opencode-1", "main");
    assert.equal(opencode?.status, "queued");
    assert.equal(opencode?.lastError, null);
    assert.equal(opencode?.retryCount, 0);
    assert.equal(opencode?.missingSourceCount, 0);
    assert.equal(opencode?.nextAttemptAt, null);

    // The Claude dead-letter is untouched (scoped to opencode only).
    const claude = await store.get("claude-1", "main");
    assert.equal(claude?.status, "dead");
    assert.equal(claude?.lastError, "skipped: too large");
  });
});

test("redriveDeadLettered with lastErrorPrefix revives only the source-gone family, not too_large (FEA-3932)", async () => {
  await withStore(async (store) => {
    // A missing-source (pre-materialization) dead-letter and a terminal
    // too_large dead-letter, both OpenCode.
    await store.observe(
      observeInput({
        externalSessionId: "opencode-gone",
        sourceHarness: "opencode",
      })
    );
    await store.markDead(
      "opencode-gone",
      "main",
      `${TRANSCRIPT_SOURCE_GONE_DEAD_LETTER_PREFIX} after 3 attempt(s)`,
      T0
    );
    await store.observe(
      observeInput({
        externalSessionId: "opencode-huge",
        sourceHarness: "opencode",
      })
    );
    await store.markDead(
      "opencode-huge",
      "main",
      "skipped: 9999 bytes exceeds 2048-byte cap",
      T0
    );

    const redriven = await store.redriveDeadLettered({
      sourceHarness: "opencode",
      lastErrorPrefix: TRANSCRIPT_SOURCE_GONE_DEAD_LETTER_PREFIX,
      now: "2026-07-09T00:10:00.000Z",
    });
    assert.equal(redriven, 1);

    const gone = await store.get("opencode-gone", "main");
    assert.equal(gone?.status, "queued");
    // The terminal too_large row stays dead — re-materializing can't shrink it.
    const huge = await store.get("opencode-huge", "main");
    assert.equal(huge?.status, "dead");
    assert.equal(huge?.lastError, "skipped: 9999 bytes exceeds 2048-byte cap");
  });
});

test("redriveDeadLettered ignores non-dead opencode rows (FEA-3932)", async () => {
  await withStore(async (store) => {
    await store.observe(
      observeInput({
        externalSessionId: "opencode-2",
        sourceHarness: "opencode",
      })
    );
    // Row is `queued` (not dead) — redrive must not touch it or its counters.
    const redriven = await store.redriveDeadLettered({
      sourceHarness: "opencode",
      now: "2026-07-09T00:10:00.000Z",
    });
    assert.equal(redriven, 0);
    const fp = await store.get("opencode-2", "main");
    assert.equal(fp?.status, "queued");
  });
});

test("ISS-4815: a cloud acknowledgement from a PREVIOUS compute target re-arms after a switch", async () => {
  await withStore(async (store) => {
    // The acknowledgement is only ever a statement about the archive held by
    // the target that gave it. When the user switches accounts/compute targets,
    // the NEW target's cloud holds nothing and the local cursor is still 0 (the
    // desktop never uploaded a byte of a missing source), so this row is
    // genuinely stranded again. Excluding on `cloudUploadedAt` alone would keep
    // it settled forever and the transcript would never reach the new target.
    await store.observe(observeInput());
    await store.markCloudUploaded("sess-1", "main", T0, "target-old");
    assert.equal((await store.get("sess-1", "main"))?.status, "idle");

    // Still settled for the target that actually acknowledged it.
    assert.equal(
      await store.requeueStrandedMissingBlobs({
        now: T0,
        computeTargetId: "target-old",
      }),
      0
    );
    assert.equal((await store.get("sess-1", "main"))?.status, "idle");

    // Switched targets: the old ack proves nothing here, so it is re-armed.
    assert.equal(
      await store.requeueStrandedMissingBlobs({
        now: "2026-07-09T01:00:00.000Z",
        computeTargetId: "target-new",
      }),
      1
    );
    const after = await store.get("sess-1", "main");
    assert.equal(after?.status, "queued");
    assert.equal(after?.retryCount, 0);
    assert.equal(after?.missingSourceCount, 0);
  });
});

test("ISS-4815: an offline recovery leaves a cloud-acknowledged row settled", async () => {
  await withStore(async (store) => {
    // With no current target the acknowledgement's target cannot be compared.
    // Re-arming on that guess would replay the ladder for a row whose ack may
    // still be valid, and an offline re-arm could not upload anyway — so the
    // predicate narrows rather than widens, matching `strandedCursorWhere`.
    await store.observe(observeInput());
    await store.markCloudUploaded("sess-1", "main", T0, "target-old");

    assert.equal(
      await store.requeueStrandedMissingBlobs({
        now: T0,
        computeTargetId: null,
      }),
      0
    );
    assert.equal((await store.get("sess-1", "main"))?.status, "idle");
  });
});

test("ISS-4815: an UNATTRIBUTABLE acknowledgement stays eligible for recovery", async () => {
  await withStore(async (store) => {
    // An ack recorded with no known target cannot be shown to describe THIS
    // target's archive. Erring toward re-arming costs one redundant skip
    // round-trip; erring the other way strands the transcript permanently.
    await store.observe(observeInput());
    await store.markCloudUploaded("sess-1", "main", T0, null);

    assert.equal(
      await store.requeueStrandedMissingBlobs({
        now: T0,
        computeTargetId: "target-1",
      }),
      1
    );
    assert.equal((await store.get("sess-1", "main"))?.status, "queued");
  });
});
