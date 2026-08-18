import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import {
  BACKFILL_SESSION_BATCH_SIZE,
  DEAD_LETTER_RETRY_BASE_MS,
  DEAD_LETTER_RETRY_MAX_MS,
  deadLetterRetryDelayMs,
  INGESTION_FAILED_BACKOFF_MS,
  MAX_CONSECUTIVE_INGESTION_FAILED,
  MAX_CONSECUTIVE_RATE_LIMITED,
  MAX_CONSECUTIVE_TIMEOUTS,
  MAX_CONSECUTIVE_TRANSPORT_ERRORS,
  MAX_CONSECUTIVE_VALIDATION_FAILED,
  MAX_OBSERVED_TOP_IDS,
  RATE_LIMIT_BACKOFF_MS,
  SESSION_PAYLOAD_BYTE_CAP,
  TARGET_NOT_OWNED_BACKOFF_MS,
  UNAUTHENTICATED_BACKOFF_MS,
  VALIDATION_FAILED_BACKOFF_MS,
} from "../src/main/agent-sync/agent-session-sync-backoff-policy.js";
import type {
  AgentSessionSyncBatch,
  AgentSessionSyncTransportPayload,
} from "../src/main/agent-sync/agent-session-sync-contract.js";
import { AGENT_SESSION_SYNC_SCHEMA_VERSION } from "../src/main/agent-sync/agent-session-sync-contract.js";
import {
  type AgentSessionPayloadPreparer,
  estimateAgentSessionSyncBatchBytes,
  maxSessionPayloadBytesForBatch,
  prepareAgentSessionPayload,
} from "../src/main/agent-sync/agent-session-sync-payload.js";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import {
  buildAgentComponentSyncSourceKey,
  buildAgentSessionSyncSourceKey,
} from "../src/main/agent-sync/agent-session-sync-source.js";
import { DesktopAgentSessionsAckReason } from "../src/main/cloud/cloud-protocol.js";
import {
  type DesktopSyncBatchEventInput,
  DesktopSyncBatchOutcome,
} from "../src/main/telemetry/app-otel-runtime.js";
import { acceptedResult } from "./agent-session-sync-component-test-utils.js";
import {
  flushAgentSessionSync,
  leakedSyncTelemetryKeys,
  makeIdleSession,
  makeMetadataHeavyChunkCandidate,
  makeOversizedSession,
  makeService,
  makeServiceCapturingSyncTelemetry,
  makeServiceWithIdentity,
  makeSessionWithLargeTiling,
  makeUnchunkableOversizedSession,
  ResettingSyncSource,
  runWithMockedNow,
  settleSelfContinuedDrain,
  UnhydratableFlaggingSyncSource,
} from "./agent-session-sync-service-fixtures.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";

test("agent-session sync batches source sessions and dequeues accepted backfill", async () => {
  const source = new FakeSyncSource([
    makeSyncedSession("session-1", "2026-06-08T12:01:00.000Z"),
    makeSyncedSession("session-2", "2026-06-08T12:02:00.000Z"),
    makeSyncedSession("session-3", "2026-06-08T12:03:00.000Z"),
    makeSyncedSession("session-4", "2026-06-08T12:04:00.000Z"),
  ]);
  const sent: AgentSessionSyncBatch[] = [];
  const service = makeService(source, async (batch) => {
    sent.push(batch);
    return { accepted: true };
  });

  service.start();
  for (let i = 0; i < 5; i += 1) {
    service.refresh();
    await flushAgentSessionSync();
  }
  service.stop();

  // ISS-5988 (byte-budgeted batching): small sessions PACK into one request
  // instead of shipping one-per-envelope — the whole corpus fits a single
  // batch, newest-first, and an accepted ack dequeues it so the later
  // refreshes above re-send nothing.
  assert.deepEqual(
    sent.map((batch) =>
      batch.sessions.map((session) => session.externalSessionId)
    ),
    [["session-4", "session-3", "session-2", "session-1"]]
  );
  assert.equal(
    sent[0].sessionCount,
    4,
    "the batch envelope declares the packed session count"
  );
  // Goal stage 2 production wiring: every built batch requests the per-session
  // ack echo (an old server strips the flag and answers whole-batch).
  assert.equal(
    sent[0].wantsAcceptedSessionIds,
    true,
    "the batch opts in to the acceptedSessionIds echo"
  );
});

test("agent-session sync chunks oversized sessions and sends remaining chunks before dequeue", async () => {
  const source = new FakeSyncSource([makeOversizedSession("oversized")]);
  const sent: AgentSessionSyncBatch[] = [];
  const service = makeService(source, async (batch) => {
    sent.push(batch);
    return { accepted: true };
  });

  service.start();
  await flushAgentSessionSync();
  service.refresh();
  await flushAgentSessionSync();
  service.refresh();
  await flushAgentSessionSync();
  service.stop();

  assert.ok(sent.length >= 2, "expected oversized payload to be split");
  assert.ok(
    sent.every((batch) => batch.sessions.length === 1),
    "chunked batches carry one session chunk"
  );
  assert.ok(
    sent.every(
      (batch) =>
        estimateAgentSessionSyncBatchBytes(batch) <= SESSION_PAYLOAD_BYTE_CAP
    ),
    "every chunked batch stays under the payload cap"
  );
  assert.deepEqual(
    sent.map((batch) => batch.sessions[0].externalSessionId),
    Array.from({ length: sent.length }, () => "oversized")
  );
});

test("ISS-4578 (P1 #11): a transport throw while draining the pending chunk tail discards the tail so the session re-prepares from chunk 0", async () => {
  // Regression for the throw-during-drain tail-discard (c319ea36d). An oversized
  // session sends chunk 0 on the first tick and pins its remaining chunks in the
  // pending tail. If a transport throw strikes while draining that already-open
  // tail, the shifted chunk is gone from memory — continuing the tail on later
  // ticks would dequeue the session with that chunk permanently missing from the
  // cloud tiling. The fix discards the whole remaining tail so the session
  // re-prepares from chunk 0. This test would fail if the tail were kept: the
  // re-prepared sequence would resume mid-tail (no fresh chunk 0), not restart.
  // A session large enough to split into 3+ chunks, so the throw can strike an
  // INTERIOR (non-last) drain chunk — the case the discard actually protects. A
  // 2-chunk session's last-chunk clear already nulls the tail before the send, so
  // the discard would be a no-op there and could not distinguish the regression.
  const bigEvents = Array.from({ length: 12_000 }, (_, index) => ({
    externalEventId: `oversized-event-${index}`,
    eventType: "ToolUse",
    toolName: "Read",
    createdAt: "2026-06-08T12:00:00.000Z",
  }));
  const source = new FakeSyncSource([
    makeSyncedSession("oversized", "2026-06-08T12:00:00.000Z", bigEvents),
  ]);
  // Every send ATTEMPT's chunk index, in order (including the one that throws),
  // plus whether it threw — so we can pin the exact recovery step after the throw.
  const attempts: { index: number; threw: boolean }[] = [];
  const sent: AgentSessionSyncBatch[] = [];
  let hasThrownOnce = false;
  const service = makeService(source, async (batch) => {
    // Throw exactly once, on the FIRST INTERIOR drain chunk (index 1) — NOT the
    // opening chunk 0 and NOT the last chunk. This strands a shifted interior
    // chunk in the pending tail; without the discard the next tick would resume
    // that stale tail (skipping the shifted chunk) instead of re-preparing.
    const chunkIndex = batch.sessions[0]?.chunk?.index ?? 0;
    if (!hasThrownOnce && chunkIndex === 1) {
      hasThrownOnce = true;
      attempts.push({ index: chunkIndex, threw: true });
      throw new Error("socket dropped mid-drain");
    }
    attempts.push({ index: chunkIndex, threw: false });
    sent.push(batch);
    return { accepted: true };
  });

  service.start();
  // Tick 1: sends chunk 0, pins the tail, then drains — the first drained chunk
  // throws, discarding the remaining tail.
  await flushAgentSessionSync();
  // Subsequent ticks: re-prepare + re-send the whole session from chunk 0.
  for (let tick = 0; tick < 10; tick++) {
    service.refresh();
    await flushAgentSessionSync();
  }
  service.stop();

  assert.ok(hasThrownOnce, "the drain throw must have fired");
  const throwAt = attempts.findIndex((attempt) => attempt.threw);
  assert.ok(throwAt >= 0, "an attempt must have thrown");
  // MUTATION-CRITICAL: the FIRST send attempt AFTER the throw must be a fresh
  // chunk 0 (a full re-prepare). If the discard were removed, the stranded
  // pending tail would instead RESUME mid-sequence — the next attempt would be
  // chunk index > 0 — permanently skipping the chunk the throw shifted off.
  const nextAfterThrow = attempts[throwAt + 1];
  assert.ok(nextAfterThrow, "the session must retry after the drain throw");
  assert.equal(
    nextAfterThrow.index,
    0,
    "the first attempt after the drain throw restarts from chunk 0 (tail discarded), not a mid-tail resume"
  );
  // And the full event set is delivered across the successful sends of the final
  // (re-prepared) sequence — no chunk permanently lost.
  const finalSequenceStart = sent.findLastIndex(
    (batch) => (batch.sessions[0]?.chunk?.index ?? 0) === 0
  );
  const deliveredEventIds = new Set(
    sent
      .slice(finalSequenceStart)
      .flatMap((batch) =>
        batch.sessions[0].events.map((event) => event.externalEventId)
      )
  );
  assert.equal(
    deliveredEventIds.size,
    12_000,
    "the re-prepared sequence delivers every event — no chunk permanently dropped"
  );
});

test("ISS-4578 (shafty023 P1): an activity-chunking capability downgrade between prep and send defers the batch (no partial tiling shipped)", async () => {
  // The activity-chunking capability is captured at the top of the tick, then the
  // service awaits hydration + payload prep. If the socket reconnected to an OLDER
  // server (one that REPLACE-ALLs the tiling per chunk) during those awaits,
  // sending chunk 0 of a split tiling would leave that server holding a PARTIAL
  // tiling. The mid-tick recheck must DEFER the send (candidates stay queued for a
  // fresh whole-tiling re-prepare), exactly like the gzip freshness guard. This
  // test would fail without the recheck: the split chunk 0 would post.
  const session = makeSessionWithLargeTiling("chunk-tiling");
  const source = new FakeSyncSource([session]);
  const sent: AgentSessionSyncBatch[] = [];
  // Advertise activity chunking on the FIRST read (top-of-tick capture) so the
  // chunker paginates the tiling, then DOWNGRADE for every read after — the
  // pre-send recheck sees the downgrade and must skip.
  let activityChunkingReads = 0;
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    isSyncActivityChunkingSupported: () => {
      activityChunkingReads += 1;
      return activityChunkingReads === 1;
    },
    sendBatch: async (batch) => {
      sent.push(batch);
      return { accepted: true };
    },
  });

  service.start();
  await flushAgentSessionSync();
  service.refresh();
  await flushAgentSessionSync();
  service.stop();

  assert.ok(
    activityChunkingReads >= 2,
    "the capability must be re-read after prep, not only captured once"
  );
  assert.equal(
    sent.length,
    0,
    "a downgrade between prep and send must DEFER the activity-chunked batch, not ship a partial tiling"
  );
});

test("agent-session sync dead-letters unchunkable oversized sessions locally", async () => {
  const source = new FakeSyncSource([
    makeUnchunkableOversizedSession("oversized", "2026-06-08T12:01:00.000Z"),
    makeSyncedSession("healthy-session", "2026-06-08T12:00:00.000Z"),
  ]);
  const sent: AgentSessionSyncBatch[] = [];
  const service = makeService(source, async (batch) => {
    sent.push(batch);
    return { accepted: true };
  });

  service.start();
  for (let i = 0; i < 3; i += 1) {
    service.refresh();
    await flushAgentSessionSync();
  }
  service.stop();

  assert.equal(sent.length, 1);
  assert.deepEqual(
    sent[0].sessions.map((session) => session.externalSessionId),
    ["healthy-session"]
  );
  assert.deepEqual(source.loadSyncedSessionIds, [["healthy-session"]]);
  assert.ok(
    estimateAgentSessionSyncBatchBytes(sent[0]) <= SESSION_PAYLOAD_BYTE_CAP
  );
});

test("FEA-2718: does not skip a session the retired unhydratable gate would have flagged", async () => {
  // The sync path now hydrates with `omitEventData`, so raw event `data` size no
  // longer risks a hydration crash. A source that still exposes the old
  // raw-event-`data` gate must never have it consulted, and a session with a slim
  // payload must sync instead of being dead-lettered by it.
  const source = new UnhydratableFlaggingSyncSource([
    makeSyncedSession("big-events-slim-metadata", "2026-06-08T12:00:00.000Z"),
  ]);
  const sent: AgentSessionSyncBatch[] = [];
  const service = makeService(source, async (batch) => {
    sent.push(batch);
    return { accepted: true };
  });

  service.start();
  for (let i = 0; i < 3; i += 1) {
    service.refresh();
    await flushAgentSessionSync();
  }
  service.stop();

  assert.equal(
    source.findLocallyUnhydratableCallCount,
    0,
    "the retired raw-event-data unhydratable gate must never be consulted"
  );
  assert.deepEqual(
    sent.flatMap((batch) =>
      batch.sessions.map((session) => session.externalSessionId)
    ),
    ["big-events-slim-metadata"],
    "the session syncs instead of being dead-lettered by the removed gate"
  );
});

test("FEA-3287: withholds an idle (phantom) session from cloud sync without dead-lettering it", async () => {
  // A session the desktop live-hook minted on SessionStart with no real
  // turn/token/tool-use must NOT be uploaded — it is a phantom. It is also NOT
  // dead-lettered (that would suppress a later, legitimate sync once it gains
  // activity): it is simply deferred out of the queue, and the cursor advances.
  const source = new FakeSyncSource([
    makeIdleSession("phantom-1", "2026-06-08T12:01:00.000Z"),
  ]);
  const sent: AgentSessionSyncBatch[] = [];
  const service = makeService(source, async (batch) => {
    sent.push(batch);
    return { accepted: true };
  });

  service.start();
  await flushAgentSessionSync();
  service.stop();

  assert.equal(sent.length, 0, "no phantom session is ever uploaded");
  assert.equal(
    service.getSyncProgress().deadLetteredSessions,
    0,
    "a deferred phantom is not dead-lettered"
  );
});

test("FEA-3287: uploads only the substantive sessions from a mixed batch", async () => {
  // A real session (tokens/turns/tool-use) rides in the same cursor pass as
  // phantom rows. Only the substantive one is uploaded; the phantoms are
  // withheld at the source, so nothing empty reaches the cloud.
  const source = new FakeSyncSource([
    makeIdleSession("phantom-a", "2026-06-08T12:01:00.000Z"),
    makeSyncedSession("real-session", "2026-06-08T12:02:00.000Z"),
    makeIdleSession("phantom-b", "2026-06-08T12:03:00.000Z"),
  ]);
  const sent: AgentSessionSyncBatch[] = [];
  const service = makeService(source, async (batch) => {
    sent.push(batch);
    return { accepted: true };
  });

  service.start();
  for (let i = 0; i < 3; i += 1) {
    service.refresh();
    await flushAgentSessionSync();
  }
  service.stop();

  assert.deepEqual(
    sent.flatMap((batch) =>
      batch.sessions.map((session) => session.externalSessionId)
    ),
    ["real-session"],
    "only the substantive session uploads; phantoms are withheld"
  );
  assert.equal(
    service.getSyncProgress().deadLetteredSessions,
    0,
    "withheld phantoms are deferred, not dead-lettered"
  );
});

test("FEA-3287: a deferred phantom syncs once it becomes substantive (no data loss)", async () => {
  // The safety guarantee: deferring a phantom must never lose a real session.
  // When the withheld session later gains a real token (its updated_at bumps),
  // it re-enters the incremental cursor and uploads normally.
  const source = new FakeSyncSource([
    makeIdleSession("late-bloomer", "2026-06-08T12:01:00.000Z"),
  ]);
  const sent: AgentSessionSyncBatch[] = [];
  const service = makeService(source, async (batch) => {
    sent.push(batch);
    return { accepted: true };
  });

  service.start();
  await flushAgentSessionSync();
  assert.equal(sent.length, 0, "the phantom is withheld while idle");

  // The live hook records a real turn/token and bumps updated_at.
  source.upsert(makeSyncedSession("late-bloomer", "2026-06-08T12:05:00.000Z"));
  service.refresh();
  await flushAgentSessionSync();
  service.refresh();
  await flushAgentSessionSync();
  service.stop();

  assert.deepEqual(
    sent.flatMap((batch) =>
      batch.sessions.map((session) => session.externalSessionId)
    ),
    ["late-bloomer"],
    "the now-substantive session re-enters the cursor and uploads"
  );
  assert.equal(
    service.getSyncProgress().deadLetteredSessions,
    0,
    "it was never dead-lettered, so the later sync is not suppressed"
  );
});

test("FEA-1995: accepted batch emits one success sync.* event with latency", async () => {
  const source = new FakeSyncSource([
    makeSyncedSession("session-1", "2026-06-08T12:00:00.000Z"),
  ]);
  const sync: DesktopSyncBatchEventInput[] = [];
  const service = makeServiceCapturingSyncTelemetry(
    source,
    async () => ({ accepted: true }),
    { sync }
  );

  service.start();
  for (let i = 0; i < 3; i += 1) {
    await flushAgentSessionSync();
  }
  service.stop();

  assert.equal(sync.length, 1);
  assert.equal(sync[0].outcome, DesktopSyncBatchOutcome.Success);
  assert.ok(
    typeof sync[0].payloadBytes === "number" && sync[0].payloadBytes > 0,
    "success event carries a positive payload byte count"
  );
  assert.ok(
    typeof sync[0].latencyMs === "number" && sync[0].latencyMs >= 0,
    "success event carries a non-negative latency"
  );
  // FEA-3426: a success carries no failure reason.
  assert.equal(sync[0].reason, undefined);
  assert.deepEqual(leakedSyncTelemetryKeys(sync), []);
});

test("FEA-1995: transient (sub-threshold) ack failure emits a failure outcome and keeps PostHog path", async () => {
  const source = new FakeSyncSource([
    makeSyncedSession("session-1", "2026-06-08T12:00:00.000Z"),
  ]);
  const sync: DesktopSyncBatchEventInput[] = [];
  let postHogFailures = 0;
  const service = makeServiceCapturingSyncTelemetry(
    source,
    async () => ({
      accepted: false,
      reason: DesktopAgentSessionsAckReason.AckTimeout,
    }),
    {
      sync,
      batchOutcome: () => {
        postHogFailures += 1;
      },
    }
  );

  service.start();
  await flushAgentSessionSync();
  service.stop();

  // One timeout is below MAX_CONSECUTIVE_TIMEOUTS → retryable, not dead-lettered.
  assert.equal(sync.length, 1);
  assert.equal(sync[0].outcome, DesktopSyncBatchOutcome.Failure);
  assert.ok(
    typeof sync[0].latencyMs === "number" && sync[0].latencyMs >= 0,
    "failure event carries a measured latency"
  );
  // FEA-3426: the server ack reason is surfaced on the transport-health event.
  // This one line exercises the `reason: ack.reason` passthrough shared by every
  // server-ack reason (rate_limited / ingestion_failed / validation_failed /
  // feature_disabled all flow through the same emit).
  assert.equal(sync[0].reason, DesktopAgentSessionsAckReason.AckTimeout);
  // The pre-existing failure-only product-analytics path is unchanged.
  assert.equal(postHogFailures, 1);
  assert.deepEqual(leakedSyncTelemetryKeys(sync), []);
});

test("FEA-1995: repeated ack timeouts escalate to a dead_letter outcome", async () => {
  const source = new FakeSyncSource([
    makeSyncedSession("timeout-session", "2026-06-08T12:00:00.000Z"),
  ]);
  const sync: DesktopSyncBatchEventInput[] = [];
  const service = makeServiceCapturingSyncTelemetry(
    source,
    async () => ({
      accepted: false,
      reason: DesktopAgentSessionsAckReason.AckTimeout,
    }),
    { sync }
  );

  service.start();
  await flushAgentSessionSync();
  for (let i = 1; i < MAX_CONSECUTIVE_TIMEOUTS; i += 1) {
    service.refresh();
    await flushAgentSessionSync();
  }
  service.stop();

  assert.equal(sync.length, MAX_CONSECUTIVE_TIMEOUTS);
  // Sub-threshold attempts report failure; the threshold attempt dead-letters.
  assert.deepEqual(
    sync.map((event) => event.outcome),
    [
      ...Array.from(
        { length: MAX_CONSECUTIVE_TIMEOUTS - 1 },
        () => DesktopSyncBatchOutcome.Failure
      ),
      DesktopSyncBatchOutcome.DeadLetter,
    ]
  );
  // FEA-3426: every attempt — sub-threshold failures and the dead_letter — carries
  // the ack_timeout reason (the dead_letter path also reads `ack.reason`).
  assert.deepEqual(
    sync.map((event) => event.reason),
    Array.from(
      { length: MAX_CONSECUTIVE_TIMEOUTS },
      () => DesktopAgentSessionsAckReason.AckTimeout
    )
  );
  assert.deepEqual(leakedSyncTelemetryKeys(sync), []);
});

test("FEA-1995: locally oversized session emits dead_letter with payload but no latency", async () => {
  const source = new FakeSyncSource([
    makeUnchunkableOversizedSession("oversized", "2026-06-08T12:01:00.000Z"),
    makeSyncedSession("healthy-session", "2026-06-08T12:00:00.000Z"),
  ]);
  const sync: DesktopSyncBatchEventInput[] = [];
  const service = makeServiceCapturingSyncTelemetry(
    source,
    async () => ({ accepted: true }),
    { sync }
  );

  service.start();
  for (let i = 0; i < 3; i += 1) {
    service.refresh();
    await flushAgentSessionSync();
  }
  service.stop();

  const deadLetters = sync.filter(
    (event) => event.outcome === DesktopSyncBatchOutcome.DeadLetter
  );
  assert.ok(
    deadLetters.length >= 1,
    "the oversized local session dead-letters"
  );
  for (const deadLetter of deadLetters) {
    assert.equal(
      deadLetter.latencyMs,
      undefined,
      "pre-send dead-letter omits latency"
    );
    assert.equal(
      deadLetter.reason,
      "locally_oversized",
      "FEA-3426: an over-cap-after-chunking drop reports locally_oversized"
    );
    assert.ok(
      typeof deadLetter.payloadBytes === "number",
      "dead-letter still reports the offending payload size"
    );
  }
  // The healthy session that did send produces a separate success event.
  assert.ok(
    sync.some((event) => event.outcome === DesktopSyncBatchOutcome.Success)
  );
  assert.deepEqual(leakedSyncTelemetryKeys(sync), []);
});

test("FEA-4014: a session whose payload prep hangs/times out is bounded and dead-lettered, not retried forever", async () => {
  // Regression for the startup-sync stall ("hangs at 5/13, never completes"). The
  // production preparer runs in a worker thread; a hung worker used to leave the
  // prepare promise pending forever, pinning the service's `syncing` single-flight
  // guard so every later tick early-returned and NO session could advance OR
  // dead-letter. The worker runner now rejects on a bounded timeout, and the
  // service routes that prep throw through the bounded transport-error budget
  // (FEA-3364's pre-send twin). Prove: the un-preparable session throws a bounded
  // number of times, then dead-letters, and the queue drains (never freezes).
  const source = new FakeSyncSource([
    makeSyncedSession("stuck-prep-session", "2026-06-08T12:00:00.000Z"),
  ]);
  const sync: DesktopSyncBatchEventInput[] = [];
  let prepAttempts = 0;
  let sendAttempts = 0;
  const preparePayloads: AgentSessionPayloadPreparer = () => {
    prepAttempts += 1;
    // The worker-runner timeout rejection — a transient hang, NOT a local
    // serialization bug, so it earns the bounded retry budget rather than an
    // immediate dead-letter.
    return Promise.reject(
      new Error("agent-session payload worker timed out after 30000ms")
    );
  };
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    preparePayloads,
    sendBatch: async () => {
      sendAttempts += 1;
      return { accepted: true };
    },
    onSyncBatchTelemetry: (event) => {
      sync.push(event);
    },
  });

  service.start();
  await flushAgentSessionSync();
  // Re-attempt until the per-session prep-error budget is exhausted.
  for (let i = 1; i < MAX_CONSECUTIVE_TRANSPORT_ERRORS; i += 1) {
    service.refresh();
    await flushAgentSessionSync();
  }

  // Bounded, not infinite: prep threw exactly MAX times before the dead-letter.
  assert.equal(
    prepAttempts,
    MAX_CONSECUTIVE_TRANSPORT_ERRORS,
    "a hung/timed-out prep is bounded — it does not throw forever"
  );
  assert.equal(
    sendAttempts,
    0,
    "a batch whose prep never completes is never sent"
  );
  assert.equal(
    service.getSyncProgress().deadLetteredSessions,
    1,
    "the un-preparable session is dead-lettered once the budget is reached"
  );
  // The queue drained past the stuck item — neither lane is frozen holding it
  // (asserted before stop(), which resets source-derived state).
  assert.equal(service.getSyncProgress().pendingIncrementalSessions, 0);
  assert.equal(service.getSyncProgress().pendingBackfillSessions, 0);
  service.stop();

  // Sub-threshold prep throws report failure; the threshold throw dead-letters.
  assert.deepEqual(
    sync.map((event) => event.outcome),
    [
      ...Array.from(
        { length: MAX_CONSECUTIVE_TRANSPORT_ERRORS - 1 },
        () => DesktopSyncBatchOutcome.Failure
      ),
      DesktopSyncBatchOutcome.DeadLetter,
    ]
  );
  assert.deepEqual(leakedSyncTelemetryKeys(sync), []);
});

test("FEA-4014: one session's prep failure dead-letters only the offender, not its healthy batch siblings", async () => {
  // Regression: preparePayloads serializes the whole candidate batch in one
  // round-trip, so one pathological session rejects the entire batch. The old
  // path charged that rejection against EVERY candidate id, so a single offender
  // could dead-letter its healthy neighbors after the consecutive-error budget.
  // Now a batch failure falls back to per-session prep so only the offender burns
  // budget; the healthy siblings still upload this pass.
  const source = new FakeSyncSource([
    makeSyncedSession("healthy-session", "2026-06-08T12:01:00.000Z"),
    makeSyncedSession("stuck-session", "2026-06-08T12:02:00.000Z"),
  ]);
  const sentSessionIds: string[] = [];
  const preparePayloads: AgentSessionPayloadPreparer = async (sessions) => {
    // The whole-batch attempt (both sessions) and any per-session attempt for
    // "stuck-session" reject with a transient worker timeout; a lone
    // "healthy-session" prepares normally.
    const stuck = sessions.some(
      (session) => session.externalSessionId === "stuck-session"
    );
    if (stuck) {
      throw new Error("agent-session payload worker timed out after 30000ms");
    }
    return sessions.map((session) => ({
      kind: "session",
      session,
      payloadBytes: Buffer.byteLength(JSON.stringify(session)),
    }));
  };
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    preparePayloads,
    sendBatch: async (batch) => {
      for (const session of batch.sessions) {
        sentSessionIds.push(session.externalSessionId);
      }
      return { accepted: true };
    },
  });

  service.start();
  await flushAgentSessionSync();
  // Drive the stuck session through its bounded budget.
  for (let i = 1; i < MAX_CONSECUTIVE_TRANSPORT_ERRORS; i += 1) {
    service.refresh();
    await flushAgentSessionSync();
  }
  for (let i = 0; i < 3; i += 1) {
    service.refresh();
    await flushAgentSessionSync();
  }

  // The healthy sibling uploaded (exactly once — it is not re-charged by the
  // offender), and only the stuck session dead-lettered.
  assert.deepEqual(
    sentSessionIds,
    ["healthy-session"],
    "the healthy sibling is uploaded, never dead-lettered with the offender"
  );
  assert.equal(
    service.getSyncProgress().deadLetteredSessions,
    1,
    "only the offending session is dead-lettered"
  );
  assert.equal(service.getSyncProgress().pendingBackfillSessions, 0);
  service.stop();
});

test("FEA-3364: a persistently throwing transport send is bounded and dead-lettered instead of retrying forever", async () => {
  // Regression: before FEA-3364 a THROWN sendBatch (dropped socket /
  // serialization failure) incremented no counter — the batch stayed queued at
  // retry-count 0 and re-sent every 5s forever. A transient socket throw now
  // earns a bounded per-session retry budget before being dead-lettered.
  const source = new FakeSyncSource([
    makeSyncedSession("transport-session", "2026-06-08T12:00:00.000Z"),
  ]);
  const sync: DesktopSyncBatchEventInput[] = [];
  let sendAttempts = 0;
  const service = makeServiceCapturingSyncTelemetry(
    source,
    async () => {
      sendAttempts += 1;
      // A transient socket error (connection torn down mid-emit), NOT a
      // serialization bug — so it earns the bounded retry budget.
      throw new Error("socket hang up");
    },
    { sync }
  );

  service.start();
  await flushAgentSessionSync();
  // Re-attempt until the per-session transport-error budget is exhausted.
  for (let i = 1; i < MAX_CONSECUTIVE_TRANSPORT_ERRORS; i += 1) {
    service.refresh();
    await flushAgentSessionSync();
  }

  // Bounded: exactly MAX attempts, then the session is dead-lettered.
  assert.equal(sendAttempts, MAX_CONSECUTIVE_TRANSPORT_ERRORS);
  assert.equal(
    service.getSyncProgress().deadLetteredSessions,
    1,
    "the batch is dead-lettered once the transport-error threshold is reached"
  );

  // Sub-threshold throws report failure; the threshold throw dead-letters. Every
  // attempt carries the transport_error reason.
  assert.deepEqual(
    sync.map((event) => event.outcome),
    [
      ...Array.from(
        { length: MAX_CONSECUTIVE_TRANSPORT_ERRORS - 1 },
        () => DesktopSyncBatchOutcome.Failure
      ),
      DesktopSyncBatchOutcome.DeadLetter,
    ]
  );
  assert.deepEqual(
    sync.map((event) => event.reason),
    Array.from(
      { length: MAX_CONSECUTIVE_TRANSPORT_ERRORS },
      () => "transport_error"
    )
  );

  // The core regression: once dead-lettered (with a finite 24h retry-after), a
  // further tick does NOT re-send the batch — it no longer loops forever.
  service.refresh();
  await flushAgentSessionSync();
  service.stop();
  assert.equal(
    sendAttempts,
    MAX_CONSECUTIVE_TRANSPORT_ERRORS,
    "a dead-lettered transport batch is not re-sent on the next tick"
  );
  assert.deepEqual(leakedSyncTelemetryKeys(sync), []);
});

test("FEA-3364: a local serialization/prep throw is dead-lettered immediately", async () => {
  // A deterministic local encoder failure (the payload can never be serialized)
  // is a local bug: the identical batch would re-throw on every retry, so it is
  // dead-lettered on the FIRST throw rather than consuming the retry budget.
  const source = new FakeSyncSource([
    makeSyncedSession("serialize-session", "2026-06-08T12:00:00.000Z"),
  ]);
  const sync: DesktopSyncBatchEventInput[] = [];
  let sendAttempts = 0;
  const service = makeServiceCapturingSyncTelemetry(
    source,
    async () => {
      sendAttempts += 1;
      throw new TypeError("Converting circular structure to JSON");
    },
    { sync }
  );

  service.start();
  await flushAgentSessionSync();
  service.stop();

  // Immediate dead-letter: a single throw dead-letters without consuming the
  // MAX_CONSECUTIVE_TRANSPORT_ERRORS retry budget. (deadLetteredSessions is not
  // asserted here: a serialization failure is deterministic, so — like
  // validation_failed / locally_oversized — it is marked non-recoverable and may
  // be promoted back onto the backfill lane once per idle cycle. The single
  // dead_letter telemetry event below is the unambiguous proof it dead-lettered
  // on the first throw.)
  assert.equal(
    sendAttempts,
    1,
    "a serialization failure dead-letters on the first throw"
  );
  assert.deepEqual(
    sync.map((event) => event.outcome),
    [DesktopSyncBatchOutcome.DeadLetter]
  );
  assert.equal(sync[0].reason, "transport_error");
  assert.deepEqual(leakedSyncTelemetryKeys(sync), []);
});

test("FEA-3366: repeated validation_failed acks escalate to a dead_letter outcome", async () => {
  // FEA-3366: validation_failed now carries a small retry budget with backoff
  // (like ingestion_failed) instead of dead-lettering on the first failure. The
  // per-session counter trips at MAX_CONSECUTIVE_VALIDATION_FAILED → the final
  // event is dead_letter, the earlier deferred retries are failure.
  const source = new FakeSyncSource([
    makeSyncedSession("invalid-session", "2026-06-08T12:00:00.000Z"),
  ]);
  const sync: DesktopSyncBatchEventInput[] = [];
  const service = makeServiceCapturingSyncTelemetry(
    source,
    async () => ({
      accepted: false,
      reason: DesktopAgentSessionsAckReason.ValidationFailed,
    }),
    { sync }
  );

  await runWithMockedNow(async ({ advance }) => {
    service.start();
    await flushAgentSessionSync();
    for (let i = 1; i < MAX_CONSECUTIVE_VALIDATION_FAILED; i += 1) {
      advance(VALIDATION_FAILED_BACKOFF_MS + 1);
      service.refresh();
      await flushAgentSessionSync();
    }
  });
  service.stop();

  assert.equal(sync.length, MAX_CONSECUTIVE_VALIDATION_FAILED);
  assert.deepEqual(
    sync.map((event) => event.outcome),
    [
      ...Array.from(
        { length: MAX_CONSECUTIVE_VALIDATION_FAILED - 1 },
        () => DesktopSyncBatchOutcome.Failure
      ),
      DesktopSyncBatchOutcome.DeadLetter,
    ]
  );
  assert.deepEqual(leakedSyncTelemetryKeys(sync), []);
});

test("FEA-3366: a transient validation_failed recovers within the retry budget", async () => {
  // The whole point of the retry budget: a session that fails validation
  // transiently (a schema-deploy race, or a payload the next re-fetch fixes)
  // must reach the cloud without ever being dead-lettered, as long as it starts
  // validating before the budget is spent.
  const source = new FakeSyncSource([
    makeSyncedSession("flaky-session", "2026-06-08T12:00:00.000Z"),
  ]);
  let rejecting = true;
  const acceptedBatches: AgentSessionSyncTransportPayload[] = [];
  const service = makeService(source, async (batch) => {
    if (rejecting) {
      return {
        accepted: false,
        reason: DesktopAgentSessionsAckReason.ValidationFailed,
      };
    }
    acceptedBatches.push(batch);
    return { accepted: true };
  });

  await runWithMockedNow(async ({ advance }) => {
    service.start();
    await flushAgentSessionSync();
    // One failure short of the budget: still deferred, never dead-lettered.
    for (let i = 1; i < MAX_CONSECUTIVE_VALIDATION_FAILED; i += 1) {
      assert.equal(
        service.getSyncProgress().deadLetteredSessions,
        0,
        "the session is deferred, not dead-lettered, while the budget remains"
      );
      advance(VALIDATION_FAILED_BACKOFF_MS + 1);
      service.refresh();
      await flushAgentSessionSync();
    }
    // The validation issue clears; the next retry after backoff is accepted.
    rejecting = false;
    advance(VALIDATION_FAILED_BACKOFF_MS + 1);
    service.refresh();
    await flushAgentSessionSync();
  });
  service.stop();

  assert.equal(
    acceptedBatches.length,
    1,
    "the recovered session was re-sent and accepted by the cloud"
  );
  assert.deepEqual(
    acceptedBatches[0].sessions.map((session) => session.externalSessionId),
    ["flaky-session"]
  );
  assert.equal(
    service.getSyncProgress().deadLetteredSessions,
    0,
    "a session that recovers within its budget is never dead-lettered"
  );
});

test("FEA-1995: repeated rate_limited acks escalate to a dead_letter outcome", async () => {
  // The rate-limit trip is the third (and subtlest) dead_letter trigger: with
  // the relay healthy, the per-session counter trips at
  // MAX_CONSECUTIVE_RATE_LIMITED → the final event is dead_letter, earlier
  // events are failure. (The transport-down flap that deliberately never
  // dead-letters is a pre-existing FEA-1461 invariant covered separately.)
  const source = new FakeSyncSource([
    makeSyncedSession("rate-limited-session", "2026-06-08T12:00:00.000Z"),
  ]);
  const sync: DesktopSyncBatchEventInput[] = [];
  const service = makeServiceCapturingSyncTelemetry(
    source,
    async () => ({
      accepted: false,
      reason: DesktopAgentSessionsAckReason.RateLimited,
    }),
    { sync }
  );

  await runWithMockedNow(async ({ advance }) => {
    service.start();
    await flushAgentSessionSync();
    for (let i = 1; i < MAX_CONSECUTIVE_RATE_LIMITED; i += 1) {
      advance(RATE_LIMIT_BACKOFF_MS + 1);
      service.refresh();
      await flushAgentSessionSync();
    }
  });
  service.stop();

  assert.equal(sync.length, MAX_CONSECUTIVE_RATE_LIMITED);
  assert.deepEqual(
    sync.map((event) => event.outcome),
    [
      ...Array.from(
        { length: MAX_CONSECUTIVE_RATE_LIMITED - 1 },
        () => DesktopSyncBatchOutcome.Failure
      ),
      DesktopSyncBatchOutcome.DeadLetter,
    ]
  );
  assert.deepEqual(leakedSyncTelemetryKeys(sync), []);
});

test("FEA-3792: transport_unavailable acks defer forever and NEVER dead-letter (distinct from rate_limited)", async () => {
  // PRD-536 D9: the `RateLimited` ack reason used to be overloaded across a
  // genuine server throttle AND a local relay flap, and the service guessed
  // which via a racy post-hoc `isHttpReady()` re-read. The two causes are now
  // distinct ack reasons, so the classification is structural, not inferred:
  //
  //   - `RateLimited` (server throttle) dead-letters at MAX_CONSECUTIVE_RATE_LIMITED
  //     (asserted by the FEA-1995 test above).
  //   - `TransportUnavailable` (relay flap) must ALWAYS defer and never
  //     dead-letter — a run of disconnects must not burn a good session's budget.
  //
  // Critically, this holds even though the service's `isHttpReady()` reports
  // healthy (the default in this harness): the reason ALONE drives the outcome
  // now, so the old racy re-read can no longer misclassify a flap as a throttle.
  const source = new FakeSyncSource([
    makeSyncedSession("transport-flap-session", "2026-06-08T12:00:00.000Z"),
  ]);
  const sync: DesktopSyncBatchEventInput[] = [];
  const service = makeServiceCapturingSyncTelemetry(
    source,
    async () => ({
      accepted: false,
      reason: DesktopAgentSessionsAckReason.TransportUnavailable,
    }),
    { sync }
  );

  const attempts = MAX_CONSECUTIVE_RATE_LIMITED + 3;
  await runWithMockedNow(async ({ advance }) => {
    service.start();
    await flushAgentSessionSync();
    for (let i = 1; i < attempts; i += 1) {
      advance(RATE_LIMIT_BACKOFF_MS + 1);
      service.refresh();
      await flushAgentSessionSync();
    }
  });
  service.stop();

  // Every attempt — well past the rate-limit budget — is a plain `failure`; the
  // session is never dead-lettered by a transport flap.
  assert.equal(sync.length, attempts);
  assert.deepEqual(
    sync.map((event) => event.outcome),
    Array.from({ length: attempts }, () => DesktopSyncBatchOutcome.Failure)
  );
  assert.deepEqual(
    sync.map((event) => event.reason),
    Array.from(
      { length: attempts },
      () => DesktopAgentSessionsAckReason.TransportUnavailable
    )
  );
  assert.deepEqual(leakedSyncTelemetryKeys(sync), []);
});

test("FEA-3363: a dead-lettered session is re-enqueued after its retry-after window and reaches the cloud", async () => {
  // Regression for permanently-stranded dead-letters: a session that trips the
  // rate-limit dead-letter threshold used to sit in `deadLetteredIds` forever
  // with no in-session recovery path (only a cold-restart re-backfill could
  // retry it — which never happens on a long-running desktop). It must now
  // re-enqueue once its retry-after window elapses and reach the cloud.
  const source = new FakeSyncSource([
    makeSyncedSession("stranded-session", "2026-06-08T12:00:00.000Z"),
  ]);
  let rejecting = true;
  const acceptedBatches: AgentSessionSyncTransportPayload[] = [];
  const service = makeService(source, async (batch) => {
    if (rejecting) {
      return {
        accepted: false,
        reason: DesktopAgentSessionsAckReason.RateLimited,
      };
    }
    acceptedBatches.push(batch);
    return { accepted: true };
  });

  await runWithMockedNow(async ({ advance }) => {
    service.start();
    await flushAgentSessionSync();
    // Drive MAX_CONSECUTIVE_RATE_LIMITED consecutive rate-limit rejections so
    // the session dead-letters.
    for (let i = 1; i < MAX_CONSECUTIVE_RATE_LIMITED; i += 1) {
      advance(RATE_LIMIT_BACKOFF_MS + 1);
      service.refresh();
      await flushAgentSessionSync();
    }
    assert.equal(
      service.getSyncProgress().deadLetteredSessions,
      1,
      "the session is dead-lettered after the threshold is reached"
    );
    assert.equal(
      acceptedBatches.length,
      0,
      "no batch was ever accepted — the session is stranded"
    );

    // The relay recovers, but before the retry-after window elapses the session
    // must stay dead-lettered (no premature re-enqueue on every tick).
    rejecting = false;
    advance(RATE_LIMIT_BACKOFF_MS + 1);
    service.refresh();
    await flushAgentSessionSync();
    assert.equal(
      service.getSyncProgress().deadLetteredSessions,
      1,
      "the dead-letter is retained until its retry-after deadline"
    );
    assert.equal(acceptedBatches.length, 0);

    // Once the retry-after window elapses, the next tick re-enqueues the session
    // and it finally reaches the cloud. FEA-3795: the FIRST dead-letter of an id
    // uses the short progressive base window, not the flat 24h.
    advance(DEAD_LETTER_RETRY_BASE_MS + 1);
    service.refresh();
    await flushAgentSessionSync();
  });
  service.stop();

  assert.equal(
    acceptedBatches.length,
    1,
    "the recovered session was re-enqueued and accepted by the cloud"
  );
  assert.deepEqual(
    acceptedBatches[0].sessions.map((session) => session.externalSessionId),
    ["stranded-session"]
  );
  assert.equal(
    service.getSyncProgress().deadLetteredSessions,
    0,
    "recovery clears the dead-letter set once the session is accepted"
  );
});

test("FEA-3795: deadLetterRetryDelayMs is a capped, monotonically-growing progressive backoff schedule", () => {
  // PRD-536 E2: the flat 24h dead-letter window is replaced by progressive
  // backoff. The delay must (1) start at the short base, (2) strictly grow per
  // attempt while below the cap, (3) double each step, and (4) clamp at the 24h
  // cap and stay there forever without overflowing.
  assert.equal(
    deadLetterRetryDelayMs(1),
    DEAD_LETTER_RETRY_BASE_MS,
    "the first dead-letter uses the short base window (fast transient recovery)"
  );
  assert.equal(
    deadLetterRetryDelayMs(2),
    DEAD_LETTER_RETRY_BASE_MS * 2,
    "the second dead-letter of the same id doubles the window"
  );
  assert.equal(
    deadLetterRetryDelayMs(3),
    DEAD_LETTER_RETRY_BASE_MS * 4,
    "each subsequent dead-letter keeps doubling"
  );

  // Strictly increasing until the cap, then pinned at the cap.
  let reachedCap = false;
  let previous = 0;
  for (let count = 1; count <= 40; count += 1) {
    const delay = deadLetterRetryDelayMs(count);
    assert.ok(
      delay <= DEAD_LETTER_RETRY_MAX_MS,
      `attempt ${count} never exceeds the 24h cap`
    );
    if (delay === DEAD_LETTER_RETRY_MAX_MS) {
      reachedCap = true;
    } else {
      assert.ok(
        delay > previous,
        `attempt ${count} strictly grows over attempt ${count - 1} until the cap`
      );
    }
    // Monotonic non-decreasing across the whole schedule.
    assert.ok(delay >= previous, `attempt ${count} never regresses`);
    previous = delay;
  }
  assert.ok(reachedCap, "the schedule eventually reaches the 24h cap");
  assert.equal(
    deadLetterRetryDelayMs(1000),
    DEAD_LETTER_RETRY_MAX_MS,
    "a huge in-memory count stays clamped at the cap (no overflow to Infinity)"
  );
  // Defensive clamp: a non-positive count behaves like the first attempt.
  assert.equal(deadLetterRetryDelayMs(0), DEAD_LETTER_RETRY_BASE_MS);
  assert.equal(deadLetterRetryDelayMs(-5), DEAD_LETTER_RETRY_BASE_MS);
});

test("FEA-3795: a persistently-failing dead-letter escalates its retry window across recoveries (holding the escalation in-memory across in-process recovery)", async () => {
  // PRD-536 E2: a transient strand recovers fast (base window), but an id that
  // recovers and then re-fails must NOT reset to the base — it escalates to the
  // next (longer) window, so a persistent failure stops hammering the retry
  // path. The escalation is proven by TIMING: the first dead-letter recovers at
  // the base horizon; after it re-fails, the second dead-letter is still held at
  // the base horizon and only recovers once its longer (2x base) window elapses.
  const source = new FakeSyncSource([
    makeSyncedSession("flapping-session", "2026-06-08T12:00:00.000Z"),
  ]);
  let rejecting = true;
  const acceptedBatches: AgentSessionSyncTransportPayload[] = [];
  const service = makeService(source, async (batch) => {
    if (rejecting) {
      return {
        accepted: false,
        reason: DesktopAgentSessionsAckReason.RateLimited,
      };
    }
    acceptedBatches.push(batch);
    return { accepted: true };
  });

  // Drive MAX_CONSECUTIVE_RATE_LIMITED consecutive rate-limit rejections so the
  // session (re-)dead-letters. The caller's most recent send already counts as
  // failure #1, so this loop supplies the remaining budget.
  const driveToDeadLetter = async (advance: (ms: number) => void) => {
    for (let i = 1; i < MAX_CONSECUTIVE_RATE_LIMITED; i += 1) {
      advance(RATE_LIMIT_BACKOFF_MS + 1);
      service.refresh();
      await flushAgentSessionSync();
    }
    assert.equal(
      service.getSyncProgress().deadLetteredSessions,
      1,
      "the session is dead-lettered after exhausting the rate-limit budget"
    );
  };

  await runWithMockedNow(async ({ advance }) => {
    service.start();
    await flushAgentSessionSync();

    // First dead-letter → escalation position 1, short base window.
    await driveToDeadLetter(advance);

    // Below the base window: still held (no premature recovery on every tick).
    advance(DEAD_LETTER_RETRY_BASE_MS - 1000);
    service.refresh();
    await flushAgentSessionSync();
    assert.equal(
      service.getSyncProgress().deadLetteredSessions,
      1,
      "the first dead-letter is held for the short base window"
    );

    // Past the base window: it recovers, re-enters the queue, is re-sent (that
    // re-send is rate-limit failure #1), and re-dead-letters — now at position 2.
    advance(2000);
    service.refresh();
    await flushAgentSessionSync();
    await driveToDeadLetter(advance);

    // Escalation proof: the position-2 window is LONGER than the base. Advancing
    // just past the BASE horizon must NOT recover it (a flat/reset window would).
    advance(DEAD_LETTER_RETRY_BASE_MS + 1000);
    service.refresh();
    await flushAgentSessionSync();
    assert.equal(
      service.getSyncProgress().deadLetteredSessions,
      1,
      "the escalated window is longer than the base — still held past the base horizon"
    );

    // Now let the relay recover. Past the FULL escalated (2x base) window the
    // session re-enqueues and reaches the cloud, which clears the escalation.
    rejecting = false;
    advance(DEAD_LETTER_RETRY_BASE_MS * 2);
    service.refresh();
    await flushAgentSessionSync();
  });
  service.stop();

  assert.equal(
    acceptedBatches.length,
    1,
    "the flapping session eventually reached the cloud once the relay recovered"
  );
  assert.equal(
    service.getSyncProgress().deadLetteredSessions,
    0,
    "a verified ack clears the dead-letter and its escalation counter"
  );
});

test("FEA-3363/FEA-3366: a validation_failed (deterministic) dead-letter is NOT recovered by the retry-after clock", async () => {
  // Only TRANSIENT dead-letters (timeout/rate-limit/ingestion) carry a finite
  // retry-after and are re-enqueued by recoverExpiredDeadLetters when the clock
  // passes their deadline. A validation_failed rejection that keeps failing
  // across its whole FEA-3366 retry budget is a deterministic schema failure and
  // gets an INFINITE deadline, so advancing the clock — no matter how far —
  // never recovers it via the FEA-3363 retry-after path. (It is still eventually
  // revisited by the lowest-priority once-per-idle-cycle promotion; that path is
  // covered separately below.)
  let sendCount = 0;
  const source = new FakeSyncSource([
    makeSyncedSession("invalid-session", "2026-06-08T12:00:00.000Z"),
  ]);
  const service = makeService(source, async () => {
    sendCount += 1;
    return {
      accepted: false,
      reason: DesktopAgentSessionsAckReason.ValidationFailed,
    };
  });

  // Spend a full validation retry budget (backoff between each attempt) so the
  // session escalates from deferred to dead-lettered.
  const spendValidationBudget = async (advance: (ms: number) => void) => {
    for (let i = 1; i < MAX_CONSECUTIVE_VALIDATION_FAILED; i += 1) {
      advance(VALIDATION_FAILED_BACKOFF_MS + 1);
      service.refresh();
      await flushAgentSessionSync();
    }
  };

  await runWithMockedNow(async ({ advance }) => {
    service.start();
    await flushAgentSessionSync();
    await spendValidationBudget(advance);
    assert.equal(
      service.getSyncProgress().deadLetteredSessions,
      1,
      "validation_failed dead-letters once its retry budget is spent"
    );

    // Consume the single idle-cycle revisit AND let it re-spend a fresh budget so
    // the session returns to the dead-lettered state with the hot-loop guard
    // tripped — isolating the retry-after clock as the only remaining path.
    service.refresh();
    await flushAgentSessionSync();
    await spendValidationBudget(advance);
    assert.equal(
      service.getSyncProgress().deadLetteredSessions,
      1,
      "the revisited session re-dead-letters after re-spending its budget"
    );
    const sendsAfterIdleRevisit = sendCount;

    // Advancing well past the transient retry-after window must NOT re-enqueue a
    // deterministic (infinite-deadline) dead-letter: the idle revisit is guarded
    // for this cycle and the clock never touches it, so no further send attempts.
    advance(DEAD_LETTER_RETRY_MAX_MS * 3 + 1);
    service.refresh();
    await flushAgentSessionSync();
    service.refresh();
    await flushAgentSessionSync();

    assert.equal(
      sendCount,
      sendsAfterIdleRevisit,
      "the retry-after clock never re-sends a deterministic dead-letter"
    );
    assert.equal(
      service.getSyncProgress().deadLetteredSessions,
      1,
      "the validation_failed session stays dead-lettered between idle cycles"
    );
  });
  service.stop();
});

test("FEA-1995: repeated ingestion_failed acks escalate to a dead_letter outcome", async () => {
  const source = new FakeSyncSource([
    makeSyncedSession("ingestion-failed-session", "2026-06-08T12:00:00.000Z"),
  ]);
  const sync: DesktopSyncBatchEventInput[] = [];
  const service = makeServiceCapturingSyncTelemetry(
    source,
    async () => ({
      accepted: false,
      reason: DesktopAgentSessionsAckReason.IngestionFailed,
    }),
    { sync }
  );

  await runWithMockedNow(async ({ advance }) => {
    service.start();
    await flushAgentSessionSync();
    for (let i = 1; i < MAX_CONSECUTIVE_INGESTION_FAILED; i += 1) {
      advance(INGESTION_FAILED_BACKOFF_MS + 1);
      service.refresh();
      await flushAgentSessionSync();
    }
  });
  service.stop();

  assert.equal(sync.length, MAX_CONSECUTIVE_INGESTION_FAILED);
  assert.deepEqual(
    sync.map((event) => event.outcome),
    [
      ...Array.from(
        { length: MAX_CONSECUTIVE_INGESTION_FAILED - 1 },
        () => DesktopSyncBatchOutcome.Failure
      ),
      DesktopSyncBatchOutcome.DeadLetter,
    ]
  );
  assert.deepEqual(leakedSyncTelemetryKeys(sync), []);
});

test("FEA-1995: a thrown transport error emits a failure outcome", async () => {
  // A sendBatch throw (socket drop, serialization failure) is a real transport
  // failure the dashboard should count — it must not be swallowed silently.
  const source = new FakeSyncSource([
    makeSyncedSession("session-1", "2026-06-08T12:00:00.000Z"),
  ]);
  const sync: DesktopSyncBatchEventInput[] = [];
  const service = makeServiceCapturingSyncTelemetry(
    source,
    async () => {
      throw new Error("socket dropped mid-send");
    },
    { sync }
  );

  service.start();
  await flushAgentSessionSync();
  service.stop();

  assert.equal(sync.length, 1);
  assert.equal(sync[0].outcome, DesktopSyncBatchOutcome.Failure);
  assert.ok(
    typeof sync[0].payloadBytes === "number" && sync[0].payloadBytes > 0,
    "a thrown-transport failure still reports the attempted payload size"
  );
  assert.ok(
    typeof sync[0].latencyMs === "number" && sync[0].latencyMs >= 0,
    "a thrown-transport failure reports a measured latency"
  );
  // FEA-3426: a thrown send is reported with the transport_error reason.
  assert.equal(sync[0].reason, "transport_error");
  assert.deepEqual(leakedSyncTelemetryKeys(sync), []);
});

test("FEA-3426: an unhydratable (locally-deleted) session emits a dead_letter with reason unhydratable", async () => {
  // A session enqueued for backfill that is deleted before its batch hydrates
  // (`loadSyncedSessions` returns []) used to be dropped with NO sync.* telemetry,
  // so the SLO monitor never saw it. It now emits one dead_letter/unhydratable.
  const source = new ResettingSyncSource([
    makeSyncedSession("ghost", "2026-06-08T12:00:00.000Z"),
  ]);
  const sync: DesktopSyncBatchEventInput[] = [];
  const service = makeServiceCapturingSyncTelemetry(
    source,
    async () => ({ accepted: true }),
    { sync }
  );
  // Delete the only session on the load that would hydrate its batch, so
  // hydration returns [] and the unhydratable-drop branch runs.
  source.onLoad = () => {
    source.deleteSession("ghost");
  };

  service.start();
  await flushAgentSessionSync();
  service.stop();

  const deadLetters = sync.filter(
    (event) => event.outcome === DesktopSyncBatchOutcome.DeadLetter
  );
  assert.equal(
    deadLetters.length,
    1,
    "one dead_letter is emitted for the drop"
  );
  assert.equal(deadLetters[0].reason, "unhydratable");
  assert.equal(
    deadLetters[0].latencyMs,
    undefined,
    "nothing was sent → no latency"
  );
  assert.equal(
    deadLetters[0].payloadBytes,
    0,
    "no batch was ever built → zero payload bytes"
  );
  assert.deepEqual(leakedSyncTelemetryKeys(sync), []);
});

test("FEA-3426: multiple singleton unhydratable drops emit one dead_letter per operation", async () => {
  const source = new ResettingSyncSource([
    makeSyncedSession("ghost-a", "2026-06-08T12:00:00.000Z"),
    makeSyncedSession("ghost-b", "2026-06-08T12:00:01.000Z"),
  ]);
  const sync: DesktopSyncBatchEventInput[] = [];
  const service = makeServiceCapturingSyncTelemetry(
    source,
    async () => ({ accepted: true }),
    { sync }
  );
  source.onLoad = () => {
    source.deleteSession("ghost-a");
    source.deleteSession("ghost-b");
  };

  service.start();
  await flushAgentSessionSync();
  service.refresh();
  await flushAgentSessionSync();
  service.stop();

  const deadLetters = sync.filter(
    (event) => event.outcome === DesktopSyncBatchOutcome.DeadLetter
  );
  assert.ok(
    deadLetters.length >= 2,
    "both singleton drop operations emit dead_letter telemetry"
  );
  for (const deadLetter of deadLetters) {
    assert.equal(deadLetter.reason, "unhydratable");
  }
  assert.deepEqual(leakedSyncTelemetryKeys(sync), []);
});

test("agent-session sync compacts bulky metadata before chunking", () => {
  const prepared = prepareAgentSessionPayload(
    makeMetadataHeavyChunkCandidate("metadata-heavy"),
    maxSessionPayloadBytesForBatch(SESSION_PAYLOAD_BYTE_CAP)
  );

  assert.notEqual(prepared.kind, "dead-letter");
  if (prepared.kind !== "chunked") {
    assert.ok(prepared.payloadBytes <= SESSION_PAYLOAD_BYTE_CAP);
    return;
  }
  assert.ok(
    prepared.chunkCount < 20,
    `expected compacted metadata to avoid hundreds of chunks, got ${prepared.chunkCount}`
  );
  const chunks = [prepared.firstChunk, ...prepared.remainingChunks];
  assert.ok(
    chunks.every(
      (chunk) =>
        estimateAgentSessionSyncBatchBytes({
          schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
          batchId: "00000000-0000-4000-8000-000000000000",
          syncMode: AgentSessionSyncMode.Backfill,
          sessionCount: 1,
          sessions: [chunk],
        }) <= SESSION_PAYLOAD_BYTE_CAP
    )
  );
});

test("agent-session sync dead-letters a single event that cannot fit in a valid chunk", () => {
  const prepared = prepareAgentSessionPayload(
    makeUnchunkableOversizedSession(
      "single-huge-event",
      "2026-06-08T12:00:00.000Z"
    ),
    maxSessionPayloadBytesForBatch(SESSION_PAYLOAD_BYTE_CAP)
  );

  assert.equal(prepared.kind, "dead-letter");
});

test("FEA-3366: validation_failed retries with backoff but never permanently stalls the queue", async () => {
  const source = new FakeSyncSource([
    makeSyncedSession("invalid-session", "2026-06-08T12:00:00.000Z"),
  ]);
  let attempts = 0;
  const service = makeService(source, async () => {
    attempts += 1;
    return {
      accepted: false,
      reason: DesktopAgentSessionsAckReason.ValidationFailed,
    };
  });

  await runWithMockedNow(async ({ advance }) => {
    service.start();
    await flushAgentSessionSync();
    // FEA-3366: the row is deferred (not dead-lettered) on the first failure and
    // does NOT retry within the same tick — the backoff prevents a re-send every
    // 5s, so a persistently-invalid payload can never permanently stall the
    // queue while it retries.
    assert.equal(attempts, 1, "no same-tick retry of a validation_failed row");
    assert.equal(
      service.getSyncProgress().deadLetteredSessions,
      0,
      "the row is deferred for retry, not dead-lettered, on the first failure"
    );

    // Each backoff window allows exactly one more attempt; the retry budget is
    // bounded, so it dead-letters (set aside) instead of looping forever.
    for (let i = 1; i < MAX_CONSECUTIVE_VALIDATION_FAILED; i += 1) {
      advance(VALIDATION_FAILED_BACKOFF_MS + 1);
      service.refresh();
      await flushAgentSessionSync();
    }

    assert.equal(
      attempts,
      MAX_CONSECUTIVE_VALIDATION_FAILED,
      "the retry budget is bounded — one attempt per backoff window, then dead-letter"
    );
    assert.equal(
      service.getSyncProgress().deadLetteredSessions,
      1,
      "the exhausted validation_failed row is dead-lettered (set aside), not looped"
    );
  });
  service.stop();
});

test("agent-session sync dead-letters repeated ack timeouts", async () => {
  const source = new FakeSyncSource([
    makeSyncedSession("timeout-session", "2026-06-08T12:00:00.000Z"),
  ]);
  let attempts = 0;
  const service = makeService(source, async () => {
    attempts += 1;
    return {
      accepted: false,
      reason: DesktopAgentSessionsAckReason.AckTimeout,
    };
  });

  service.start();
  await flushAgentSessionSync();
  for (let i = 1; i < MAX_CONSECUTIVE_TIMEOUTS; i += 1) {
    service.refresh();
    await flushAgentSessionSync();
  }
  service.refresh();
  await flushAgentSessionSync();
  service.stop();

  assert.equal(attempts, MAX_CONSECUTIVE_TIMEOUTS);
});

test("agent-session sync dead-letters repeated server rate limits", async () => {
  const source = new FakeSyncSource([
    makeSyncedSession("rate-limited-session", "2026-06-08T12:00:00.000Z"),
  ]);
  let attempts = 0;
  const service = makeService(source, async () => {
    attempts += 1;
    return {
      accepted: false,
      reason: DesktopAgentSessionsAckReason.RateLimited,
    };
  });

  try {
    await runWithMockedNow(async ({ advance }) => {
      service.start();
      await flushAgentSessionSync();
      for (let i = 1; i < MAX_CONSECUTIVE_RATE_LIMITED; i += 1) {
        advance(RATE_LIMIT_BACKOFF_MS + 1);
        service.refresh();
        await flushAgentSessionSync();
      }
      advance(RATE_LIMIT_BACKOFF_MS + 1);
      service.refresh();
      await flushAgentSessionSync();
    });
  } finally {
    service.stop();
  }

  assert.equal(attempts, MAX_CONSECUTIVE_RATE_LIMITED);
});

test("agent-session sync dead-letters repeated ingestion failures", async () => {
  const source = new FakeSyncSource([
    makeSyncedSession("ingestion-failed-session", "2026-06-08T12:00:00.000Z"),
  ]);
  let attempts = 0;
  const service = makeService(source, async () => {
    attempts += 1;
    return {
      accepted: false,
      reason: DesktopAgentSessionsAckReason.IngestionFailed,
    };
  });

  try {
    await runWithMockedNow(async ({ advance }) => {
      service.start();
      await flushAgentSessionSync();
      for (let i = 1; i < MAX_CONSECUTIVE_INGESTION_FAILED; i += 1) {
        advance(INGESTION_FAILED_BACKOFF_MS + 1);
        service.refresh();
        await flushAgentSessionSync();
      }
      advance(INGESTION_FAILED_BACKOFF_MS + 1);
      service.refresh();
      await flushAgentSessionSync();
    });
  } finally {
    service.stop();
  }

  assert.equal(attempts, MAX_CONSECUTIVE_INGESTION_FAILED);
});

test("FEA-3659: a transient ingestion_failed retries with backoff (never dead-letters at attempt 0) and only dead-letters once the budget is exhausted", async () => {
  // Regression guard for the 179-row attempt_count=0 dead-letter burst: a
  // transient ingestion_failed must go through the durable retry/backoff path —
  // incrementing the persisted outbox attempt_count + stamping next_attempt_at —
  // and dead-letter ONLY after the retry budget is exhausted, never on the first
  // failure. Mirrors how rate_limited / ack_timeout already defer with an
  // in-memory backoff before dead-lettering (only ingestion_failed also persists
  // that backoff to the outbox today); validation_failed, by contrast, is
  // deterministic and dead-letters at attempt 0 with no retry.
  const TARGET = "target-ingestion-retry";
  const key = buildAgentSessionSyncSourceKey(TARGET);
  const source = new FakeSyncSource([
    makeSyncedSession("ingest-retry", "2026-06-08T12:00:00.000Z"),
  ]);
  const outboxRowFor = (id: string) =>
    [...source.outbox.values()].find((r) => r.sourceKey === key && r.id === id);
  const service = makeServiceWithIdentity(
    source,
    async () => ({
      accepted: false,
      reason: DesktopAgentSessionsAckReason.IngestionFailed,
    }),
    TARGET
  );

  try {
    await runWithMockedNow(async ({ advance }) => {
      service.start();
      await flushAgentSessionSync();

      // First failure: the row is deferred (retry), NOT dead-lettered, and the
      // durable outbox records attempt_count=1 with a next_attempt_at deadline.
      let row = outboxRowFor("ingest-retry");
      assert.equal(
        row?.status,
        "pending",
        "attempt 0 schedules a retry — the row stays pending, never dead-lettered"
      );
      assert.equal(
        row?.attemptCount,
        1,
        "first failure records attempt_count=1"
      );
      assert.equal(row?.reason, "ingestion_failed");
      assert.ok(
        row?.nextAttemptAt,
        "a deferred transient retry stamps a next_attempt_at backoff deadline"
      );

      // Drive the remaining consecutive failures up to (but not through) the
      // threshold: the outbox attempt_count grows and the row stays pending.
      for (
        let attempt = 2;
        attempt < MAX_CONSECUTIVE_INGESTION_FAILED;
        attempt += 1
      ) {
        advance(INGESTION_FAILED_BACKOFF_MS + 1);
        service.refresh();
        await flushAgentSessionSync();
        row = outboxRowFor("ingest-retry");
        assert.equal(
          row?.status,
          "pending",
          `attempt ${attempt - 1} still retries — not yet dead-lettered`
        );
        assert.equal(
          row?.attemptCount,
          attempt,
          `attempt_count grows to ${attempt}`
        );
      }

      // The threshold failure exhausts the budget → NOW it dead-letters, and the
      // persisted attempt_count reflects the exhausted budget (not 0).
      advance(INGESTION_FAILED_BACKOFF_MS + 1);
      service.refresh();
      await flushAgentSessionSync();
    });
  } finally {
    service.stop();
  }

  const finalRow = outboxRowFor("ingest-retry");
  assert.equal(
    finalRow?.status,
    "dead_lettered",
    "dead-letters only after the retry budget is exhausted"
  );
  assert.equal(
    finalRow?.attemptCount,
    MAX_CONSECUTIVE_INGESTION_FAILED,
    "the dead-lettered row records the real exhausted attempt_count, not a misleading 0"
  );
  assert.equal(finalRow?.reason, "ingestion_failed");
});

test("agent-session sync lets healthy siblings pass a rate-limited queue head", async () => {
  const source = new FakeSyncSource([
    makeSyncedSession("stuck-session", "2026-06-08T12:00:00.000Z"),
  ]);
  const accepted: string[] = [];
  const service = makeService(source, async (batch) => {
    const ids = batch.sessions.map((session) => session.externalSessionId);
    if (ids.includes("stuck-session")) {
      return {
        accepted: false,
        reason: DesktopAgentSessionsAckReason.RateLimited,
      };
    }
    accepted.push(...ids);
    return { accepted: true };
  });

  service.start();
  await flushAgentSessionSync();
  source.upsert(
    makeSyncedSession("healthy-session", "2026-06-08T12:05:00.000Z")
  );
  service.refresh();
  await flushAgentSessionSync();
  service.stop();

  assert.deepEqual(accepted, ["healthy-session"]);
});

test("agent-session sync picks up new sessions added at the current top timestamp", async () => {
  const topTimestamp = "2026-06-08T12:00:00.000Z";
  const source = new FakeSyncSource([
    makeSyncedSession("existing-a", topTimestamp),
    makeSyncedSession("existing-b", topTimestamp),
  ]);
  const sent: string[][] = [];
  const service = makeService(source, async (batch) => {
    sent.push(batch.sessions.map((session) => session.externalSessionId));
    return { accepted: true };
  });

  service.start();
  for (let i = 0; i < 2; i += 1) {
    service.refresh();
    await flushAgentSessionSync();
  }
  source.upsert(makeSyncedSession("new-at-top", topTimestamp));
  service.refresh();
  await flushAgentSessionSync();
  service.refresh();
  await flushAgentSessionSync();
  service.stop();

  // ISS-5988 (byte-budgeted batching): the initial backfill ships both existing
  // tied-top sessions in ONE packed batch; the genuinely-new sibling that lands
  // later at the same top timestamp is still selected (and ONLY it — the seen
  // cluster is not re-emitted).
  assert.deepEqual(sent, [["existing-b", "existing-a"], ["new-at-top"]]);
});

test("agent-session sync can defer historical backfill while keeping incremental sync live", async () => {
  const topTimestamp = "2026-06-08T12:00:00.000Z";
  const source = new FakeSyncSource([
    makeSyncedSession("existing-a", topTimestamp),
    makeSyncedSession("existing-b", topTimestamp),
  ]);
  const sent: string[][] = [];
  const service = makeService(source, async (batch) => {
    sent.push(batch.sessions.map((session) => session.externalSessionId));
    return { accepted: true };
  });

  service.start({ historicalBackfill: false });
  await flushAgentSessionSync();
  assert.deepEqual(sent, []);
  assert.equal(source.listAllCursorCallCount, 0);
  assert.equal(source.listTopCursorCallCount, 1);

  source.upsert(makeSyncedSession("new-at-top", topTimestamp));
  service.refresh();
  await flushAgentSessionSync();
  service.stop();

  assert.deepEqual(sent, [["new-at-top"]]);
});

test("agent-session sync does not persist a cursor while historical backfill is deferred", async () => {
  const topTimestamp = "2026-06-08T12:00:00.000Z";
  const source = new FakeSyncSource([
    makeSyncedSession("existing-a", "2026-06-08T11:59:00.000Z"),
    makeSyncedSession("existing-b", topTimestamp),
  ]);
  const sent: string[][] = [];
  const service = makeServiceWithIdentity(
    source,
    async (batch) => {
      sent.push(batch.sessions.map((session) => session.externalSessionId));
      return { accepted: true };
    },
    "target-a"
  );

  service.start({ historicalBackfill: false });
  await flushAgentSessionSync();
  source.upsert(makeSyncedSession("new-after-top", "2026-06-08T12:01:00.000Z"));
  service.refresh();
  await flushAgentSessionSync();
  service.stop();

  assert.deepEqual(sent, [["new-after-top"]]);
  assert.equal(
    source.advanceCalls.length,
    0,
    "deferred historical mode must not persist a cursor that skips older local sessions"
  );
});

test("agent-session sync waits for the background scheduler before reading source data", async () => {
  const source = new FakeSyncSource([
    makeSyncedSession("scheduled-session", "2026-06-08T12:00:00.000Z"),
  ]);
  const sent: AgentSessionSyncBatch[] = [];
  let releaseScheduler: () => void = () => undefined;
  const schedulerReleased = new Promise<void>((resolve) => {
    releaseScheduler = resolve;
  });
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    waitForBackgroundSlot: () => schedulerReleased,
    sendBatch: async (batch) => {
      sent.push(batch);
      return { accepted: true };
    },
  });

  service.start();
  await flushAgentSessionSync();
  assert.equal(source.listAllCursorCallCount, 0);
  assert.equal(sent.length, 0);

  releaseScheduler();
  await flushAgentSessionSync();
  service.stop();

  assert.equal(source.listAllCursorCallCount, 1);
  assert.deepEqual(
    sent[0].sessions.map((session) => session.externalSessionId),
    ["scheduled-session"]
  );
});

test("agent-session sync delegates payload shaping to the configured preparer", async () => {
  const source = new FakeSyncSource([
    makeSyncedSession("worker-prepared", "2026-06-08T12:00:00.000Z"),
  ]);
  const sent: AgentSessionSyncBatch[] = [];
  let prepareCallCount = 0;
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    preparePayloads: async (sessions) => {
      prepareCallCount += 1;
      return sessions.map((session) => ({
        kind: "session",
        session: { ...session, name: "prepared off main" },
        payloadBytes: Buffer.byteLength(JSON.stringify(session)),
      }));
    },
    sendBatch: async (batch) => {
      sent.push(batch);
      return { accepted: true };
    },
  });

  service.start();
  await flushAgentSessionSync();
  service.stop();

  assert.equal(prepareCallCount, 1);
  assert.equal(sent[0].sessions[0].name, "prepared off main");
});

test("agent-session sync pauses after feature_disabled until relay reconnects", async () => {
  const source = new FakeSyncSource([
    makeSyncedSession("feature-disabled-session", "2026-06-08T12:00:00.000Z"),
  ]);
  let relayReady = true;
  let attempts = 0;
  const service = new AgentSessionSyncService({
    isHttpReady: () => relayReady,
    getSource: () => source,
    sendBatch: async () => {
      attempts += 1;
      return attempts === 1
        ? {
            accepted: false,
            reason: DesktopAgentSessionsAckReason.FeatureDisabled,
          }
        : { accepted: true };
    },
  });

  service.start();
  await flushAgentSessionSync();
  service.refresh();
  await flushAgentSessionSync();
  assert.equal(attempts, 1);

  relayReady = false;
  service.refresh();
  await flushAgentSessionSync();
  relayReady = true;
  service.refresh();
  await flushAgentSessionSync();
  service.stop();

  assert.equal(attempts, 2);
});

// PRD-532 §7: sync-observability consent tier gates the session-metadata lane.
// Fix-forward for the #2985 P1 — the chosen tier was a no-op. When the tier
// (via `isCloudSyncTierAllowed`) says cloud sync is not permitted, shouldRun()
// must return false and NO batch is sent, even though every other precondition
// (agent monitor enabled, relay ready) is satisfied.

test("agent-session sync is suppressed when the consent tier disallows cloud sync", async () => {
  const source = new FakeSyncSource([
    makeSyncedSession("consent-blocked", "2026-06-08T12:00:00.000Z"),
  ]);
  const sent: AgentSessionSyncBatch[] = [];
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    // Tier says local-only / not-yet-consented → cloud sync must be suppressed.
    isCloudSyncTierAllowed: () => false,
    getSource: () => source,
    sendBatch: async (batch) => {
      sent.push(batch);
      return { accepted: true };
    },
  });

  service.start();
  await flushAgentSessionSync();
  service.refresh();
  await flushAgentSessionSync();
  service.stop();

  assert.equal(
    sent.length,
    0,
    "no session-metadata batch may leave the machine when the tier disallows sync"
  );
});

test("agent-session sync proceeds when the consent tier allows cloud sync", async () => {
  const source = new FakeSyncSource([
    makeSyncedSession("consent-allowed", "2026-06-08T12:00:00.000Z"),
  ]);
  const sent: AgentSessionSyncBatch[] = [];
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    // A cloud tier (full/metadata) leaves current behavior unchanged.
    isCloudSyncTierAllowed: () => true,
    getSource: () => source,
    sendBatch: async (batch) => {
      sent.push(batch);
      return { accepted: true };
    },
  });

  service.start();
  await flushAgentSessionSync();
  service.stop();

  assert.equal(sent.length, 1);
  assert.deepEqual(
    sent[0].sessions.map((session) => session.externalSessionId),
    ["consent-allowed"]
  );
});

// FEA-1962: cursor persistence + hydration ------------------------------------

test("agent-session sync resumes from a persisted cursor and skips full backfill", async () => {
  const source = new FakeSyncSource([
    makeSyncedSession("old", "2026-06-08T12:00:00.000Z"),
    makeSyncedSession("top", "2026-06-08T12:05:00.000Z"),
  ]);
  const key = buildAgentSessionSyncSourceKey("target-a");
  source.seedSyncState(key, {
    observedTopUpdatedAt: "2026-06-08T12:05:00.000Z",
    observedIdsAtTopUpdatedAt: ["top"],
  });
  const sent: AgentSessionSyncBatch[] = [];
  const service = makeServiceWithIdentity(
    source,
    async (batch) => {
      sent.push(batch);
      return { accepted: true };
    },
    "target-a"
  );

  service.start();
  await flushAgentSessionSync();
  service.refresh();
  await flushAgentSessionSync();
  service.stop();

  assert.equal(
    sent.length,
    0,
    "a fully-synced persisted cursor must not re-upload history on cold start"
  );
});

test("agent-session sync full-backfills a fresh source then persists the caught-up cursor", async () => {
  const source = new FakeSyncSource([
    makeSyncedSession("a", "2026-06-08T12:01:00.000Z"),
    makeSyncedSession("b", "2026-06-08T12:02:00.000Z"),
    makeSyncedSession("c", "2026-06-08T12:03:00.000Z"),
  ]);
  const sent: string[][] = [];
  const service = makeServiceWithIdentity(
    source,
    async (batch) => {
      sent.push(batch.sessions.map((session) => session.externalSessionId));
      return { accepted: true };
    },
    "target-a"
  );

  service.start();
  await settleSelfContinuedDrain(service);
  service.stop();

  // ISS-5988 (byte-budgeted batching): the three-session corpus packs into one
  // request, newest-first.
  assert.deepEqual(sent, [["c", "b", "a"]]);
  // FEA-3473 durability fix: the cursor is now persisted TWICE — once
  // immediately after the initial full-corpus outbox seed commits (so a cold
  // restart resumes from the pending outbox instead of re-walking the corpus),
  // and again when the queues fully drain. Both carry the corpus-top watermark.
  assert.equal(source.advanceCalls.length, 2);
  assert.equal(
    source.advanceCalls[0].state.observedTopUpdatedAt,
    "2026-06-08T12:03:00.000Z",
    "the initial post-seed persist carries the corpus-top watermark"
  );
  assert.deepEqual(source.advanceCalls[0].state.observedIdsAtTopUpdatedAt, [
    "c",
  ]);
  assert.equal(
    source.advanceCalls.at(-1)?.state.observedTopUpdatedAt,
    "2026-06-08T12:03:00.000Z",
    "the caught-up persist carries the same corpus-top watermark"
  );
});

test("FEA-3781: a formula-reset cursor re-walks the whole corpus through the real send path, once", async () => {
  // T9's actual requirement is that every ALREADY-SYNCED session gets re-sent
  // under the corrected autonomy formula. `sync-autonomy-formula-backfill.test.ts`
  // proves the sqlite source clears the watermark when the stored formula stamp
  // is stale; this proves what the service then does with that cursor, through
  // the real queue and send path — otherwise both halves are tested and the seam
  // between them is not.
  const source = new FakeSyncSource([
    makeSyncedSession("historic-1", "2026-06-08T12:01:00.000Z"),
    makeSyncedSession("historic-2", "2026-06-08T12:02:00.000Z"),
    makeSyncedSession("historic-3", "2026-06-08T12:03:00.000Z"),
  ]);
  // Exactly the shape sqliteLoadSyncState returns for a superseded formula
  // stamp: watermark cleared, ids empty, the cursor row itself intact.
  source.seedSyncState(buildAgentSessionSyncSourceKey("target-formula"), {
    observedTopUpdatedAt: null,
    observedIdsAtTopUpdatedAt: [],
  });
  const sent: string[] = [];
  const service = makeServiceWithIdentity(
    source,
    async (batch) => {
      sent.push(...batch.sessions.map((session) => session.externalSessionId));
      return { accepted: true };
    },
    "target-formula"
  );

  service.start();
  await settleSelfContinuedDrain(service);
  service.stop();

  assert.deepEqual(
    [...sent].sort(),
    ["historic-1", "historic-2", "historic-3"],
    "a cleared watermark re-sends the entire historical corpus"
  );
  // And it stamps a caught-up cursor, so the re-walk is once per formula bump
  // rather than on every boot.
  assert.equal(
    source.advanceCalls.at(-1)?.state.observedTopUpdatedAt,
    "2026-06-08T12:03:00.000Z"
  );

  const afterRestart: string[] = [];
  const restarted = makeServiceWithIdentity(
    source,
    async (batch) => {
      afterRestart.push(
        ...batch.sessions.map((session) => session.externalSessionId)
      );
      return { accepted: true };
    },
    "target-formula"
  );
  restarted.start();
  await flushAgentSessionSync();
  restarted.stop();

  assert.deepEqual(afterRestart, [], "the next start must not re-walk");
});

test("FEA-3473 restart-reset fix: persists the backfill cursor after the initial walk seeds the outbox, before the queue drains", async () => {
  // Root cause of the "backfill drains then resets to ~3900 on restart" bug: the
  // cursor was ONLY persisted when both queues drained, which a large / trickling
  // corpus never reaches — so every cold start re-walked the whole corpus and
  // resurrected already-synced sessions. The fix persists the cursor immediately
  // after the initial full-corpus outbox seed commits, WITHOUT waiting to be
  // caught up. Here the batch handler never acks (retryable failure), so the
  // backfill queue stays non-empty forever — yet the cursor must already be
  // persisted with the corpus-top watermark.
  const source = new FakeSyncSource([
    makeSyncedSession("a", "2026-06-08T12:01:00.000Z"),
    makeSyncedSession("b", "2026-06-08T12:02:00.000Z"),
    makeSyncedSession("c", "2026-06-08T12:03:00.000Z"),
  ]);
  const service = makeServiceWithIdentity(
    source,
    // Never ack — a retryable rate-limit keeps the backfill queue non-empty, so
    // the caught-up persist path can never fire.
    async () => ({
      accepted: false,
      reason: DesktopAgentSessionsAckReason.RateLimited,
    }),
    "target-a"
  );

  service.start();
  await flushAgentSessionSync();

  // Read progress BEFORE stop() — stop() resets source-derived state and would
  // clear the queues. The queue genuinely never drained (nothing was acked),
  // proving the persist below did NOT go through the caught-up gate.
  const progress = service.getSyncProgress();
  service.stop();

  assert.ok(
    source.advanceCalls.length >= 1,
    "the cursor must persist right after the initial seed, without being caught up"
  );
  assert.equal(
    source.advanceCalls[0].state.observedTopUpdatedAt,
    "2026-06-08T12:03:00.000Z",
    "the persisted watermark is the corpus top established by the initial walk"
  );
  assert.ok(
    progress.pendingBackfillSessions > 0,
    "the backfill queue is still non-empty — the persist was NOT the caught-up path"
  );
});

test("FEA-3473 restart-reset fix: a cold restart with a persisted cursor resumes from the pending outbox and does NOT re-walk the full corpus", async () => {
  // The durability payoff: with a persisted cursor + a pending-outbox subset, a
  // fresh service must resume from the outbox alone — never re-enumerate the
  // whole corpus (which would resurrect already-synced, outbox-cleared sessions
  // as fresh pending rows: the ~3900 reset).
  const TARGET = "target-resume";
  const key = buildAgentSessionSyncSourceKey(TARGET);
  const source = new FakeSyncSource([
    makeSyncedSession("synced-1", "2026-06-08T12:01:00.000Z"),
    makeSyncedSession("synced-2", "2026-06-08T12:02:00.000Z"),
    makeSyncedSession("pending-1", "2026-06-08T12:03:00.000Z"),
    makeSyncedSession("top", "2026-06-08T12:04:00.000Z"),
  ]);
  // A prior run persisted the cursor at the corpus top and left exactly one
  // un-acked session in the outbox; the two "synced-*" rows were acked and their
  // outbox rows cleared.
  source.seedSyncState(key, {
    observedTopUpdatedAt: "2026-06-08T12:04:00.000Z",
    observedIdsAtTopUpdatedAt: ["top"],
  });
  source.seedOutbox(key, "pending-1");

  const sent: string[][] = [];
  const service = makeServiceWithIdentity(
    source,
    async (batch) => {
      sent.push(batch.sessions.map((s) => s.externalSessionId));
      return { accepted: true };
    },
    TARGET
  );

  service.start();
  await flushAgentSessionSync();
  service.stop();

  assert.equal(
    source.listAllCursorCallCount,
    0,
    "a persisted cursor must skip the full-corpus re-walk (no resurrection)"
  );
  const uploaded = new Set(sent.flat());
  assert.deepEqual(
    [...uploaded].sort(),
    ["pending-1"],
    "only the un-acked outbox subset is re-uploaded; already-synced sessions are not resurrected"
  );
});

test("PRD-536 E1: the incremental session lane reads with a (ts,id) keyset and never re-emits the seen top-timestamp cluster", async () => {
  // The bug the keyset fixes: the incremental scan used `updated_at >= cursor`,
  // so every tick re-read the ENTIRE top-timestamp cluster (here three sessions
  // sharing one `updated_at`) and re-emitted it (only for the JS `previousTopIds`
  // filter to drop it again). With the keyset `(updated_at, id) > (ts, id)` the
  // read starts STRICTLY AFTER the last-observed top `(ts, id)` pair, so the seen
  // cluster is not returned by the DB read at all, and a NEW row at a fresh
  // (monotonic) `updated_at` is still caught.
  const TARGET = "target-keyset-session";
  const key = buildAgentSessionSyncSourceKey(TARGET);
  const topTs = "2026-06-08T12:04:00.000Z";
  // Three sessions tied at the top timestamp. Sorted DESC-id, the highest id at
  // the top is "top-c", so the keyset id boundary the next tick passes is "top-c".
  const source = new FakeSyncSource([
    makeSyncedSession("older", "2026-06-08T12:01:00.000Z"),
    makeSyncedSession("top-a", topTs),
    makeSyncedSession("top-b", topTs),
    makeSyncedSession("top-c", topTs),
  ]);
  // A prior run already synced and persisted the cursor at the full top cluster.
  source.seedSyncState(key, {
    observedTopUpdatedAt: topTs,
    observedIdsAtTopUpdatedAt: ["top-a", "top-b", "top-c"],
  });

  const sent: string[][] = [];
  const service = makeServiceWithIdentity(
    source,
    async (batch) => {
      sent.push(batch.sessions.map((s) => s.externalSessionId));
      return { accepted: true };
    },
    TARGET
  );

  service.start();
  await flushAgentSessionSync();

  // First incremental tick after resume: the read carries the FULL observed-id
  // set at the top timestamp, so the DB read returns NOTHING (every tied-top row
  // is excluded by `id NOT IN (...)` and no row is strictly newer) and the top
  // cluster is never re-emitted.
  const firstIncrementalCall = source.listUpdatedCursorCalls.at(-1);
  assert.deepEqual(
    firstIncrementalCall,
    { sinceUpdatedAt: topTs, observedTopIds: ["top-a", "top-b", "top-c"] },
    "the incremental read must exclude the exact observed-id set at the top timestamp"
  );
  assert.deepEqual(
    sent,
    [],
    "an already-synced top-timestamp cluster must not be re-emitted across ticks"
  );

  // A genuinely-new session lands at a FRESH monotonic updated_at > topTs — the
  // keyset's `updated_at > $1` disjunct catches it even though its id ("new-hi")
  // sorts after the prior top id.
  source.upsert(makeSyncedSession("new-hi", "2026-06-08T12:05:00.000Z"));
  service.refresh();
  await flushAgentSessionSync();
  service.stop();

  assert.deepEqual(
    sent,
    [["new-hi"]],
    "a changed row stamped at a fresh monotonic updated_at is still selected by the keyset"
  );
  // The cursor advanced past the new (ts, id): the last incremental read keyed
  // off (topTs, "top-c") and, after uploading "new-hi", the durable cursor's top
  // is the new timestamp.
  assert.equal(
    source.loadSyncState(key)?.observedTopUpdatedAt,
    "2026-06-08T12:05:00.000Z",
    "the durable keyset cursor advances its (ts) component past the new top row"
  );
  assert.deepEqual(
    source.loadSyncState(key)?.observedIdsAtTopUpdatedAt,
    ["new-hi"],
    "the durable keyset cursor carries the new top row's id (the (id) component)"
  );
});

test("PRD-536 E1 (data-loss regression): a NEW sibling at the top updated_at with a LOWER-sorting id than an already-seen id IS selected, while already-seen ids are NOT re-emitted", async () => {
  // The exact data-loss case the observed-id-SET exclusion fixes. Under the prior
  // `WHERE updated_at = $1 AND id > $2` (with $2 = maxId of the seen set), a
  // genuinely-new session that lands at the SAME top `updated_at` but with an id
  // sorting BELOW the highest already-seen id was `id > $2 == false` → skipped
  // FOREVER (data loss). A new row can legitimately share the top timestamp: a
  // historical import stamps `updated_at = endedAt ?? startedAt`, or two writes
  // land in the same millisecond. The fix re-reads the tied-top cluster and
  // excludes exactly the observed-id set, so a new lower-id sibling is selected
  // (NOT IN the set) while every already-seen id stays excluded.
  const TARGET = "target-lower-id-sibling";
  const key = buildAgentSessionSyncSourceKey(TARGET);
  const topTs = "2026-06-08T12:04:00.000Z";
  // A prior run synced and persisted a top cluster whose highest seen id is
  // "session-m". A new sibling "session-a" (< "session-m") will arrive at topTs.
  const source = new FakeSyncSource([
    makeSyncedSession("older", "2026-06-08T12:01:00.000Z"),
    makeSyncedSession("session-h", topTs),
    makeSyncedSession("session-m", topTs),
  ]);
  source.seedSyncState(key, {
    observedTopUpdatedAt: topTs,
    observedIdsAtTopUpdatedAt: ["session-h", "session-m"],
  });

  const sent: string[][] = [];
  const service = makeServiceWithIdentity(
    source,
    async (batch) => {
      sent.push(batch.sessions.map((s) => s.externalSessionId));
      return { accepted: true };
    },
    TARGET
  );

  service.start();
  await flushAgentSessionSync();

  // Resume tick: the two already-seen ids are excluded (NOT IN the observed set)
  // and no row is strictly newer, so nothing is re-emitted.
  assert.deepEqual(
    sent,
    [],
    "an already-synced top-timestamp cluster must not be re-emitted"
  );

  // A genuinely-new session lands at the SAME top updated_at with an id
  // ("session-a") that sorts BELOW the highest already-seen id ("session-m").
  // Under the old `id > maxId` boundary this was skipped forever; the observed-id
  // SET exclusion selects it because it is NOT IN {session-h, session-m}.
  source.upsert(makeSyncedSession("session-a", topTs));
  service.refresh();
  await flushAgentSessionSync();
  service.stop();

  assert.deepEqual(
    sent,
    [["session-a"]],
    "a new lower-id sibling at the top updated_at must be selected, not skipped (data loss)"
  );
  // The last incremental read excluded exactly the observed-id set and NOT the
  // new id — proving the fix threads the full set, not just its max.
  const lastCall = source.listUpdatedCursorCalls.at(-1);
  assert.deepEqual(
    lastCall,
    { sinceUpdatedAt: topTs, observedTopIds: ["session-h", "session-m"] },
    "the incremental read excludes the exact observed-id set (not an id > maxId boundary)"
  );
  // The durable cursor now carries all three tied-top ids (the new one folded in),
  // so a subsequent tick excludes it too and never re-emits it.
  assert.deepEqual(
    source.loadSyncState(key)?.observedIdsAtTopUpdatedAt?.slice().sort(),
    ["session-a", "session-h", "session-m"],
    "the durable observed-id set folds in the newly-selected lower-id sibling"
  );
});

test("FEA-3659: a cold restart mid-backoff rehydrates the retry budget + backoff deadline from the outbox (no immediate retry, no count reset)", async () => {
  // Recording the retry is write-only unless resume reads it back. A prior run
  // left one session mid-backoff (attempt_count=4, one shy of the cap of 5, with
  // a future next_attempt_at). On restart the in-memory counters + nextRetryAfterMs
  // start EMPTY, so without rehydration the row would (a) retry immediately —
  // ignoring the persisted deadline — and (b) recompute (0 + 1) = 1 on its next
  // rejection, resetting a nearly-exhausted dead-letter budget and letting an
  // outage that spans restarts dodge the cap. This proves both are fixed.
  const TARGET = "target-resume-backoff";
  const key = buildAgentSessionSyncSourceKey(TARGET);
  const source = new FakeSyncSource([
    makeSyncedSession("backing-off", "2026-06-08T12:03:00.000Z"),
  ]);
  // A persisted cursor at the corpus top so resume skips the full re-walk.
  source.seedSyncState(key, {
    observedTopUpdatedAt: "2026-06-08T12:03:00.000Z",
    observedIdsAtTopUpdatedAt: ["backing-off"],
  });

  const acked: string[][] = [];
  const service = makeServiceWithIdentity(
    source,
    async (batch) => {
      acked.push(batch.sessions.map((s) => s.externalSessionId));
      return {
        accepted: false,
        reason: DesktopAgentSessionsAckReason.IngestionFailed,
      };
    },
    TARGET
  );

  try {
    await runWithMockedNow(async ({ advance }) => {
      // Seed the durable mid-backoff row exactly as the prior run left it:
      // attempt 4 with a deadline INGESTION_FAILED_BACKOFF_MS out from "now".
      const deadlineIso = new Date(
        Date.now() + INGESTION_FAILED_BACKOFF_MS
      ).toISOString();
      source.recordOutboxRetry(
        key,
        "backing-off",
        4,
        deadlineIso,
        "ingestion_failed"
      );

      service.start();
      await flushAgentSessionSync();

      // The rehydrated deadline is still in the future → the row is deferred, NOT
      // retried on resume (an empty nextRetryAfterMs would have uploaded it now).
      assert.deepEqual(
        acked,
        [],
        "a resumed mid-backoff row is not retried before its persisted next_attempt_at"
      );

      // Past the deadline: one retry fires, and because the budget was rehydrated
      // at 4 (not reset to 0), this 5th consecutive failure exhausts the cap and
      // dead-letters immediately instead of settling back to attempt 1.
      advance(INGESTION_FAILED_BACKOFF_MS + 1);
      service.refresh();
      await flushAgentSessionSync();

      assert.deepEqual(
        acked,
        [["backing-off"]],
        "exactly one retry fires once the persisted deadline elapses"
      );
    });
  } finally {
    service.stop();
  }

  const finalRow = [...source.outbox.values()].find(
    (r) => r.sourceKey === key && r.id === "backing-off"
  );
  assert.equal(
    finalRow?.status,
    "dead_lettered",
    "the rehydrated budget (4) + one more failure hits the cap (5) — proving the count was NOT reset to 1 on resume"
  );
  assert.equal(
    finalRow?.attemptCount,
    MAX_CONSECUTIVE_INGESTION_FAILED,
    "the dead-lettered row records the exhausted cap, confirming the budget carried across restart"
  );
});

test("FEA-3659: FakeSyncSource.recordOutboxRetry does not resurrect a dead_lettered row (real-source parity)", () => {
  // Fake-vs-real parity: the sqlite source's recordOutboxRetry upsert leaves
  // `status` untouched on its `update` branch, so recording a retry on an
  // already dead_lettered row must NOT flip it back to pending — matching the
  // fake's own enqueueOutboxEntries guarantee ("never resurrects a
  // dead_lettered row").
  const source = new FakeSyncSource([]);
  const key = buildAgentSessionSyncSourceKey("target-no-resurrect");
  source.markOutboxDeadLettered(key, "dead-id", "ingestion_failed", 5);

  source.recordOutboxRetry(
    key,
    "dead-id",
    6,
    new Date().toISOString(),
    "ingestion_failed"
  );

  const row = [...source.outbox.values()].find(
    (r) => r.sourceKey === key && r.id === "dead-id"
  );
  assert.equal(
    row?.status,
    "dead_lettered",
    "recordOutboxRetry must leave a dead_lettered row dead_lettered (status untouched, like the real source)"
  );
  // An absent row is still created pending (the create branch).
  source.recordOutboxRetry(
    key,
    "fresh-id",
    1,
    new Date().toISOString(),
    "ingestion_failed"
  );
  const freshRow = [...source.outbox.values()].find(
    (r) => r.sourceKey === key && r.id === "fresh-id"
  );
  assert.equal(
    freshRow?.status,
    "pending",
    "recordOutboxRetry on an absent row creates it pending (create branch)"
  );
});

test("FEA-3473 restart-reset fix: a crash mid-seed leaves no cursor so the safe full re-walk still runs", async () => {
  // The anti-stranding ordering: the cursor is persisted ONLY AFTER the
  // full-corpus outbox seed durably commits. If the seed throws (a kill
  // mid-write), the cursor must stay unpersisted so the next cold start runs the
  // safe full re-walk and strands nothing behind a partially-written outbox.
  class SeedFailingSyncSource extends FakeSyncSource {
    override enqueueOutboxEntries(): void {
      throw new Error("simulated crash mid-seed");
    }
  }
  const source = new SeedFailingSyncSource([
    makeSyncedSession("a", "2026-06-08T12:01:00.000Z"),
    makeSyncedSession("b", "2026-06-08T12:02:00.000Z"),
  ]);
  const service = makeServiceWithIdentity(
    source,
    // Never ack, so the caught-up persist path also cannot fire — the ONLY
    // persist that could happen is the initial post-seed one, which must be
    // gated off by the seed failure.
    async () => ({
      accepted: false,
      reason: DesktopAgentSessionsAckReason.RateLimited,
    }),
    "target-crash"
  );

  service.start();
  await flushAgentSessionSync();
  service.stop();

  assert.equal(
    source.advanceCalls.length,
    0,
    "a crash mid-seed must leave the cursor unpersisted (seed-then-persist ordering)"
  );
});

// FEA-3473 AC-1's mid-backfill kill case is no longer expressible here. It was
// premised on "backfill batch size is 3, so a single tick acks the 3 highest
// ids", and ISS-5988 made batching byte-budgeted with a ceiling of 25 — the
// whole six-session corpus now ships as ONE envelope, so there is no
// between-batch boundary left to kill at. The guarantee did not go away, it
// moved INSIDE the batch: see "FEA-3473 AC-1: a kill mid-batch after PARTIAL
// acks re-uploads only the un-acked rows on restart" in
// `agent-session-sync-atomic-ack.test.ts`, which asserts the same durability
// property against the server `acceptedSessionIds` echo and additionally proves
// the acked prefix is NOT re-uploaded.
test("FEA-3473 AC-1: a kill with a PARTIALLY-written outbox still uploads the sessions missing from it", async () => {
  // Codex P1: a fire-and-forget outbox enqueue can be killed mid-write, so on a
  // no-cursor restart the pending outbox is NOT proof that every earlier row is
  // acked or represented. Model that: only the newest un-acked id made it into
  // the outbox; an OLDER session was never enqueued (its outbox write was lost to
  // the kill). Seeding the watermark from the current top would skip enumeration
  // AND fall above the older row's `updated_at`, stranding it forever. The restart
  // must still upload it.
  const TARGET = "target-ac1-partial";
  const key = buildAgentSessionSyncSourceKey(TARGET);
  const source = new FakeSyncSource([
    makeSyncedSession("newest", "2026-06-08T12:06:00.000Z"),
    makeSyncedSession("orphan", "2026-06-08T12:01:00.000Z"),
  ]);
  // Simulate a partially-written outbox that survived the kill: only `newest` was
  // durably recorded as pending; `orphan`'s enqueue never reached SQLite. No
  // cursor was persisted.
  source.seedOutbox(key, "newest");

  const restartSent: string[][] = [];
  const restarted = makeServiceWithIdentity(
    source,
    async (batch) => {
      restartSent.push(batch.sessions.map((s) => s.externalSessionId));
      return { accepted: true };
    },
    TARGET
  );
  restarted.start();
  for (let i = 0; i < 4; i++) {
    await flushAgentSessionSync();
    restarted.refresh();
  }
  restarted.stop();

  const uploaded = new Set(restartSent.flat());
  assert.ok(
    uploaded.has("orphan"),
    "the older session missing from the partial outbox must NOT be stranded"
  );
  assert.ok(
    uploaded.has("newest"),
    "the un-acked session recorded in the outbox is re-uploaded too"
  );
});

test("FEA-3473 AC-2: a session locally deleted after enqueue never blocks cursor persistence", async () => {
  // A session is enqueued for backfill, then deleted from the local store before
  // it is picked. `loadSyncedSessions` returns [] for it. The old code silently
  // dequeued it and returned WITHOUT recording anything or persisting — if it
  // was the last queued row the cursor never advanced, forcing a full re-walk on
  // every restart. Now it is dead-lettered with reason `unhydratable`, marked in
  // the outbox, and the cursor persists.
  const TARGET = "target-ac2";
  const key = buildAgentSessionSyncSourceKey(TARGET);

  // A single enqueued session that is locally deleted the instant its batch is
  // about to hydrate: `loadSyncedSessions` returns [] and it is the only queued
  // row, so the empty-hydration branch runs and it must be recorded (not
  // silently dropped) while the cursor still persists.
  const resettingSource = new ResettingSyncSource([
    makeSyncedSession("ghost", "2026-06-08T12:01:00.000Z"),
  ]);
  const sent2: string[][] = [];
  const svc = makeServiceWithIdentity(
    resettingSource,
    async (batch) => {
      sent2.push(batch.sessions.map((s) => s.externalSessionId));
      return { accepted: true };
    },
    TARGET
  );
  // Delete ghost on the load so its hydration returns [] (delete-after-enqueue).
  resettingSource.onLoad = () => {
    resettingSource.deleteSession("ghost");
  };
  svc.start();
  await flushAgentSessionSync();
  svc.stop();

  assert.deepEqual(sent2, [], "the deleted straggler is never uploaded");
  const ghostOutbox = [...resettingSource.outbox.values()].find(
    (row) => row.sourceKey === key && row.id === "ghost"
  );
  assert.equal(
    ghostOutbox?.status,
    "dead_lettered",
    "the locally-deleted straggler is marked dead_lettered in the outbox"
  );
  assert.equal(
    ghostOutbox?.reason,
    "unhydratable",
    "the recorded reason is `unhydratable`"
  );
  // The cursor persisted despite the stuck item — the watermark advanced and its
  // dead id is recorded, so a restart never re-walks the whole corpus.
  assert.ok(
    resettingSource.advanceCalls.length > 0,
    "a single stuck item must not block cursor persistence"
  );
  const lastState = resettingSource.advanceCalls.at(-1)?.state;
  assert.ok(
    lastState?.deadLetteredIds.includes("ghost"),
    "the persisted cursor records the dead-lettered ghost id"
  );
});

test("FEA-3473 G6: the persisted tied-top id set is bounded by MAX_OBSERVED_TOP_IDS", async () => {
  // Same-`updated_at` siblings are ALL preserved in the persisted cursor when
  // under the cap (so a restart re-selects them and never skips a tied sibling),
  // and the persisted set is always bounded by MAX_OBSERVED_TOP_IDS — a
  // pathological cluster can never bloat the `observed_ids_at_top_updated_at`
  // JSON without bound (over the cap it serializes empty and a restart re-scans
  // the tied group by timestamp).
  const TARGET = "target-g6";
  const top = "2026-06-08T12:00:00.000Z";
  const count = 6;
  const sessions = Array.from({ length: count }, (_, i) =>
    makeSyncedSession(`c${String(i).padStart(2, "0")}`, top)
  );
  const source = new FakeSyncSource(sessions);
  const service = makeServiceWithIdentity(
    source,
    async () => ({ accepted: true }),
    TARGET
  );

  service.start();
  // Backfill batch size is 3, so a bounded handful of ticks drains all 6.
  for (let i = 0; i < 10 && source.advanceCalls.length === 0; i++) {
    await flushAgentSessionSync();
    service.refresh();
  }
  service.stop();

  assert.ok(
    source.advanceCalls.length > 0,
    "the lane persists a cursor once the tied-top backfill drains"
  );
  const persisted = source.advanceCalls.at(-1)?.state;
  assert.equal(
    persisted?.observedTopUpdatedAt,
    top,
    "the watermark is the shared top timestamp"
  );
  assert.deepEqual(
    [...(persisted?.observedIdsAtTopUpdatedAt ?? [])].sort(),
    sessions.map((s) => s.externalSessionId).sort(),
    "under the cap, every tied-top sibling is preserved in the persisted set"
  );
  assert.ok(
    (persisted?.observedIdsAtTopUpdatedAt.length ?? 0) <= MAX_OBSERVED_TOP_IDS,
    "the persisted tied-top set is always bounded by MAX_OBSERVED_TOP_IDS"
  );
});

test("agent-session sync resumes a persisted top timestamp and picks up new same-timestamp rows", async () => {
  const top = "2026-06-08T12:00:00.000Z";
  const source = new FakeSyncSource([
    makeSyncedSession("a", top),
    makeSyncedSession("b", top),
  ]);
  const key = buildAgentSessionSyncSourceKey("target-a");
  source.seedSyncState(key, {
    observedTopUpdatedAt: top,
    observedIdsAtTopUpdatedAt: ["a", "b"],
  });
  const sent: string[][] = [];
  const service = makeServiceWithIdentity(
    source,
    async (batch) => {
      sent.push(batch.sessions.map((session) => session.externalSessionId));
      return { accepted: true };
    },
    "target-a"
  );

  service.start();
  await flushAgentSessionSync();
  source.upsert(makeSyncedSession("c", top));
  service.refresh();
  await flushAgentSessionSync();
  service.stop();

  assert.deepEqual(
    sent,
    [["c"]],
    "already-accepted same-timestamp ids stay skipped; only the new one uploads"
  );
});

test("agent-session sync does not reuse another principal's persisted cursor", async () => {
  const source = new FakeSyncSource([
    makeSyncedSession("a", "2026-06-08T12:01:00.000Z"),
    makeSyncedSession("b", "2026-06-08T12:02:00.000Z"),
  ]);
  // A fully-synced cursor that belongs to target-a.
  const keyA = buildAgentSessionSyncSourceKey("target-a");
  source.seedSyncState(keyA, {
    observedTopUpdatedAt: "2026-06-08T12:02:00.000Z",
    observedIdsAtTopUpdatedAt: ["b"],
  });
  const sent: string[][] = [];
  // This client authenticates as target-b — it must NOT inherit target-a's cursor.
  const service = makeServiceWithIdentity(
    source,
    async (batch) => {
      sent.push(batch.sessions.map((session) => session.externalSessionId));
      return { accepted: true };
    },
    "target-b"
  );

  service.start();
  await settleSelfContinuedDrain(service);
  service.stop();

  // ISS-5988 (byte-budgeted batching): the full re-walk ships as one packed
  // batch — the property under test is that target-b re-uploads EVERYTHING
  // rather than inheriting target-a's cursor, not the envelope count.
  assert.deepEqual(
    sent,
    [["b", "a"]],
    "a different compute target must perform a full backfill"
  );
});

test("agent-session sync persists the cursor only once both queues drain", async () => {
  // ISS-5988 (byte-budgeted batching): these sessions are tiny, so neither the
  // 2 MiB hydration budget nor the 256 KiB wire cap is reached — the binding
  // bound is the BACKFILL_SESSION_BATCH_SIZE count backstop, and each envelope
  // carries exactly that many. Observing "no caught-up persist while rows remain
  // queued" needs a corpus spanning several envelopes, so the corpus is DERIVED
  // from the backstop rather than pinned to a magic count: the batch arithmetic
  // then stays exact when the ceiling moves (it went 1 -> 100 -> 25 across this
  // ticket alone, and a hardcoded 350/four-batches went stale on the last move).
  const expectedBatchCount = 14;
  const corpusSize = BACKFILL_SESSION_BATCH_SIZE * expectedBatchCount;
  const sessions = Array.from({ length: corpusSize }, (_, index) =>
    makeSyncedSession(
      `s${index + 1}`,
      new Date(Date.UTC(2026, 5, 8, 12, 0, index)).toISOString()
    )
  );
  const topUpdatedAt = new Date(
    Date.UTC(2026, 5, 8, 12, 0, corpusSize - 1)
  ).toISOString();
  const source = new FakeSyncSource(sessions);
  // Sample at each send so self-continuing drain timing cannot hide an early
  // caught-up cursor persist while rows remain queued.
  const persistsAtSend: number[] = [];
  const service = makeServiceWithIdentity(
    source,
    async () => {
      persistsAtSend.push(source.advanceCalls.length);
      return { accepted: true };
    },
    "target-a"
  );

  service.start();
  await settleSelfContinuedDrain(service);
  service.stop();

  assert.equal(
    persistsAtSend.length,
    expectedBatchCount,
    `the corpus takes ${expectedBatchCount} batches of ${BACKFILL_SESSION_BATCH_SIZE}`
  );
  assert.deepEqual(
    persistsAtSend.slice(1),
    Array.from({ length: expectedBatchCount - 1 }, () => 1),
    "the post-seed cursor persists once; the caught-up persist must not fire while rows remain queued"
  );
  // A second advanceCall lands once both queues drain (the caught-up persist).
  assert.equal(source.advanceCalls.length, 2);
  assert.equal(
    source.advanceCalls.at(-1)?.state.observedTopUpdatedAt,
    topUpdatedAt
  );
});

test("agent-session sync persists the cursor once dead-lettered, recording the dead id", async () => {
  // REGRESSION (dead-letter cursor poison): a row that always times out is
  // dead-lettered (dequeued) but was never uploaded. Previously a non-empty
  // dead-letter set blocked persistCursorIfCaughtUp, so the cursor never
  // advanced and every restart re-walked the whole local corpus. The fix
  // RECORDS the dead id on the cursor so the watermark can advance past it while
  // remembering exactly which row was abandoned.
  const source = new FakeSyncSource([
    makeSyncedSession("lost", "2026-06-08T12:00:00.000Z"),
  ]);
  const service = makeServiceWithIdentity(
    source,
    async (batch) => {
      const ids = batch.sessions.map((session) => session.externalSessionId);
      return ids.includes("lost")
        ? { accepted: false, reason: DesktopAgentSessionsAckReason.AckTimeout }
        : { accepted: true };
    },
    "target-a"
  );

  service.start();
  await flushAgentSessionSync();
  // Drive "lost" through repeated timeouts until it is dead-lettered.
  for (let i = 1; i < MAX_CONSECUTIVE_TIMEOUTS; i += 1) {
    service.refresh();
    await flushAgentSessionSync();
  }
  // A fresh, healthy row arrives and is accepted, draining the queues while
  // "lost" sits in the dead-letter set.
  source.upsert(makeSyncedSession("ok", "2026-06-08T12:05:00.000Z"));
  service.refresh();
  await flushAgentSessionSync();
  service.stop();

  assert.ok(
    source.advanceCalls.length >= 1,
    "the watermark must now advance even while a row is dead-lettered"
  );
  const lastState = source.advanceCalls.at(-1)?.state;
  assert.deepEqual(
    lastState?.deadLetteredIds,
    ["lost"],
    "the persisted cursor must record the dead-lettered id it advanced past"
  );
});

test("agent-session sync persists a validation_failed id as a recorded dead-letter", async () => {
  // A validation_failed id is dropped (not retried this session, to avoid a
  // stall) and was never accepted. Under the fix the watermark still advances,
  // but the id is RECORDED in the persisted cursor's deadLetteredIds — NOT as an
  // accepted id — so a restart sets it aside and revisits it last rather than
  // re-walking the whole corpus or silently skipping it forever.
  const source = new FakeSyncSource([
    makeSyncedSession("bad", "2026-06-08T12:00:00.000Z"),
  ]);
  const service = makeServiceWithIdentity(
    source,
    async (batch) => {
      const ids = batch.sessions.map((session) => session.externalSessionId);
      return ids.includes("bad")
        ? {
            accepted: false,
            reason: DesktopAgentSessionsAckReason.ValidationFailed,
          }
        : { accepted: true };
    },
    "target-a"
  );

  await runWithMockedNow(async ({ advance }) => {
    service.start();
    await flushAgentSessionSync();
    // FEA-3366: "bad" now retries with backoff; spend its whole budget so it
    // escalates to a dead-letter (the state this cursor-persistence test covers).
    for (let i = 1; i < MAX_CONSECUTIVE_VALIDATION_FAILED; i += 1) {
      advance(VALIDATION_FAILED_BACKOFF_MS + 1);
      service.refresh();
      await flushAgentSessionSync();
    }
    assert.equal(
      service.getSyncProgress().deadLetteredSessions,
      1,
      "the validation_failed row is dead-lettered after its retry budget"
    );
    // A later healthy row is accepted and drains the queues; persistence now
    // fires and records "bad" as dead-lettered rather than blocking forever.
    source.upsert(makeSyncedSession("ok", "2026-06-08T12:05:00.000Z"));
    service.refresh();
    await flushAgentSessionSync();
  });
  service.stop();

  assert.ok(
    source.advanceCalls.length >= 1,
    "the watermark must advance, recording the validation_failed id"
  );
  const lastState = source.advanceCalls.at(-1)?.state;
  assert.deepEqual(
    lastState?.deadLetteredIds,
    ["bad"],
    "the validation_failed id must be recorded as a dead-letter, not an accepted id"
  );
  assert.ok(
    !lastState?.observedIdsAtTopUpdatedAt.includes("bad"),
    "the validation_failed id must never be recorded as an accepted top id"
  );
});

test("agent-session sync persists the cursor when a locally-oversized session is the only remaining row", async () => {
  // REGRESSION (locally-oversized dead-letter cursor poison): a locally-oversized
  // session is dead-lettered before any batch is sent, so `syncOnce` returns an
  // empty batch and never reaches `handleBatchAck` — the only place the accepted
  // path persists. Without persisting inside `deadLetterOversizedLocalSession`,
  // an install whose last/only queued row is locally oversized would advance no
  // watermark and full-re-walk the whole corpus on every restart. The fix persists
  // the cursor (recording the dead id) the moment this dead-letter drains both
  // queues.
  const source = new FakeSyncSource([
    makeUnchunkableOversizedSession("oversized", "2026-06-08T12:00:00.000Z"),
  ]);
  const service = makeServiceWithIdentity(
    source,
    async () => ({ accepted: true }),
    "target-a"
  );

  service.start();
  await flushAgentSessionSync();
  // A second tick lets the cursor-hydrate / backfill-walk round-trips settle so
  // the oversized row is selected and dead-lettered.
  service.refresh();
  await flushAgentSessionSync();

  // Read progress BEFORE stop() (which clears the in-memory dead-letter set).
  assert.equal(
    service.getSyncProgress().deadLetteredSessions,
    1,
    "the locally-oversized session is dead-lettered locally"
  );
  service.stop();

  assert.ok(
    source.advanceCalls.length >= 1,
    "the watermark must advance even though the only row was dead-lettered before any send"
  );
  assert.deepEqual(
    source.advanceCalls.at(-1)?.state.deadLetteredIds,
    ["oversized"],
    "the persisted cursor records the locally-oversized dead-letter it advanced past"
  );
});

test("agent-session sync aborts an active tick when source state resets during hydration", async () => {
  const source = new ResettingSyncSource([
    makeSyncedSession("reset-session", "2026-06-08T12:00:00.000Z"),
  ]);
  const sent: string[][] = [];
  const service = makeServiceWithIdentity(
    source,
    async (batch) => {
      sent.push(batch.sessions.map((session) => session.externalSessionId));
      return { accepted: true };
    },
    "target-a"
  );
  source.onLoad = () => service.resetSourceState();

  service.start();
  await flushAgentSessionSync();

  // The reset fires during loadSyncedSessions, so the SEND aborts — nothing
  // reaches the cloud this tick.
  assert.deepEqual(sent, []);
  // FEA-3473 durability fix: the initial full-corpus outbox seed and its cursor
  // persist run BEFORE the send (in initializeBackfillQueueIfNeeded), so one
  // advanceCall has already landed by the time the mid-load reset aborts the
  // rest of the tick. That durable seed-cursor is the whole point — it survives
  // the reset so a restart resumes from the outbox instead of re-walking.
  assert.equal(source.advanceCalls.length, 1);

  source.onLoad = () => undefined;
  service.refresh();
  await flushAgentSessionSync();
  service.stop();

  assert.deepEqual(sent, [["reset-session"]]);
  // The first run's seed persisted the corpus-top cursor AND seeded reset-session
  // as pending in the outbox (both survive the reset — they live on the source).
  // So the clean re-run HYDRATES that persisted cursor (no re-walk, no second
  // seed-persist), re-enqueues reset-session from the durable outbox, sends it,
  // and persists the caught-up cursor once the queue drains — exactly one more
  // advanceCall on top of the first run's seed.
  assert.equal(source.advanceCalls.length, 2);
});

// ---------------------------------------------------------------------------
// T-10.9: component inventory lane uses its own SyncState cursor key
// ---------------------------------------------------------------------------

test("T-10.9: component inventory lane advances its own SyncState cursor independently of the session lane", async () => {
  const COMPUTE_TARGET = "target-comp-lane";
  // A single session so the session lane also runs and we can verify the two
  // cursor keys are distinct.
  const source = new FakeSyncSource([
    makeSyncedSession("sess-comp", "2026-07-10T00:00:00.000Z"),
  ]);

  // One component row with a last_seen_at timestamp so the watermark advances.
  const componentRow = {
    id: "comp-abc",
    last_seen_at: "2026-07-10T01:00:00.000Z",
  };
  const fullComponent = {
    externalId: "comp-abc",
    componentKind: "mcp",
    componentKey: "myserver",
    firstSeenAt: "2026-07-10T01:00:00.000Z",
    lastSeenAt: "2026-07-10T01:00:00.000Z",
  };

  const sentBatches: AgentSessionSyncTransportPayload[] = [];
  const sentComponents: unknown[] = [];

  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    sendBatch: async (batch) => {
      sentBatches.push(batch);
      return { accepted: true };
    },
    listComponentCursorRows: async (_since) => [componentRow],
    loadComponentRows: async (_ids) => [fullComponent],
    sendComponents: async (_payload) => {
      sentComponents.push(_payload);
      return acceptedResult();
    },
  });

  service.start();
  await flushAgentSessionSync();
  service.stop();

  // The session lane must have synced at least once.
  assert.ok(sentBatches.length >= 1, "session batch was sent");

  // The component lane must also have fired.
  assert.ok(sentComponents.length >= 1, "component batch was sent");

  // Verify that the component cursor advance used the COMPONENT source key
  // (not the session source key — the two lanes must never share a watermark).
  const componentSourceKey = buildAgentComponentSyncSourceKey(COMPUTE_TARGET);
  const sessionSourceKey = buildAgentSessionSyncSourceKey(COMPUTE_TARGET);

  const componentAdvance = source.advanceCalls.find(
    (call) => call.sourceKey === componentSourceKey
  );
  assert.ok(
    componentAdvance,
    `advanceSyncState was called with the component source key (${componentSourceKey})`
  );

  // The session lane must have used a DIFFERENT key.
  const sessionAdvance = source.advanceCalls.find(
    (call) => call.sourceKey === sessionSourceKey
  );
  assert.ok(
    sessionAdvance,
    `advanceSyncState was called with the session source key (${sessionSourceKey})`
  );

  // The keys must be distinct — they must not be equal.
  assert.notEqual(
    componentSourceKey,
    sessionSourceKey,
    "component lane and session lane advance independent SyncState cursors"
  );
});

// ---------------------------------------------------------------------------
// FEA-3425 (PLN-1437 Phase 1): the HTTP transport's client-only ack reasons
// must defer with EVERY retry budget intact — auth loss and target-ownership
// rejections are never payload problems, so no count of them may dead-letter
// a session or advance any failure counter.
// ---------------------------------------------------------------------------

// Far past every per-reason dead-letter budget: if ANY counter were burned by
// these rejections, the session would dead-letter mid-loop and attempts would
// stop short (a dead-lettered id defers for DEAD_LETTER_RETRY_AFTER_MS = 24h,
// far beyond the 30s advances below).
const FEA3425_ROUNDS =
  MAX_CONSECUTIVE_TIMEOUTS +
  MAX_CONSECUTIVE_RATE_LIMITED +
  MAX_CONSECUTIVE_INGESTION_FAILED +
  MAX_CONSECUTIVE_VALIDATION_FAILED;

test("FEA-3425: N consecutive unauthenticated rejections burn no budgets, never dead-letter, and recover on re-auth", async () => {
  const source = new FakeSyncSource([
    makeSyncedSession("unauth-session", "2026-06-08T12:00:00.000Z"),
  ]);
  let attempts = 0;
  let authenticated = false;
  const service = makeService(source, async () => {
    attempts += 1;
    if (!authenticated) {
      return {
        accepted: false,
        reason: DesktopAgentSessionsAckReason.Unauthenticated,
      };
    }
    return { accepted: true };
  });

  try {
    await runWithMockedNow(async ({ advance }) => {
      service.start();
      await flushAgentSessionSync();
      for (let i = 1; i < FEA3425_ROUNDS; i += 1) {
        advance(UNAUTHENTICATED_BACKOFF_MS + 1);
        service.refresh();
        await flushAgentSessionSync();
      }
      // Every rejection deferred the batch with budgets intact: each elapsed
      // backoff window produced exactly one more attempt, and nothing
      // dead-lettered despite exceeding every per-reason budget.
      assert.equal(attempts, FEA3425_ROUNDS);
      assert.equal(service.getSyncProgress().deadLetteredSessions, 0);

      // Re-auth: the very next elapsed window drains the batch successfully —
      // a dead-lettered id could not retry for 24h.
      authenticated = true;
      advance(UNAUTHENTICATED_BACKOFF_MS + 1);
      service.refresh();
      await flushAgentSessionSync();
      assert.equal(attempts, FEA3425_ROUNDS + 1);
      assert.equal(service.getSyncProgress().deadLetteredSessions, 0);
    });
  } finally {
    service.stop();
  }
});

test("FEA-3425: target-not-owned rejections defer with budgets intact and recover once identity re-resolves", async () => {
  const source = new FakeSyncSource([
    makeSyncedSession("unowned-target-session", "2026-06-08T12:00:00.000Z"),
  ]);
  let attempts = 0;
  let targetOwned = false;
  const service = makeService(source, async () => {
    attempts += 1;
    if (!targetOwned) {
      return {
        accepted: false,
        reason: DesktopAgentSessionsAckReason.TargetNotOwned,
      };
    }
    return { accepted: true };
  });

  try {
    await runWithMockedNow(async ({ advance }) => {
      service.start();
      await flushAgentSessionSync();
      for (let i = 1; i < FEA3425_ROUNDS; i += 1) {
        advance(TARGET_NOT_OWNED_BACKOFF_MS + 1);
        service.refresh();
        await flushAgentSessionSync();
      }
      assert.equal(attempts, FEA3425_ROUNDS);
      assert.equal(service.getSyncProgress().deadLetteredSessions, 0);

      // Identity re-resolved (e.g. a fresh hello ack): the batch drains.
      targetOwned = true;
      advance(TARGET_NOT_OWNED_BACKOFF_MS + 1);
      service.refresh();
      await flushAgentSessionSync();
      assert.equal(attempts, FEA3425_ROUNDS + 1);
      assert.equal(service.getSyncProgress().deadLetteredSessions, 0);
    });
  } finally {
    service.stop();
  }
});
