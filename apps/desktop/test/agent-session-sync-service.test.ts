import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import type {
  AgentSessionSyncBatch,
  AgentSessionSyncTransportPayload,
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
  type AgentSessionSyncServiceOptions,
  type AgentSessionSyncSource,
  buildAgentComponentSyncSourceKey,
  buildAgentSessionSyncSourceKey,
  INGESTION_FAILED_BACKOFF_MS,
  MAX_CONSECUTIVE_INGESTION_FAILED,
  MAX_CONSECUTIVE_RATE_LIMITED,
  MAX_CONSECUTIVE_TIMEOUTS,
  type PersistedSyncState,
  RATE_LIMIT_BACKOFF_MS,
  SESSION_PAYLOAD_BYTE_CAP,
} from "../src/main/agent-session-sync-service.js";
import type { DesktopSyncBatchEventInput } from "../src/main/app-otel-runtime.js";
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
  await flushAgentSessionSync();
  service.refresh();
  await flushAgentSessionSync();
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

const SYNC_TELEMETRY_ALLOWED_KEYS = new Set([
  "outcome",
  "payloadBytes",
  "latencyMs",
]);

// Returns any emitted attribute keys outside the transport-health allowlist, so
// the assertion stays inside each test() (Biome noMisplacedAssertion).
function leakedSyncTelemetryKeys(
  events: DesktopSyncBatchEventInput[]
): string[] {
  return events
    .flatMap((event) => Object.keys(event))
    .filter((key) => !SYNC_TELEMETRY_ALLOWED_KEYS.has(key));
}

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
  await flushAgentSessionSync();
  service.stop();

  assert.equal(sync.length, 1);
  assert.equal(sync[0].outcome, "success");
  assert.ok(
    typeof sync[0].payloadBytes === "number" && sync[0].payloadBytes > 0,
    "success event carries a positive payload byte count"
  );
  assert.ok(
    typeof sync[0].latencyMs === "number" && sync[0].latencyMs >= 0,
    "success event carries a non-negative latency"
  );
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
  assert.equal(sync[0].outcome, "failure");
  assert.ok(
    typeof sync[0].latencyMs === "number" && sync[0].latencyMs >= 0,
    "failure event carries a measured latency"
  );
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
      ...Array.from({ length: MAX_CONSECUTIVE_TIMEOUTS - 1 }, () => "failure"),
      "dead_letter",
    ]
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
  await flushAgentSessionSync();
  service.stop();

  const deadLetters = sync.filter((event) => event.outcome === "dead_letter");
  assert.equal(
    deadLetters.length,
    1,
    "oversized local session dead-letters once"
  );
  assert.equal(
    deadLetters[0].latencyMs,
    undefined,
    "pre-send dead-letter omits latency"
  );
  assert.ok(
    typeof deadLetters[0].payloadBytes === "number",
    "dead-letter still reports the offending payload size"
  );
  // The healthy session that did send produces a separate success event.
  assert.ok(sync.some((event) => event.outcome === "success"));
  assert.deepEqual(leakedSyncTelemetryKeys(sync), []);
});

test("FEA-1995: a validation_failed ack emits a dead_letter outcome", async () => {
  // validation_failed dead-letters on the FIRST failure (no counter), so it is
  // the simplest path that grows deadLetteredIds — guards the failure-vs-
  // dead_letter discrimination from a deadLetteredCountBefore regression.
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

  service.start();
  await flushAgentSessionSync();
  service.stop();

  assert.equal(sync.length, 1);
  assert.equal(sync[0].outcome, "dead_letter");
  assert.deepEqual(leakedSyncTelemetryKeys(sync), []);
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
        () => "failure"
      ),
      "dead_letter",
    ]
  );
  assert.deepEqual(leakedSyncTelemetryKeys(sync), []);
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
        () => "failure"
      ),
      "dead_letter",
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
  assert.equal(sync[0].outcome, "failure");
  assert.ok(
    typeof sync[0].payloadBytes === "number" && sync[0].payloadBytes > 0,
    "a thrown-transport failure still reports the attempted payload size"
  );
  assert.ok(
    typeof sync[0].latencyMs === "number" && sync[0].latencyMs >= 0,
    "a thrown-transport failure reports a measured latency"
  );
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

test("FEA-2258: a dead-lettered ingestion_failed row recovers on the next restart", async () => {
  // The recovery path for the FEA-2258 NUL/lone-surrogate fix: a session that
  // the server keeps rejecting with ingestion_failed dead-letters locally after
  // MAX_CONSECUTIVE_INGESTION_FAILED attempts, but `deadLetteredIds` blocks
  // persistCursorIfCaughtUp, so the cursor never advances past it. A restart (the
  // user relaunching after the server sanitization deploys) therefore re-attempts
  // and accepts it instead of skipping it forever.
  const source = new FakeSyncSource([
    makeSyncedSession("recovers", "2026-06-08T12:00:00.000Z"),
  ]);
  const first = makeServiceWithIdentity(
    source,
    async () => ({
      accepted: false,
      reason: DesktopAgentSessionsAckReason.IngestionFailed,
    }),
    "target-a"
  );
  await runWithMockedNow(async ({ advance }) => {
    first.start();
    await flushAgentSessionSync();
    // Drive the remaining attempts past the per-session backoff until it
    // dead-letters at the threshold.
    for (let i = 1; i < MAX_CONSECUTIVE_INGESTION_FAILED; i += 1) {
      advance(INGESTION_FAILED_BACKOFF_MS + 1);
      first.refresh();
      await flushAgentSessionSync();
    }
  });
  first.stop();
  assert.equal(
    source.advanceCalls.length,
    0,
    "the cursor must not advance past a dead-lettered session"
  );

  // Restart: same identity + source, the server now accepts.
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
    [["recovers"]],
    "a restart must re-attempt the previously dead-lettered ingestion_failed row"
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

// ---------------------------------------------------------------------------
// FEA-2733: getSyncProgress() — the content-blind snapshot that drives the
// renderer "syncing your history" indicator. These assert the state machine
// the UI depends on: a draining first-connect backfill settles to caughtUp,
// an empty store is caught up after the first pass, and caughtUp never leaks
// across a compute-target (account) switch.
// ---------------------------------------------------------------------------

test("getSyncProgress reflects a draining first-connect backfill, then settles to caught up", async () => {
  const source = new FakeSyncSource([
    makeSyncedSession("session-1", "2026-06-08T12:01:00.000Z"),
    makeSyncedSession("session-2", "2026-06-08T12:02:00.000Z"),
    makeSyncedSession("session-3", "2026-06-08T12:03:00.000Z"),
    makeSyncedSession("session-4", "2026-06-08T12:04:00.000Z"),
  ]);
  const service = makeServiceWithIdentity(
    source,
    async () => ({ accepted: true }),
    "target-progress"
  );

  // Before the first tick: identified (identity known from options) but the
  // walk has not enumerated history yet — must NOT report "up to date".
  assert.equal(service.getSyncProgress().caughtUp, false);
  assert.equal(service.getSyncProgress().identified, true);

  // Tick 1 enqueues all four historical sessions and sends the first backfill
  // batch (BACKFILL_SESSION_BATCH_SIZE = 3), leaving one queued.
  service.start();
  await flushAgentSessionSync();
  assert.deepEqual(service.getSyncProgress(), {
    identified: true,
    pendingBackfillSessions: 1,
    pendingIncrementalSessions: 0,
    backfilling: true,
    caughtUp: false,
    deadLetteredSessions: 0,
  });

  // Tick 2 drains the last session — the queues empty and the snapshot settles.
  // Assert BEFORE stop(): stop() → resetSourceState() zeroes the flag and queues,
  // so a post-stop snapshot would read a cleared state, not the settled one.
  service.refresh();
  await flushAgentSessionSync();
  assert.deepEqual(service.getSyncProgress(), {
    identified: true,
    pendingBackfillSessions: 0,
    pendingIncrementalSessions: 0,
    backfilling: false,
    caughtUp: true,
    deadLetteredSessions: 0,
  });
  service.stop();
});

test("getSyncProgress reports caught up for an empty local store after the first pass", async () => {
  const source = new FakeSyncSource([]);
  const service = makeServiceWithIdentity(
    source,
    async () => ({ accepted: true }),
    "target-empty"
  );

  // Nothing enumerated yet → not caught up (avoids a premature "up to date").
  assert.equal(service.getSyncProgress().caughtUp, false);

  service.start();
  await flushAgentSessionSync();

  // The initial enumeration ran (0 rows) so there is genuinely nothing to
  // sync: caught up, not backfilling, nothing pending. Assert before stop(),
  // which would otherwise clear the flag/queues this snapshot reads.
  assert.deepEqual(service.getSyncProgress(), {
    identified: true,
    pendingBackfillSessions: 0,
    pendingIncrementalSessions: 0,
    backfilling: false,
    caughtUp: true,
    deadLetteredSessions: 0,
  });
  service.stop();
});

test("getSyncProgress never leaks a caught-up state across a compute-target switch", async () => {
  const source = new FakeSyncSource([
    makeSyncedSession("session-1", "2026-06-08T12:01:00.000Z"),
    makeSyncedSession("session-2", "2026-06-08T12:02:00.000Z"),
    makeSyncedSession("session-3", "2026-06-08T12:03:00.000Z"),
    makeSyncedSession("session-4", "2026-06-08T12:04:00.000Z"),
  ]);
  let currentTarget = "target-A";
  const service = new AgentSessionSyncService({
    isAgentMonitorEnabled: () => true,
    isRelayReady: () => true,
    getSource: () => source,
    getSyncComputeTargetId: () => currentTarget,
    sendBatch: async () => ({ accepted: true }),
  });

  // Fully drain the backfill for account A → caught up.
  service.start();
  await flushAgentSessionSync();
  service.refresh();
  await flushAgentSessionSync();
  assert.equal(service.getSyncProgress().caughtUp, true);

  // Switch accounts. The next tick re-hydrates for the new identity (no seeded
  // cursor) and restarts the full backfill — the snapshot must report account
  // B's in-progress walk, never account A's stale "up to date".
  currentTarget = "target-B";
  service.refresh();
  await flushAgentSessionSync();

  // Assert before stop(): stop() clears the queues this snapshot reads.
  const progress = service.getSyncProgress();
  assert.equal(progress.caughtUp, false);
  assert.equal(progress.backfilling, true);
  assert.equal(progress.pendingBackfillSessions, 1);
  service.stop();
});

test("getSyncProgress settles to caught up on a resumed persisted cursor (already-synced restart)", async () => {
  // An already-synced user restarts: `hydratePersistedCursorIfNeeded` resumes
  // the persisted cursor and `initializeBackfillQueueIfNeeded` skips the full
  // walk. `initialBackfillPassRun` must still flip on that skip path, or the
  // indicator latches on "checking" forever instead of "up to date".
  const source = new FakeSyncSource([
    makeSyncedSession("old", "2026-06-08T12:00:00.000Z"),
    makeSyncedSession("top", "2026-06-08T12:05:00.000Z"),
  ]);
  const key = buildAgentSessionSyncSourceKey("target-resumed");
  source.seedSyncState(key, {
    observedTopUpdatedAt: "2026-06-08T12:05:00.000Z",
    observedIdsAtTopUpdatedAt: ["top"],
  });
  const service = makeServiceWithIdentity(
    source,
    async () => ({ accepted: true }),
    "target-resumed"
  );

  service.start();
  await flushAgentSessionSync();

  // No backfill was queued (cursor resumed) yet the snapshot is caught up.
  const progress = service.getSyncProgress();
  assert.equal(progress.caughtUp, true);
  assert.equal(progress.backfilling, false);
  assert.equal(progress.pendingBackfillSessions, 0);
  service.stop();
});

/**
 * Run `body` with `Date.now` pinned to a mutable virtual clock, restoring the
 * real `Date.now` afterward even if `body` throws. The sync service reads
 * `Date.now` for per-session backoff scheduling but drives flushing with real
 * timers/promises, so we mock only the clock (not the timer queue) and advance
 * it explicitly via the `advance(ms)` passed to `body`. The owned try/finally
 * cleanup keeps the global mutation from leaking across tests on failure.
 */
async function runWithMockedNow(
  body: (clock: { advance: (ms: number) => void }) => Promise<void>
): Promise<void> {
  const realNow = Date.now;
  let virtualNow = realNow();
  Date.now = () => virtualNow;
  try {
    await body({
      advance: (ms) => {
        virtualNow += ms;
      },
    });
  } finally {
    Date.now = realNow;
  }
}

class FakeSyncSource implements AgentSessionSyncSource {
  private readonly sessions = new Map<string, SyncedAgentSession>();
  /** FEA-1962: in-memory stand-in for the sqlite `sync_state` table. */
  private readonly syncStates = new Map<string, PersistedSyncState>();
  /** FEA-1962: records every advanceSyncState call so tests can assert timing. */
  readonly advanceCalls: Array<{
    sourceKey: string;
    state: PersistedSyncState;
  }> = [];
  findLocallyOversizedCallCount = 0;
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
    this.findLocallyOversizedCallCount += 1;
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

/**
 * FEA-2718: still exposes the retired raw-event-`data` "unhydratable" gate (which
 * `AgentSessionSyncSource` no longer declares) so a test can prove the sync path
 * never consults it. Flags every candidate as unhydratable — if the gate were
 * still wired up, every session would be dead-lettered.
 */
class UnhydratableFlaggingSyncSource extends FakeSyncSource {
  findLocallyUnhydratableCallCount = 0;

  findLocallyUnhydratableSessions(ids: string[], _maxBytes: number) {
    this.findLocallyUnhydratableCallCount += 1;
    return ids.map((id) => ({ id, payloadBytes: Number.MAX_SAFE_INTEGER }));
  }
}

function makeService(
  source: AgentSessionSyncSource,
  sendBatch: (
    batch: AgentSessionSyncTransportPayload
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

function makeServiceCapturingSyncTelemetry(
  source: AgentSessionSyncSource,
  sendBatch: AgentSessionSyncServiceOptions["sendBatch"],
  capture: {
    sync: DesktopSyncBatchEventInput[];
    batchOutcome?: AgentSessionSyncServiceOptions["onBatchOutcome"];
  }
) {
  return new AgentSessionSyncService({
    isAgentMonitorEnabled: () => true,
    isRelayReady: () => true,
    getSource: () => source,
    sendBatch,
    onSyncBatchTelemetry: (event) => {
      capture.sync.push(event);
    },
    onBatchOutcome: capture.batchOutcome,
  });
}

function makeServiceWithIdentity(
  source: AgentSessionSyncSource,
  sendBatch: (
    batch: AgentSessionSyncTransportPayload
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
  // FEA-2718: turn text (`data`) is stripped before sync, so a session is only
  // oversized by its RETAINED columnar fields — here, a very large event array
  // whose slim per-event metadata still overflows the byte cap and must chunk.
  const events = Array.from({ length: 4000 }, (_, index) => ({
    externalEventId: `${id}-event-${index}`,
    eventType: "ToolUse",
    toolName: "Read",
    createdAt: "2026-06-08T12:00:00.000Z",
  }));
  return makeSyncedSession(id, "2026-06-08T12:00:00.000Z", events);
}

function makeUnchunkableOversizedSession(
  id: string,
  updatedAt: string
): SyncedAgentSession {
  // FEA-2718: chunking paginates the event array but replicates every agent into
  // each chunk, so a session whose agents alone exceed the cap can never produce
  // a valid chunk and is dead-lettered locally.
  return {
    ...makeSyncedSession(id, updatedAt, [
      {
        externalEventId: `${id}-event`,
        eventType: "ToolUse",
        toolName: "Read",
        createdAt: "2026-06-08T12:00:00.000Z",
      },
    ]),
    agents: Array.from({ length: 5000 }, (_, index) => ({
      externalAgentId: `${id}-agent-${index}`,
      name: `agent-${index}`,
      type: "subagent",
      status: "completed",
    })),
  };
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
    isAgentMonitorEnabled: () => true,
    isRelayReady: () => true,
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
      return true;
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
