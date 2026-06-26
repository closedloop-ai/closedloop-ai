import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import type {
  AgentSessionSyncBatch,
  SyncedAgentSession,
} from "../src/main/agent-session-sync-contract.js";
import { AGENT_SESSION_SYNC_SCHEMA_VERSION } from "../src/main/agent-session-sync-contract.js";
import {
  estimateAgentSessionSyncBatchBytes,
  maxSessionPayloadBytesForBatch,
  prepareAgentSessionPayload,
} from "../src/main/agent-session-sync-payload.js";
import {
  AgentSessionSyncService,
  type AgentSessionSyncSource,
  buildAgentSessionSyncSourceKey,
  MAX_CONSECUTIVE_RATE_LIMITED,
  MAX_CONSECUTIVE_TIMEOUTS,
  type PersistedSyncState,
  RATE_LIMIT_BACKOFF_MS,
  SESSION_PAYLOAD_BYTE_CAP,
} from "../src/main/agent-session-sync-service.js";
import { DesktopAgentSessionsAckReason } from "../src/main/cloud-protocol.js";

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
  await flushAgentSessionSync();
  service.refresh();
  await flushAgentSessionSync();
  service.stop();

  assert.equal(sent.length, 2);
  assert.deepEqual(
    sent[0].sessions.map((session) => session.externalSessionId),
    ["session-4", "session-3", "session-2"]
  );
  assert.deepEqual(
    sent[1].sessions.map((session) => session.externalSessionId),
    ["session-1"]
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
  await flushAgentSessionSync();
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

test("agent-session sync drops validation_failed sessions to avoid permanent stalls", async () => {
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

  service.start();
  await flushAgentSessionSync();
  service.refresh();
  await flushAgentSessionSync();
  service.stop();

  assert.equal(attempts, 1);
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

  const realNow = Date.now;
  try {
    let virtualNow = realNow();
    Date.now = () => virtualNow;
    service.start();
    await flushAgentSessionSync();
    for (let i = 1; i < MAX_CONSECUTIVE_RATE_LIMITED; i += 1) {
      virtualNow += RATE_LIMIT_BACKOFF_MS + 1;
      service.refresh();
      await flushAgentSessionSync();
    }
    virtualNow += RATE_LIMIT_BACKOFF_MS + 1;
    service.refresh();
    await flushAgentSessionSync();
  } finally {
    Date.now = realNow;
    service.stop();
  }

  assert.equal(attempts, MAX_CONSECUTIVE_RATE_LIMITED);
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
  await flushAgentSessionSync();
  source.upsert(makeSyncedSession("new-at-top", topTimestamp));
  service.refresh();
  await flushAgentSessionSync();
  service.stop();

  assert.deepEqual(sent[0], ["existing-b", "existing-a"]);
  assert.deepEqual(sent[1], ["new-at-top"]);
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
    isAgentMonitorEnabled: () => true,
    isRelayReady: () => true,
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
    isAgentMonitorEnabled: () => true,
    isRelayReady: () => true,
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
    isAgentMonitorEnabled: () => true,
    isRelayReady: () => relayReady,
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
  await flushAgentSessionSync();
  service.stop();

  assert.deepEqual(sent, [["c", "b", "a"]]);
  assert.equal(source.advanceCalls.length, 1);
  assert.equal(
    source.advanceCalls[0].state.observedTopUpdatedAt,
    "2026-06-08T12:03:00.000Z"
  );
  assert.deepEqual(source.advanceCalls[0].state.observedIdsAtTopUpdatedAt, [
    "c",
  ]);
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
  await flushAgentSessionSync();
  service.stop();

  assert.deepEqual(
    sent,
    [["b", "a"]],
    "a different compute target must perform a full backfill"
  );
});

test("agent-session sync persists the cursor only once both queues drain", async () => {
  const source = new FakeSyncSource([
    makeSyncedSession("s1", "2026-06-08T12:01:00.000Z"),
    makeSyncedSession("s2", "2026-06-08T12:02:00.000Z"),
    makeSyncedSession("s3", "2026-06-08T12:03:00.000Z"),
    makeSyncedSession("s4", "2026-06-08T12:04:00.000Z"),
  ]);
  const service = makeServiceWithIdentity(
    source,
    async () => ({ accepted: true }),
    "target-a"
  );

  service.start();
  await flushAgentSessionSync();
  assert.equal(
    source.advanceCalls.length,
    0,
    "must not persist a watermark while rows remain queued"
  );
  service.refresh();
  await flushAgentSessionSync();
  service.stop();

  assert.equal(source.advanceCalls.length, 1);
  assert.equal(
    source.advanceCalls[0].state.observedTopUpdatedAt,
    "2026-06-08T12:04:00.000Z"
  );
});

test("agent-session sync does not persist a cursor past a dead-lettered row", async () => {
  // A row that always times out is dead-lettered (dequeued) but was never
  // uploaded. A later accepted row would otherwise drain both queues and let
  // persistCursorIfCaughtUp advance the watermark past the lost row — which is
  // permanent because the cursor is rehydrated on restart.
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

  assert.equal(
    source.advanceCalls.length,
    0,
    "the watermark must not advance while any row is dead-lettered"
  );
});

test("agent-session sync does not persist a validation_failed id as accepted", async () => {
  // A validation_failed id is dropped (not retried this session, to avoid a
  // stall), but it was never accepted. It must not be recorded in the persisted
  // cursor — otherwise a restart would treat it as accepted and skip it forever.
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

  service.start();
  await flushAgentSessionSync();
  // A later healthy row is accepted and drains the queues; persistence must
  // still be blocked because "bad" was never uploaded.
  source.upsert(makeSyncedSession("ok", "2026-06-08T12:05:00.000Z"));
  service.refresh();
  await flushAgentSessionSync();
  service.stop();

  assert.equal(
    source.advanceCalls.length,
    0,
    "the watermark must not advance while a validation_failed row is unuploaded"
  );
});

test("agent-session sync re-discovers a validation_failed row on a fresh restart", async () => {
  // Because the validation_failed row is never persisted as accepted, a cold
  // start (new service instance, same target + source) re-backfills it rather
  // than skipping it permanently.
  const source = new FakeSyncSource([
    makeSyncedSession("bad", "2026-06-08T12:00:00.000Z"),
  ]);
  const first = makeServiceWithIdentity(
    source,
    async () => ({
      accepted: false,
      reason: DesktopAgentSessionsAckReason.ValidationFailed,
    }),
    "target-a"
  );
  first.start();
  await flushAgentSessionSync();
  first.stop();
  assert.equal(
    source.advanceCalls.length,
    0,
    "nothing should be persisted after a validation failure"
  );

  // Restart: a new instance with the same identity and source.
  const sent: string[][] = [];
  const restarted = makeServiceWithIdentity(
    source,
    async (batch) => {
      sent.push(batch.sessions.map((session) => session.externalSessionId));
      return { accepted: true };
    },
    "target-a"
  );
  restarted.start();
  await flushAgentSessionSync();
  restarted.stop();

  assert.deepEqual(
    sent,
    [["bad"]],
    "a restart must re-attempt the previously validation_failed row"
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

  assert.deepEqual(sent, []);
  assert.equal(source.advanceCalls.length, 0);

  source.onLoad = () => undefined;
  service.refresh();
  await flushAgentSessionSync();
  service.stop();

  assert.deepEqual(sent, [["reset-session"]]);
  assert.equal(source.advanceCalls.length, 1);
});

class FakeSyncSource implements AgentSessionSyncSource {
  private readonly sessions = new Map<string, SyncedAgentSession>();
  /** FEA-1962: in-memory stand-in for the sqlite `sync_state` table. */
  private readonly syncStates = new Map<string, PersistedSyncState>();
  /** FEA-1962: records every advanceSyncState call so tests can assert timing. */
  readonly advanceCalls: Array<{
    sourceKey: string;
    state: PersistedSyncState;
  }> = [];
  listAllCursorCallCount = 0;
  listTopCursorCallCount = 0;
  loadSyncedSessionIds: string[][] = [];

  constructor(sessions: SyncedAgentSession[]) {
    for (const session of sessions) {
      this.upsert(session);
    }
  }

  upsert(session: SyncedAgentSession): void {
    this.sessions.set(session.externalSessionId, session);
  }

  /** FEA-1962: pre-seed a persisted cursor as if a prior run had synced. */
  seedSyncState(sourceKey: string, state: PersistedSyncState): void {
    this.syncStates.set(sourceKey, state);
  }

  loadSyncState(sourceKey: string): PersistedSyncState | null {
    return this.syncStates.get(sourceKey) ?? null;
  }

  advanceSyncState(sourceKey: string, state: PersistedSyncState): void {
    this.syncStates.set(sourceKey, state);
    this.advanceCalls.push({ sourceKey, state });
  }

  listAllSessionCursorRows() {
    this.listAllCursorCallCount += 1;
    return this.cursorRows();
  }

  listTopSessionCursorRows() {
    this.listTopCursorCallCount += 1;
    const rows = this.cursorRows();
    const topUpdatedAt = rows[0]?.updated_at;
    return topUpdatedAt
      ? rows.filter((row) => row.updated_at === topUpdatedAt)
      : [];
  }

  listUpdatedSessionCursorRows(sinceUpdatedAt: string) {
    return this.cursorRows().filter((row) => row.updated_at >= sinceUpdatedAt);
  }

  loadSyncedSessions(ids: string[]) {
    this.loadSyncedSessionIds.push(ids);
    return ids
      .map((id) => this.sessions.get(id))
      .filter((session): session is SyncedAgentSession => Boolean(session));
  }

  findLocallyOversizedSessions(ids: string[], maxBytes: number) {
    return ids.flatMap((id) => {
      const session = this.sessions.get(id);
      if (!session) {
        return [];
      }
      const prepared = prepareAgentSessionPayload(session, maxBytes);
      return prepared.kind === "dead-letter"
        ? [{ id, payloadBytes: prepared.payloadBytes }]
        : [];
    });
  }

  private cursorRows() {
    return [...this.sessions.values()]
      .map((session) => ({
        id: session.externalSessionId,
        updated_at: session.updatedAt,
      }))
      .sort(
        (a, b) =>
          b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id)
      );
  }
}

class ResettingSyncSource extends FakeSyncSource {
  onLoad: () => void = () => undefined;

  override loadSyncedSessions(ids: string[]) {
    this.onLoad();
    return super.loadSyncedSessions(ids);
  }
}

function makeService(
  source: AgentSessionSyncSource,
  sendBatch: (
    batch: AgentSessionSyncBatch
  ) => Promise<
    | { accepted: true }
    | { accepted: false; reason: DesktopAgentSessionsAckReason }
  >
) {
  return new AgentSessionSyncService({
    isAgentMonitorEnabled: () => true,
    isRelayReady: () => true,
    getSource: () => source,
    sendBatch,
  });
}

function makeServiceWithIdentity(
  source: AgentSessionSyncSource,
  sendBatch: (
    batch: AgentSessionSyncBatch
  ) => Promise<
    | { accepted: true }
    | { accepted: false; reason: DesktopAgentSessionsAckReason }
  >,
  computeTargetId: string
) {
  return new AgentSessionSyncService({
    isAgentMonitorEnabled: () => true,
    isRelayReady: () => true,
    getSource: () => source,
    getSyncComputeTargetId: () => computeTargetId,
    sendBatch,
  });
}

function makeSyncedSession(
  id: string,
  updatedAt: string,
  events: SyncedAgentSession["events"] = []
): SyncedAgentSession {
  return {
    externalSessionId: id,
    status: "completed",
    harness: "codex",
    cwd: `/workspace/${id}`,
    startedAt: "2026-06-08T12:00:00.000Z",
    updatedAt,
    agents: [],
    events,
    tokenUsageByModel: [],
  };
}

function makeOversizedSession(id: string): SyncedAgentSession {
  const events = Array.from({ length: 80 }, (_, index) => ({
    externalEventId: `${id}-event-${index}`,
    eventType: "ToolUse",
    toolName: "Read",
    createdAt: "2026-06-08T12:00:00.000Z",
    data: {
      index,
      safePayload: "x".repeat(6000),
    },
  }));
  return makeSyncedSession(id, "2026-06-08T12:00:00.000Z", events);
}

function makeUnchunkableOversizedSession(
  id: string,
  updatedAt: string
): SyncedAgentSession {
  return makeSyncedSession(id, updatedAt, [
    {
      externalEventId: `${id}-event`,
      eventType: "ToolUse",
      toolName: "Read",
      createdAt: "2026-06-08T12:00:00.000Z",
      data: {
        safePayload: "x".repeat(SESSION_PAYLOAD_BYTE_CAP + 1024),
      },
    },
  ]);
}

function makeMetadataHeavyChunkCandidate(id: string): SyncedAgentSession {
  return {
    ...makeSyncedSession(
      id,
      "2026-06-08T12:00:00.000Z",
      Array.from({ length: 506 }, (_, index) => ({
        externalEventId: `${id}-event-${index}`,
        eventType: "ToolUse",
        toolName: "Read",
        createdAt: "2026-06-08T12:00:00.000Z",
        data: { index, safePayload: "x".repeat(500) },
      }))
    ),
    metadata: {
      messages: Array.from({ length: 506 }, (_, index) => ({
        role: index % 2 === 0 ? "human" : "assistant",
        timestamp: "2026-06-08T12:00:00.000Z",
        text: "x".repeat(1000),
        model: "gpt-5",
      })),
      tokenSeries: Array.from({ length: 506 }, (_, index) => ({
        timestamp: "2026-06-08T12:00:00.000Z",
        model: "gpt-5",
        input: index,
        output: index,
        extra: "x".repeat(500),
      })),
    },
  };
}

async function flushAgentSessionSync(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}
