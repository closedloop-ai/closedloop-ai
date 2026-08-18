/**
 * @file transcript-sync-executor-missing-source.test.ts
 * @description The transcript executor's MISSING-SOURCE ladder, end to end: the
 * FEA-3555 bounded backoff and its isolated `missingSourceCount` counter, the
 * ISS-4621 ack-gated `source_gone` terminal (and its persisted-row redrive), the
 * ISS-4647 batch-materialized (OpenCode) longer bound plus the previous-target
 * cursor guard, and the ISS-4695 item-3 regenerable-reason split
 * (`materialized_source_unavailable` vs `source_gone`).
 *
 * #4195: split out of `transcript-sync-executor.test.ts` (a shrink-only
 * grandfathered file) so the source-recovery cluster has one owner and that
 * suite finishes below its pinned base instead of growing with the ISS-4695
 * terminal-status cluster. Shares the executor fakes with its siblings via
 * `./helpers/transcript-sync-executor-fixtures.js`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TranscriptSkipReason,
  TranscriptUploadStatus,
} from "@repo/api/src/types/desktop-transcripts";
import { createTranscriptSyncExecutor } from "../src/main/transcript-sync/transcript-sync-executor.js";
import {
  redactedArchiveCursorTargetId,
  TRANSCRIPT_SOURCE_GONE_DEAD_LETTER_PREFIX,
  TRANSCRIPT_SYNC_MAX_MATERIALIZED_SOURCE_ATTEMPTS,
  TRANSCRIPT_SYNC_MAX_MISSING_SOURCE_ATTEMPTS,
  TranscriptSourceHarness,
} from "../src/main/transcript-sync/transcript-sync-types.js";
import {
  fakeFsDeps,
  fingerprint,
  NOW,
  recordingClient,
  recordingStore,
} from "./helpers/transcript-sync-executor-fixtures.js";

test("FEA-3555: a never-uploaded missing source under threshold backs off (not terminal)", async () => {
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

  // First missing observation (missingSourceCount 0 -> 1 < threshold): a
  // transient miss (rotation/flush race), so record a backoff failure and
  // re-attempt rather than dead-letter or idle.
  const result = await executor.syncFile(
    fingerprint({ retryCount: 0, missingSourceCount: 0 })
  );
  assert.deepEqual(result, { kind: "skipped", reason: "file missing" });
  assert.equal(store.dead.length, 0);
  assert.equal(store.idled.length, 0);
  assert.equal(client.skipRequests.length, 0);
  assert.equal(store.failures.length, 1);
  assert.equal(store.failures[0].retryCount, 1);
  // FEA-3555: the isolated missing-source counter advances too.
  assert.equal(store.failures[0].missingSourceCount, 1);
  assert.equal(store.failures[0].dead, false);
  assert.ok(store.failures[0].nextAttemptAt !== null);
});

test("FEA-3555: a never-uploaded missing source at threshold is terminally skipped as source_gone", async () => {
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

  // missingSourceCount = threshold - 1 -> this consecutive miss reaches the
  // threshold -> terminal.
  const result = await executor.syncFile(
    fingerprint({
      missingSourceCount: TRANSCRIPT_SYNC_MAX_MISSING_SOURCE_ATTEMPTS - 1,
    })
  );
  // Terminal skip: `permanent` so the force-archive path surfaces it as a
  // non-retryable dead end rather than inviting a pointless retry (FEA-3489).
  assert.deepEqual(result, {
    kind: "skipped",
    reason: "source gone",
    permanent: true,
  });
  // Dead-lettered locally, no transient failure recorded.
  assert.equal(store.failures.length, 0);
  assert.equal(store.idled.length, 0);
  assert.equal(store.dead.length, 1);
  assert.equal(store.dead[0].id, "sess-1");
  assert.equal(store.dead[0].key, "main");
  assert.ok(store.dead[0].reason.includes("source gone"));
  // FEA-3555: the terminal disposition is mirrored to the cloud with the
  // `source_gone` reason so the read path derives `failedPermanent`.
  assert.equal(client.skipRequests.length, 1);
  assert.deepEqual(client.skipRequests[0], {
    computeTargetId: "ct-1",
    externalSessionId: "sess-1",
    fileKey: "main",
    sourceHarness: "claude",
    reason: "source_gone",
  });
});

test("ISS-4815: a missing source the cloud already holds settles through the DURABLE cloud-uploaded terminal", async () => {
  const store = recordingStore();
  const client = recordingClient(
    { mode: "noop", syncedByteOffset: 0, storedEtag: null },
    0
  );
  // The source is gone and the desktop never uploaded a byte of it, so the
  // terminal `source_gone` skip fires — and the server answers `uploaded`: a
  // verified archive already exists, so it refused to mask readable bytes with
  // a late skip.
  client.skip = (request: unknown) => {
    client.skipRequests.push(request);
    return Promise.resolve({
      status: TranscriptUploadStatus.Uploaded,
      permanentFailureReason: TranscriptSkipReason.SourceGone,
      sessionDetailId: null,
    });
  };
  const executor = createTranscriptSyncExecutor({
    store,
    client,
    getComputeTargetId: () => "ct-1",
    now: () => NOW,
    ...fakeFsDeps(null),
  });

  const result = await executor.syncFile(
    fingerprint({
      missingSourceCount: TRANSCRIPT_SYNC_MAX_MISSING_SOURCE_ATTEMPTS - 1,
    })
  );

  // Not dead (the cloud can read it) and not a bare `idle` either: the row's
  // cursor is still 0, which is exactly what `requeueStrandedMissingBlobs`
  // re-arms, so a bare idle replayed this ladder and this skip on every launch.
  // The durable settle is what ends that loop.
  assert.equal(client.skipRequests.length, 1);
  assert.deepEqual(store.cloudUploaded, ["sess-1:main"]);
  // Scoped to the target that gave the ack, so a later switch to a different
  // compute target re-arms the row instead of treating this cloud's archive as
  // proof the new one holds the transcript.
  assert.deepEqual(store.cloudUploadedTargets, ["ct-1"]);
  assert.deepEqual(store.idled, []);
  assert.equal(store.dead.length, 0);
  assert.equal(store.failures.length, 0);
  // Non-permanent: the cloud holds the archive, so the force-archive path must
  // not surface a terminal dead end for it — the row keeps the non-terminal
  // missing-source descriptor instead of the `permanent` source-gone verdict.
  assert.deepEqual(result, { kind: "skipped", reason: "file missing" });
});

test("ISS-4621: a consent revocation after claim suppresses the skip POST (nothing leaves the lane)", async () => {
  const store = recordingStore();
  const client = recordingClient(
    { mode: "noop", syncedByteOffset: 0, storedEtag: null },
    0
  );
  // The gate passes at claim time, then the user lowers the tier while the
  // stat runs. The terminal source_gone branch is reached, but the skip POST —
  // which carries session identity from this lane — must NOT fire; the row
  // settles retryable and the transition re-runs once consent reopens.
  let calls = 0;
  const executor = createTranscriptSyncExecutor({
    store,
    client,
    getComputeTargetId: () => "ct-1",
    isSyncStillPermitted: () => {
      calls += 1;
      return calls < 2;
    },
    now: () => NOW,
    ...fakeFsDeps(null),
  });

  const result = await executor.syncFile(
    fingerprint({
      missingSourceCount: TRANSCRIPT_SYNC_MAX_MISSING_SOURCE_ATTEMPTS - 1,
    })
  );

  assert.deepEqual(result, { kind: "skipped", reason: "file missing" });
  assert.equal(client.skipRequests.length, 0, "no POST after revocation");
  assert.equal(store.dead.length, 0);
  assert.equal(store.failures.length, 1);
  assert.equal(store.failures[0].dead, false);
});

test("ISS-4621: source_gone at threshold stays retryable when the cloud skip is NOT acknowledged", async () => {
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
    ...fakeFsDeps(null),
  });

  const result = await executor.syncFile(
    fingerprint({
      missingSourceCount: TRANSCRIPT_SYNC_MAX_MISSING_SOURCE_ATTEMPTS - 1,
    })
  );
  // NOT dead: a dead row for a gone source is never re-observed, so a lost
  // skip POST would leave the cloud on `syncing` forever. The row stays on the
  // retry ladder with the missing counter HELD AT the threshold, so the next
  // drain goes straight back to the terminal branch and re-attempts the skip
  // (idempotent server-side).
  assert.deepEqual(result, { kind: "skipped", reason: "file missing" });
  assert.equal(store.dead.length, 0);
  assert.equal(store.failures.length, 1);
  assert.equal(store.failures[0].dead, false);
  assert.equal(
    store.failures[0].missingSourceCount,
    TRANSCRIPT_SYNC_MAX_MISSING_SOURCE_ATTEMPTS
  );
  assert.ok(store.failures[0].nextAttemptAt !== null);
});

test("ISS-4647: an unacknowledged source_gone skip is redriven from the PERSISTED row until the cloud acks", async () => {
  // The durability contract behind ISS-4647 item 1: a terminal skip whose POST
  // fails must survive as row state (`failed` + the held missing counter) and be
  // re-attempted by the NEXT drain, so a single transport failure can never
  // leave the cloud on `syncing` forever. This drives the whole two-pass
  // sequence — failed ack, persisted row, successful ack — rather than only the
  // first pass's settle.
  const store = recordingStore();
  const client = recordingClient(
    { mode: "noop", syncedByteOffset: 0, storedEtag: null },
    0
  );
  let ackFails = true;
  client.skip = (request: unknown) => {
    client.skipRequests.push(request);
    if (ackFails) {
      return Promise.reject(new Error("relay 502"));
    }
    return Promise.resolve({
      status: "skipped" as const,
      permanentFailureReason: TranscriptSkipReason.SourceGone,
      sessionDetailId: null,
    });
  };
  const executor = createTranscriptSyncExecutor({
    store,
    client,
    getComputeTargetId: () => "ct-1",
    now: () => NOW,
    ...fakeFsDeps(null),
  });

  const first = await executor.syncFile(
    fingerprint({
      missingSourceCount: TRANSCRIPT_SYNC_MAX_MISSING_SOURCE_ATTEMPTS - 1,
    })
  );
  assert.deepEqual(first, { kind: "skipped", reason: "file missing" });
  assert.equal(store.dead.length, 0, "not dead while the skip is unacked");

  // Rebuild the fingerprint the next drain reads back from the store — the
  // persisted failure state, not the in-memory one — and prove the redrive
  // terminates once the control plane acknowledges.
  const persisted = fingerprint({
    status: "failed",
    retryCount: store.failures[0].retryCount,
    missingSourceCount: store.failures[0].missingSourceCount,
    nextAttemptAt: store.failures[0].nextAttemptAt,
    lastError: store.failures[0].lastError,
  });
  ackFails = false;
  const second = await executor.syncFile(persisted);

  assert.deepEqual(second, {
    kind: "skipped",
    reason: "source gone",
    permanent: true,
  });
  assert.equal(client.skipRequests.length, 2, "the skip POST was re-attempted");
  assert.equal(store.dead.length, 1, "dead-lettered only after the cloud ack");
  assert.ok(
    store.dead[0].reason.startsWith(TRANSCRIPT_SOURCE_GONE_DEAD_LETTER_PREFIX)
  );
});

test("ISS-4647: a batch-materialized (opencode) missing source below its longer bound backs off instead of idling", async () => {
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

  // FEA-3932's rationale still holds — the materializer regenerates the file, so
  // OpenCode gets the LONGER ladder and must not dead-letter at the raw-harness
  // threshold. But it must settle `failed` (visible to listReady), not `idle`:
  // an idle row is only re-armed by the stranded-blob recovery, which then hits
  // this branch again — the idle→queued→idle cycle with no ladder advance.
  const result = await executor.syncFile(
    fingerprint({
      externalSessionId: "opencode-1",
      sourceHarness: "opencode",
      syncedByteOffset: 0,
      missingSourceCount: TRANSCRIPT_SYNC_MAX_MISSING_SOURCE_ATTEMPTS,
      retryCount: TRANSCRIPT_SYNC_MAX_MISSING_SOURCE_ATTEMPTS,
    })
  );
  // Below its LONGER bound the opencode row is a retryable miss, not a terminal
  // — no dead-letter, no cloud skip; it settles `failed` with the counter
  // advanced (ISS-4647). The terminal reason split (source_gone vs
  // materialized_source_unavailable) only applies once the bound is reached
  // (see the "terminates at its bound" test below).
  assert.deepEqual(result, {
    kind: "skipped",
    reason: "materialized source not ready",
  });
  assert.deepEqual(
    store.idled,
    [],
    "never settles to the absorbing idle state"
  );
  assert.equal(store.dead.length, 0);
  assert.equal(store.failures.length, 1);
  assert.equal(store.failures[0].dead, false);
  // The isolated counter ADVANCED — that is what makes the ladder converge.
  assert.equal(
    store.failures[0].missingSourceCount,
    TRANSCRIPT_SYNC_MAX_MISSING_SOURCE_ATTEMPTS + 1
  );
  assert.ok(store.failures[0].nextAttemptAt !== null);
  // No terminal skip yet — the source may still materialize.
  assert.equal(client.skipRequests.length, 0);
});

test("ISS-4695 item 3: a batch-materialized (opencode) missing source AT its longer bound emits materialized_source_unavailable, NOT source_gone", async () => {
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

  // A materialized OpenCode source that crossed its (longer, ISS-4647) missing
  // cap CAN be regenerated on a later sweep, so the terminal it reports to the
  // cloud must be the RECOVERABLE `materialized_source_unavailable` — NOT the
  // HARD `source_gone` a raw Claude/Codex rollout would emit. The cloud then maps
  // it to a non-`failedPermanent` disposition so redrive stays possible.
  const result = await executor.syncFile(
    fingerprint({
      externalSessionId: "opencode-1",
      sourceHarness: "opencode",
      syncedByteOffset: 0,
      missingSourceCount: TRANSCRIPT_SYNC_MAX_MATERIALIZED_SOURCE_ATTEMPTS - 1,
    })
  );
  assert.deepEqual(result, {
    kind: "skipped",
    reason: "materialized source unavailable",
    permanent: true,
  });
  // Dead-lettered locally with the shared source-gone family prefix so the
  // FEA-3932 OpenCode redrive-on-start still picks it up once re-materialized.
  assert.equal(store.dead.length, 1);
  assert.equal(store.dead[0].id, "opencode-1");
  assert.equal(store.dead[0].key, "main");
  assert.ok(
    store.dead[0].reason.startsWith(TRANSCRIPT_SOURCE_GONE_DEAD_LETTER_PREFIX)
  );
  assert.equal(store.idled.length, 0);
  assert.equal(store.failures.length, 0);
  // The terminal skip carries the NEW recoverable reason.
  assert.equal(client.skipRequests.length, 1);
  assert.deepEqual(client.skipRequests[0], {
    computeTargetId: "ct-1",
    externalSessionId: "opencode-1",
    fileKey: "main",
    sourceHarness: "opencode",
    reason: TranscriptSkipReason.MaterializedSourceUnavailable,
  });
});

test("ISS-4695 item 3: a raw Claude/Codex (non-materialized) missing source at threshold still emits source_gone", async () => {
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

  // A raw agent-owned rollout that vanished before any bytes synced is
  // unrecoverable — it keeps the HARD `source_gone` terminal so the cloud derives
  // `failedPermanent`. (This is the same claude-default fingerprint the older
  // FEA-3555 threshold test uses, re-pinned here for the ISS-4695 harness split.)
  const result = await executor.syncFile(
    fingerprint({
      sourceHarness: TranscriptSourceHarness.Codex,
      missingSourceCount: TRANSCRIPT_SYNC_MAX_MISSING_SOURCE_ATTEMPTS - 1,
    })
  );
  assert.deepEqual(result, {
    kind: "skipped",
    reason: "source gone",
    permanent: true,
  });
  assert.equal(store.dead.length, 1);
  assert.equal(client.skipRequests.length, 1);
  assert.deepEqual(client.skipRequests[0], {
    computeTargetId: "ct-1",
    externalSessionId: "sess-1",
    fileKey: "main",
    sourceHarness: TranscriptSourceHarness.Codex,
    reason: TranscriptSkipReason.SourceGone,
  });
});

test("ISS-4647: a batch-materialized (opencode) source that never materializes terminates at its bound", async () => {
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

  const result = await executor.syncFile(
    fingerprint({
      externalSessionId: "opencode-1",
      sourceHarness: "opencode",
      syncedByteOffset: 0,
      missingSourceCount: TRANSCRIPT_SYNC_MAX_MATERIALIZED_SOURCE_ATTEMPTS - 1,
    })
  );

  // Bounded, not infinite: after this many consecutive misses (several
  // materialize passes) the row dead-letters and the cloud stops representing it
  // as `missing`/`syncing` forever. ISS-4695 item 3: an opencode projection is
  // regenerable, so its terminal is the RECOVERABLE `materialized_source_unavailable`
  // (cloud → non-`failedPermanent`), not the HARD `source_gone`.
  assert.deepEqual(result, {
    kind: "skipped",
    reason: "materialized source unavailable",
    permanent: true,
  });
  assert.equal(store.dead.length, 1);
  assert.ok(
    store.dead[0].reason.startsWith(TRANSCRIPT_SOURCE_GONE_DEAD_LETTER_PREFIX),
    "carries the prefix the FEA-3932 OpenCode redrive matches, so a fixed materializer still heals it"
  );
  assert.equal(client.skipRequests.length, 1);
});

test("ISS-4647: the recovery-to-skip sequence terminates a re-armed opencode row", async () => {
  // The item-4 cycle end to end: the stranded-blob recovery re-arms an `idle`
  // opencode row, the drain re-attempts it, and each attempt now ADVANCES the
  // bounded ladder from the persisted counter until the terminal skip fires —
  // instead of re-idling at the same count forever.
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

  let row = fingerprint({
    externalSessionId: "opencode-1",
    sourceHarness: "opencode",
    syncedByteOffset: 0,
  });
  let attempts = 0;
  let last = await executor.syncFile(row);
  while (!(last.kind === "skipped" && last.permanent === true)) {
    attempts += 1;
    assert.ok(
      attempts <= TRANSCRIPT_SYNC_MAX_MATERIALIZED_SOURCE_ATTEMPTS,
      "the ladder must converge within its bound"
    );
    const persisted = store.failures.at(-1);
    assert.ok(persisted, "each non-terminal attempt persists a retryable row");
    row = fingerprint({
      ...row,
      status: "failed",
      retryCount: persisted.retryCount,
      missingSourceCount: persisted.missingSourceCount,
    });
    last = await executor.syncFile(row);
  }

  assert.equal(store.dead.length, 1);
  assert.deepEqual(store.idled, []);
  assert.equal(client.skipRequests.length, 1);
});

test("FEA-3555: transient-failure retryCount does NOT trip the source_gone threshold (isolated counter)", async () => {
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

  // The row accumulated unrelated transient upload failures (retryCount at/above
  // the missing-source threshold) BEFORE the source ever went missing. Because
  // the terminal decision reads the isolated missingSourceCount (0 here), this
  // FIRST missing observation must back off, NOT dead-letter as source_gone.
  const result = await executor.syncFile(
    fingerprint({
      retryCount: TRANSCRIPT_SYNC_MAX_MISSING_SOURCE_ATTEMPTS + 2,
      missingSourceCount: 0,
    })
  );
  assert.deepEqual(result, { kind: "skipped", reason: "file missing" });
  assert.equal(store.dead.length, 0);
  assert.equal(client.skipRequests.length, 0);
  assert.equal(store.failures.length, 1);
  // The shared backoff ladder still climbs off retryCount; the isolated
  // missing-source counter starts its run at 1.
  assert.equal(
    store.failures[0].retryCount,
    TRANSCRIPT_SYNC_MAX_MISSING_SOURCE_ATTEMPTS + 3
  );
  assert.equal(store.failures[0].missingSourceCount, 1);
});

test("FEA-3555: a missing source with bytes already uploaded idles (cloud has content)", async () => {
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

  // Already-uploaded bytes are readable in THIS target's cloud, so a vanished
  // source is benign — settle to idle regardless of retryCount.
  const result = await executor.syncFile(
    fingerprint({
      syncedByteOffset: 500,
      syncedComputeTargetId: redactedArchiveCursorTargetId("ct-1"),
      retryCount: TRANSCRIPT_SYNC_MAX_MISSING_SOURCE_ATTEMPTS,
    })
  );
  assert.deepEqual(result, { kind: "skipped", reason: "file missing" });
  assert.deepEqual(store.idled, ["sess-1:main"]);
  assert.equal(store.dead.length, 0);
  assert.equal(store.failures.length, 0);
  assert.equal(client.skipRequests.length, 0);
});

test("ISS-4647: a missing source whose bytes belong to a PREVIOUS target terminates instead of idling", async () => {
  const store = recordingStore();
  const client = recordingClient(
    { mode: "noop", syncedByteOffset: 0, storedEtag: null },
    0
  );
  const executor = createTranscriptSyncExecutor({
    store,
    client,
    getComputeTargetId: () => "ct-new",
    now: () => NOW,
    ...fakeFsDeps(null),
  });

  // `syncedByteOffset > 0` alone is not proof the CURRENT target's cloud holds
  // the transcript: these bytes went to `ct-old`. Idling on that cursor left
  // ct-new's row `missing`/`syncing` forever, so the row must instead fall
  // through to the bounded missing-source ladder and terminate honestly.
  const result = await executor.syncFile(
    fingerprint({
      syncedByteOffset: 500,
      syncedComputeTargetId: redactedArchiveCursorTargetId("ct-old"),
      missingSourceCount: TRANSCRIPT_SYNC_MAX_MISSING_SOURCE_ATTEMPTS - 1,
    })
  );

  assert.deepEqual(result, {
    kind: "skipped",
    reason: "source gone",
    permanent: true,
  });
  assert.deepEqual(store.idled, []);
  assert.equal(store.dead.length, 1);
  assert.equal(client.skipRequests.length, 1);
});
