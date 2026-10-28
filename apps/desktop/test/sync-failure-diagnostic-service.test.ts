/**
 * ISS-7248 — the acceptance tests for the failed-sync diagnostic, driven through
 * the real `AgentSessionSyncService`.
 *
 * These assert on the DURABLE sink (`gatewayLog`'s entries, which is what
 * `writeGatewayLogEntry` persists into the rotating `main.log`) rather than on
 * incidental log lines. That sink IS the contract under test: the whole point of
 * the ticket is that a record exists after the failure, on a path with no shared
 * fate with the send that just failed.
 */
import assert from "node:assert/strict";
import { SyncPayloadShaping } from "@closedloop-ai/telemetry-contract/sync";
import { test } from "vitest";
import {
  MAX_CONSECUTIVE_TRANSPORT_TIMEOUTS,
  SESSION_LANE_STALL_CEILING_MS,
  SESSION_LANE_STALL_RETRY_MS,
  TRANSPORT_TIMEOUT_BACKOFF_MS,
} from "../src/main/agent-sync/agent-session-sync-backoff-policy.js";
import {
  SYNC_FAILURE_DIAGNOSTIC_PREFIX,
  SYNC_FAILURE_DIAGNOSTIC_SCHEMA,
  type SyncFailureDiagnostic,
} from "../src/main/agent-sync/sync-failure-diagnostic.js";
import { DesktopAgentSessionsAckReason } from "../src/main/cloud/cloud-protocol.js";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import { DesktopSyncBatchOutcome } from "../src/main/telemetry/app-otel-runtime.js";
import {
  flushAgentSessionSync,
  makeOversizedSession,
  makeService,
  makeSessionWithLargeTiling,
  PAST_ANY_LANE_ENVIRONMENTAL_RUNG_MS,
  runWithMockedNow,
} from "./agent-session-sync-service-fixtures.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";

/** Drain the durable sink and return the diagnostics it received, in order. */
function drainDiagnostics(): SyncFailureDiagnostic[] {
  const records = gatewayLog
    .getEntries()
    .filter((entry) => entry.message.startsWith(SYNC_FAILURE_DIAGNOSTIC_PREFIX))
    .map(
      (entry) =>
        JSON.parse(
          entry.message.slice(SYNC_FAILURE_DIAGNOSTIC_PREFIX.length)
        ) as SyncFailureDiagnostic
    );
  gatewayLog.clear();
  return records;
}

test("ISS-7248: one failed sync attempt leaves exactly one durable diagnostic", async () => {
  gatewayLog.clear();
  const source = new FakeSyncSource([
    makeSyncedSession("failing-session", "2026-06-08T12:00:00.000Z"),
  ]);
  const service = makeService(source, async () => ({
    accepted: false,
    reason: DesktopAgentSessionsAckReason.IngestionFailed,
  }));

  service.start();
  await flushAgentSessionSync();
  service.stop();

  const records = drainDiagnostics();
  assert.equal(records.length, 1, "not zero, and not one per sink");
  const [record] = records;
  assert.equal(record.schema, SYNC_FAILURE_DIAGNOSTIC_SCHEMA);
  assert.equal(record.outcome, DesktopSyncBatchOutcome.Failure);
  assert.equal(record.reason, DesktopAgentSessionsAckReason.IngestionFailed);
  assert.deepEqual(record.sessionIds, ["failing-session"]);
  assert.equal(record.sessionCount, 1);
  assert.equal(record.attempt, 1);
  assert.equal(record.payloadShaping, SyncPayloadShaping.Whole);
  assert.ok(record.payloadBytes > 0, "the attempted payload size is recorded");
  assert.ok(record.batchId.length > 0, "the server-join key is recorded");
});

test("ISS-7248: a poisoned record is identifiable from the diagnostics alone", async () => {
  gatewayLog.clear();
  const source = new FakeSyncSource([
    makeSyncedSession("poisoned-session", "2026-06-08T12:00:00.000Z"),
  ]);
  const service = makeService(source, async () => ({
    accepted: false,
    reason: DesktopAgentSessionsAckReason.IngestionFailed,
  }));

  // ISS-7730: `ingestion_failed` is lane-wide and burns no per-row budget, so
  // the dead-letter is reached by the WALL CLOCK, not by an attempt count.
  // Three attempts inside the stall ceiling, then one past it. The attempt
  // TALLY still rises across all four — that is what keeps this diagnostic able
  // to say how hard the lane tried, and it is a tally precisely because no
  // terminal path reads it.
  //
  // ISS-8610 CHANGED HOW FAR EACH ATTEMPT ADVANCES, deliberately: the defer now
  // stages off the run's age, so one class floor no longer clears a rung past
  // the first. Advancing past the ladder's per-delay cap keeps this case driving
  // the same four attempts it was written to drive.
  const ATTEMPTS_INSIDE_CEILING = 3;
  await runWithMockedNow(async ({ advance }) => {
    service.start();
    await flushAgentSessionSync();
    for (let i = 1; i < ATTEMPTS_INSIDE_CEILING; i += 1) {
      advance(PAST_ANY_LANE_ENVIRONMENTAL_RUNG_MS);
      service.refresh();
      await flushAgentSessionSync();
    }
    advance(SESSION_LANE_STALL_CEILING_MS + 1);
    service.refresh();
    await flushAgentSessionSync();
  });
  service.stop();

  const expectedRecords = ATTEMPTS_INSIDE_CEILING + 1;
  const records = drainDiagnostics();
  assert.equal(
    records.length,
    expectedRecords,
    "one diagnostic per failed attempt, through the wall-clock dead-letter"
  );
  assert.deepEqual(
    records.map((record) => record.attempt),
    Array.from({ length: expectedRecords }, (_x, i) => i + 1),
    "the attempt number rises, so a retry is distinguishable from a first failure"
  );
  assert.deepEqual(
    records.map((record) => record.sessionIds),
    Array.from({ length: expectedRecords }, () => ["poisoned-session"]),
    "the same session id repeating across attempts IS the poisoned-record signal"
  );
  assert.deepEqual(
    records.map((record) => record.outcome),
    [
      ...Array.from(
        { length: ATTEMPTS_INSIDE_CEILING },
        () => DesktopSyncBatchOutcome.Failure
      ),
      DesktopSyncBatchOutcome.DeadLetter,
    ],
    "every attempt inside the ceiling is a plain failure; only the one past it dead-letters"
  );
  assert.equal(
    new Set(records.map((record) => record.batchId)).size,
    expectedRecords,
    "each attempt carries its own join key, so attempts never collapse together"
  );
});

test("ISS-7248: a retry that succeeds records the failures and not the success", async () => {
  gatewayLog.clear();
  const source = new FakeSyncSource([
    makeSyncedSession("recovering-session", "2026-06-08T12:00:00.000Z"),
  ]);
  let sends = 0;
  const service = makeService(source, () => {
    sends += 1;
    return Promise.resolve(
      sends === 1
        ? {
            accepted: false,
            reason: DesktopAgentSessionsAckReason.IngestionFailed,
          }
        : { accepted: true }
    );
  });

  await runWithMockedNow(async ({ advance }) => {
    service.start();
    await flushAgentSessionSync();
    advance(SESSION_LANE_STALL_RETRY_MS + 1);
    service.refresh();
    await flushAgentSessionSync();
  });
  service.stop();

  assert.equal(sends, 2, "the batch was retried after the first rejection");
  const records = drainDiagnostics();
  assert.equal(
    records.length,
    1,
    "a succeeding retry must not add a diagnostic of its own"
  );
  assert.equal(records[0].attempt, 1);
});

test("ISS-7248: a transport_timeout attempt is counted, not reported as a first failure", async () => {
  gatewayLog.clear();
  const source = new FakeSyncSource([
    makeSyncedSession("stalled-session", "2026-06-08T12:00:00.000Z"),
  ]);
  const service = makeService(source, async () => ({
    accepted: false,
    reason: DesktopAgentSessionsAckReason.TransportTimeout,
  }));

  await runWithMockedNow(async ({ advance }) => {
    service.start();
    await flushAgentSessionSync();
    for (let i = 1; i < MAX_CONSECUTIVE_TRANSPORT_TIMEOUTS; i += 1) {
      advance(TRANSPORT_TIMEOUT_BACKOFF_MS + 1);
      service.refresh();
      await flushAgentSessionSync();
    }
  });
  service.stop();

  const records = drainDiagnostics();
  assert.deepEqual(
    records.map((record) => record.attempt),
    Array.from(
      { length: MAX_CONSECUTIVE_TRANSPORT_TIMEOUTS },
      (_x, i) => i + 1
    ),
    "transport_timeout charges TransportTimeoutBudget's private counter, which the attempt resolution must read"
  );
  assert.equal(
    records.at(-1)?.outcome,
    DesktopSyncBatchOutcome.DeadLetter,
    "the exhausted attempt is a dead letter"
  );
  assert.equal(
    records.at(-1)?.attempt,
    MAX_CONSECUTIVE_TRANSPORT_TIMEOUTS,
    "the exhausted record must report the budget it burned, not a fabricated 1"
  );
});

test("ISS-7248: an auth-loss deferral inherits no other class's retry count", async () => {
  gatewayLog.clear();
  const source = new FakeSyncSource([
    makeSyncedSession("deferred-session", "2026-06-08T12:00:00.000Z"),
  ]);
  let sends = 0;
  const service = makeService(source, () => {
    sends += 1;
    // Burn a real ingestion_failed charge first, then lose auth. The second
    // failure spends nothing, so it must report no attempt at all.
    return Promise.resolve({
      accepted: false,
      reason:
        sends === 1
          ? DesktopAgentSessionsAckReason.IngestionFailed
          : DesktopAgentSessionsAckReason.Unauthenticated,
    });
  });

  await runWithMockedNow(async ({ advance }) => {
    service.start();
    await flushAgentSessionSync();
    advance(SESSION_LANE_STALL_RETRY_MS + 1);
    service.refresh();
    await flushAgentSessionSync();
  });
  service.stop();

  const records = drainDiagnostics();
  assert.equal(records.length, 2);
  assert.equal(records[0].attempt, 1, "the ingestion_failed charge is real");
  assert.equal(
    records[1].reason,
    DesktopAgentSessionsAckReason.Unauthenticated
  );
  assert.equal(
    "attempt" in records[1],
    false,
    "unauthenticated defers with budgets intact, so it has no attempt to report"
  );
});

/** Drain a chunked session to completion, returning how many chunks it took. */
async function countChunksToSync(sessionId: string): Promise<number> {
  const source = new FakeSyncSource([makeOversizedSession(sessionId)]);
  let sends = 0;
  const service = makeService(source, () => {
    sends += 1;
    return Promise.resolve({ accepted: true });
  });
  service.start();
  for (let tick = 0; tick < 40; tick += 1) {
    service.refresh();
    await flushAgentSessionSync();
  }
  service.stop();
  gatewayLog.clear();
  return sends;
}

test("ISS-7248: a LAST-chunk throw abandons no tail and must not claim it did", async () => {
  const chunkCount = await countChunksToSync("chunk-probe");
  assert.ok(
    chunkCount > 1,
    "the fixture must actually chunk for this scenario to exist"
  );

  gatewayLog.clear();
  const source = new FakeSyncSource([makeOversizedSession("chunked-session")]);
  let sends = 0;
  const service = makeService(source, () => {
    sends += 1;
    if (sends === chunkCount) {
      throw new Error("socket closed on the final chunk");
    }
    return Promise.resolve({ accepted: true });
  });

  service.start();
  for (let tick = 0; tick < 40; tick += 1) {
    service.refresh();
    await flushAgentSessionSync();
  }
  service.stop();

  const records = drainDiagnostics();
  assert.equal(records.length, 1, "only the final chunk failed");
  assert.equal(
    records[0].payloadShaping,
    SyncPayloadShaping.ChunkedTail,
    "the final chunk's tail was already emptied when it was shifted off, so this attempt abandoned nothing — reporting chunk_tail_discarded would invent an abandoned sequence"
  );
});

test("ISS-7248: a thrown transport error is recorded, not only logged", async () => {
  gatewayLog.clear();
  const source = new FakeSyncSource([
    makeSyncedSession("thrown-session", "2026-06-08T12:00:00.000Z"),
  ]);
  const service = makeService(source, () => {
    throw new Error("socket closed");
  });

  service.start();
  await flushAgentSessionSync();
  service.stop();

  const records = drainDiagnostics();
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].sessionIds, ["thrown-session"]);
  assert.equal(records[0].attempt, 1);
});

test("ISS-7265: a failed sync of a tiling-stripped batch reports the strip, not a whole payload", async () => {
  gatewayLog.clear();
  // Multi-part tiling support is OFF by default on the fixture service, so an
  // oversized tiling takes the ISS-4578 bounded fallback and ships stripped.
  const source = new FakeSyncSource([makeSessionWithLargeTiling("strip-lane")]);
  const service = makeService(source, async () => ({
    accepted: false,
    reason: DesktopAgentSessionsAckReason.IngestionFailed,
  }));

  service.start();
  await flushAgentSessionSync();
  service.stop();

  const records = drainDiagnostics();
  assert.ok(records.length > 0, "the failed attempt must leave a record");
  const [record] = records;
  assert.equal(
    record.payloadShaping,
    SyncPayloadShaping.TilingStripped,
    "the payload-size hypothesis is only testable from telemetry if the strip reaches it"
  );
  assert.equal(record.tilingStrippedSessionCount, 1);
});

test("ISS-7265: a failed sync of an intact batch reports no strip", async () => {
  gatewayLog.clear();
  const source = new FakeSyncSource([
    makeSyncedSession("intact-lane", "2026-06-08T12:00:00.000Z"),
  ]);
  const service = makeService(source, async () => ({
    accepted: false,
    reason: DesktopAgentSessionsAckReason.IngestionFailed,
  }));

  service.start();
  await flushAgentSessionSync();
  service.stop();

  const [record] = drainDiagnostics();
  assert.equal(record.payloadShaping, SyncPayloadShaping.Whole);
  assert.equal(
    "tilingStrippedSessionCount" in record,
    false,
    "a batch that stripped nothing must not carry the strip count"
  );
});
