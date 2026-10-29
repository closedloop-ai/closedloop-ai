/**
 * @file sync-payload-tiling-strip-visibility.test.ts
 * @description ISS-7265 — a sync payload that shipped WITHOUT its activity-segment
 * tiling must not be reportable as a complete one.
 *
 * The ISS-4578 bounded fallback strips the tiling to keep the rest of an
 * oversized session syncable. An absent `activitySegmentRows` is also what a
 * session with no tiling sends, so the degraded and the complete payload were
 * the same bytes and the same telemetry. These pin the three halves that make
 * the strip legible — the wire flag, the shaping value, and the count.
 */
import assert from "node:assert/strict";
import {
  SyncLane,
  SyncPayloadShaping,
  SyncReason,
} from "@closedloop-ai/telemetry-contract/sync";
import type { SyncedActivitySegmentRow } from "@repo/api/src/types/agent-session";
import { describe, test } from "vitest";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import {
  estimateSessionPayloadBytes,
  type PreparedAgentSessionPayload,
  prepareAgentSessionPayload,
  tilingStrippedSessionIds,
} from "../src/main/agent-sync/agent-session-sync-payload.js";
import {
  buildSyncFailureDiagnostic,
  reportSyncAttemptFailure,
  resolveChunkPayloadShaping,
  resolveSyncPayloadShaping,
  type SyncFailureOutcome,
} from "../src/main/agent-sync/sync-failure-diagnostic.js";
import {
  type DesktopSyncBatchEventInput,
  DesktopSyncBatchOutcome,
} from "../src/main/telemetry/app-otel-runtime.js";
import { leakedSyncTelemetryKeys } from "./agent-session-sync-service-fixtures.js";

const SEGMENT_MARKER = "segment-content-that-must-never-be-telemetry";
const BATCH_ID = "d4b6b0a2-6a3e-4f9c-8b1d-2c3e4f5a6b7c";

function buildSession(
  overrides: Partial<SyncedAgentSession> = {}
): SyncedAgentSession {
  return {
    externalSessionId: "sess-strip",
    name: "Strip session",
    status: "active",
    harness: "claude",
    cwd: "/tmp/wt",
    model: "claude-opus-4",
    startedAt: "2026-06-10T10:00:00.000Z",
    updatedAt: "2026-06-10T11:00:00.000Z",
    agents: [],
    events: [],
    tokenUsageByModel: [],
    ...overrides,
  };
}

/** A tiling too large to ride the base under the cap, forcing the strip. */
function buildOversizedTiling(): SyncedActivitySegmentRow[] {
  return Array.from({ length: 200 }, (_, index) => ({
    phase: "coding",
    startMs: index * 1000,
    endMs: index * 1000 + 999,
    confidence: 0.9,
    evidenceLayers: ["structural"],
    version: 7,
    workItemRef: `${SEGMENT_MARKER}-${"x".repeat(800)}`,
  }));
}

/** The cap the strip scenario needs: fits the tiling-less base, not the tiling. */
function capThatRejectsTheTiling(): number {
  return (
    estimateSessionPayloadBytes(buildSession({ activitySegmentRows: [] })) +
    2000
  );
}

/** Prepare with multi-part tiling support OFF — the only path that strips. */
function prepareWithoutActivityChunking(
  session: SyncedAgentSession,
  maxBytes: number
): PreparedAgentSessionPayload {
  return prepareAgentSessionPayload(
    session,
    maxBytes,
    undefined,
    undefined,
    /* activityChunkingSupported */ false
  );
}

/** The wire sessions a prepared result actually puts on the wire. */
function shippedSessions(
  prepared: PreparedAgentSessionPayload
): SyncedAgentSession[] {
  if (prepared.kind === "session") {
    return [prepared.session];
  }
  if (prepared.kind === "chunked") {
    return [prepared.firstChunk, ...prepared.remainingChunks];
  }
  return [];
}

function diagnosticFor(sessions: SyncedAgentSession[]) {
  const tilingStrippedSessionCount = tilingStrippedSessionIds(sessions).length;
  return buildSyncFailureDiagnostic({
    batchId: BATCH_ID,
    lane: SyncLane.SessionMetadata,
    outcome: DesktopSyncBatchOutcome.Failure as SyncFailureOutcome,
    reason: SyncReason.IngestionFailed,
    payloadBytes: 1234,
    sessionIds: sessions.map((session) => session.externalSessionId),
    payloadShaping: resolveSyncPayloadShaping({
      drainingPendingChunkTail: false,
      hasPinnedChunkTail: false,
      chunkTailDiscarded: false,
      activityTilingStripped: tilingStrippedSessionCount > 0,
    }),
    tilingStrippedSessionCount,
  });
}

describe("ISS-7265: a stripped sync payload is distinguishable from a complete one", () => {
  test("a stripped payload cannot be reported as complete", () => {
    const stripped = shippedSessions(
      prepareWithoutActivityChunking(
        buildSession({ activitySegmentRows: buildOversizedTiling() }),
        capThatRejectsTheTiling()
      )
    );
    assert.ok(stripped.length > 0, "the session must still ship");
    for (const part of stripped) {
      assert.equal(
        part.activitySegmentRows,
        undefined,
        "precondition: the strip happened — the tiling is absent from the wire"
      );
      assert.equal(
        part.activitySegmentRowsStripped,
        true,
        "every shipped part must declare that its tiling was stripped"
      );
    }

    const record = diagnosticFor(stripped);
    assert.equal(
      record.payloadShaping,
      SyncPayloadShaping.TilingStripped,
      "a degraded payload must never be reported with a complete-payload shaping"
    );
    assert.notEqual(
      record.payloadShaping,
      SyncPayloadShaping.Whole,
      "`whole` is the exact lie this ticket removes"
    );
    assert.equal(record.tilingStrippedSessionCount, 1);
  });

  test("a complete payload keeps reporting itself complete", () => {
    // The same session under a cap its tiling fits: nothing is stripped, so the
    // flag, the shaping value and the count must all stay off. Without this the
    // suite would pass on an implementation that flagged every payload.
    const complete = shippedSessions(
      prepareWithoutActivityChunking(
        buildSession({ activitySegmentRows: buildOversizedTiling() }),
        Number.MAX_SAFE_INTEGER
      )
    );
    assert.equal(complete.length, 1);
    assert.ok(
      (complete[0]?.activitySegmentRows?.length ?? 0) > 0,
      "precondition: the tiling rode the base whole"
    );
    assert.equal(complete[0]?.activitySegmentRowsStripped, undefined);

    const record = diagnosticFor(complete);
    assert.equal(record.payloadShaping, SyncPayloadShaping.Whole);
    assert.equal(
      "tilingStrippedSessionCount" in record,
      false,
      "the count increments only on the branch where a strip actually happened"
    );
  });

  test("the count is absent for a session that simply has no tiling", () => {
    // The ambiguity this ticket names: no tiling and a REMOVED tiling both send
    // an absent `activitySegmentRows`. Only the second may be counted.
    const record = diagnosticFor([buildSession()]);
    assert.equal(record.payloadShaping, SyncPayloadShaping.Whole);
    assert.equal("tilingStrippedSessionCount" in record, false);
  });

  test("a stripped session that also chunks stays flagged on every part", () => {
    // The strip's second branch: the tiling-less session still exceeds the cap
    // and is chunked. The flag must ride each part, or the count under-reports
    // whichever chunk happens to fail.
    const session = buildSession({
      activitySegmentRows: buildOversizedTiling(),
      events: Array.from({ length: 400 }, (_, index) => ({
        externalEventId: `event-${index}`,
        eventType: "ToolUse",
        toolName: "Read",
        createdAt: "2026-06-10T10:00:00.000Z",
      })),
    });
    const prepared = prepareWithoutActivityChunking(
      session,
      capThatRejectsTheTiling()
    );
    assert.equal(prepared.kind, "chunked");
    const parts = shippedSessions(prepared);
    assert.ok(parts.length > 1, "precondition: the fallback chunked the rest");
    assert.equal(tilingStrippedSessionIds(parts).length, parts.length);
  });

  test("the strip's count is a permitted transport-health telemetry key", () => {
    // What no other test drives: a strip reaching `emitTelemetry`. Every
    // `leakedSyncTelemetryKeys` site in agent-session-sync-service.test.ts runs
    // sessions with no tiling, so none of them emits this key and none of them
    // would notice the allowlist rejecting it. The no-CONTENT-leak half of this
    // contract is not re-asserted here — sync-failure-diagnostic.test.ts owns
    // it, with a compile-time `Record<keyof SyncFailureDiagnostic, true>` guard
    // over the field set plus a runtime walk of every string value.
    const stripped = shippedSessions(
      prepareWithoutActivityChunking(
        buildSession({ activitySegmentRows: buildOversizedTiling() }),
        capThatRejectsTheTiling()
      )
    );
    const emitted: DesktopSyncBatchEventInput[] = [];
    reportSyncAttemptFailure(
      {
        emitTelemetry: (event) => emitted.push(event),
        writeDurableRecord: () => undefined,
      },
      {
        batchId: BATCH_ID,
        lane: SyncLane.SessionMetadata,
        outcome: DesktopSyncBatchOutcome.Failure as SyncFailureOutcome,
        reason: SyncReason.IngestionFailed,
        payloadBytes: 1234,
        sessionIds: stripped.map((session) => session.externalSessionId),
        payloadShaping: SyncPayloadShaping.TilingStripped,
        tilingStrippedSessionCount: tilingStrippedSessionIds(stripped).length,
      }
    );

    assert.equal(emitted.length, 1);
    assert.equal(
      emitted[0]?.tilingStrippedSessionCount,
      1,
      "precondition: the strip actually reached the telemetry seam"
    );
    assert.deepEqual(
      leakedSyncTelemetryKeys(emitted),
      [],
      "the strip count is a count, so the leak guard must permit it"
    );
  });

  test("the count keys on the stripped flag, never the truncated one", () => {
    // `activitySegmentRowsTruncated` (a partial prefix IS present) and
    // `activitySegmentRowsStripped` (the tiling is absent) are one word apart
    // and mean opposite things. A session carrying only the truncated flag has
    // lost nothing this ticket counts, so reading the wrong field here would
    // report a strip that never happened on every truncated tiling in the fleet.
    const truncated = buildSession({
      activitySegmentRows: buildOversizedTiling().slice(0, 2),
      activitySegmentRowsTruncated: true,
    });
    assert.equal(tilingStrippedSessionIds([truncated]).length, 0);

    const record = diagnosticFor([truncated]);
    assert.equal(record.payloadShaping, SyncPayloadShaping.Whole);
    assert.equal("tilingStrippedSessionCount" in record, false);
  });
});

describe("ISS-7265: payload shaping reports the strip", () => {
  test("a strip outranks a chunk position but not an abandoned sequence", () => {
    assert.equal(
      resolveSyncPayloadShaping({
        drainingPendingChunkTail: false,
        hasPinnedChunkTail: true,
        chunkTailDiscarded: false,
        activityTilingStripped: true,
      }),
      SyncPayloadShaping.TilingStripped,
      "`chunked_head` would answer a question nobody asks about a degraded payload"
    );
    assert.equal(
      resolveSyncPayloadShaping({
        drainingPendingChunkTail: true,
        hasPinnedChunkTail: true,
        chunkTailDiscarded: true,
        activityTilingStripped: true,
      }),
      SyncPayloadShaping.ChunkTailDiscarded,
      "an abandoned in-flight sequence stays the value it was"
    );
  });

  test("the chunk position a strip outranks survives on the record", () => {
    // The strip-and-chunk case is the common one — the ISS-4578 fallback
    // re-chunks the tiling-less session — so if outranking simply erased the
    // position, every attempt for exactly the sessions worth diagnosing would
    // report the strip and never where in the sequence it sat.
    const chunkInputs = {
      drainingPendingChunkTail: false,
      hasPinnedChunkTail: true,
      chunkTailDiscarded: false,
    };
    const record = buildSyncFailureDiagnostic({
      batchId: "d4b6b0a2-6a3e-4f9c-8b1d-2c3e4f5a6b7c",
      lane: SyncLane.SessionMetadata,
      outcome: DesktopSyncBatchOutcome.Failure as SyncFailureOutcome,
      reason: SyncReason.IngestionFailed,
      payloadBytes: 1234,
      sessionIds: ["sess-strip"],
      payloadShaping: resolveSyncPayloadShaping({
        ...chunkInputs,
        activityTilingStripped: true,
      }),
      chunkPosition: resolveChunkPayloadShaping(chunkInputs),
      tilingStrippedSessionCount: 1,
    });

    assert.equal(record.payloadShaping, SyncPayloadShaping.TilingStripped);
    assert.equal(
      record.chunkPosition,
      SyncPayloadShaping.ChunkedHead,
      "the masked position must be recoverable, or outranking is data loss"
    );
  });

  test("the record does not restate a position the shaping already carries", () => {
    // When nothing masked the position, repeating it would make `chunkPosition`
    // unreadable as the exception signal it is.
    const chunkInputs = {
      drainingPendingChunkTail: false,
      hasPinnedChunkTail: true,
      chunkTailDiscarded: false,
    };
    const record = buildSyncFailureDiagnostic({
      batchId: "d4b6b0a2-6a3e-4f9c-8b1d-2c3e4f5a6b7c",
      lane: SyncLane.SessionMetadata,
      outcome: DesktopSyncBatchOutcome.Failure as SyncFailureOutcome,
      reason: SyncReason.IngestionFailed,
      payloadBytes: 1234,
      sessionIds: ["sess-plain"],
      payloadShaping: resolveSyncPayloadShaping({
        ...chunkInputs,
        activityTilingStripped: false,
      }),
      chunkPosition: resolveChunkPayloadShaping(chunkInputs),
    });

    assert.equal(record.payloadShaping, SyncPayloadShaping.ChunkedHead);
    assert.equal("chunkPosition" in record, false);
  });
});
