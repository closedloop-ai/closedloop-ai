/**
 * @file agent-session-sync-activity-segment-chunking.test.ts
 * @description ISS-4541 — an oversized session's activity-segment tiling is
 * CHUNKED across multiple sync parts (each part a disjoint slice) so the FULL
 * tiling reaches the cloud, instead of being TRUNCATED to a single payload (the
 * silent, unrecoverable data loss this ticket fixes). These tests pin:
 *   - full fidelity: every segment ships across the parts, none dropped, when
 *     the server advertised multi-part support (`activityChunkingSupported`);
 *   - splitting on segment BOUNDARIES (each part is a valid non-overlapping
 *     sub-tiling — the receiver keys idempotency on `startMs`);
 *   - the base payload is stripped of the tiling once paginated (no whole-tiling
 *     replication into every chunk);
 *   - version skew: when multi-part is NOT supported the tiling rides the base
 *     whole (old behavior) — which either fits or DEAD-LETTERS the whole session
 *     for a larger-payload retry, never a silent partial;
 *   - mutation guard: reverting to truncate-and-drop (shipping only a prefix)
 *     fails the full-fidelity assertion.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  MAX_SYNCED_ACTIVITY_SEGMENTS,
  type SyncedActivitySegmentRow,
} from "@repo/api/src/types/agent-session";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import {
  chunkOversizedSession,
  estimateSessionPayloadBytes,
  type PreparedAgentSessionPayload,
  prepareAgentSessionPayload,
} from "../src/main/agent-sync/agent-session-sync-payload.js";

function buildSession(
  overrides: Partial<SyncedAgentSession> = {}
): SyncedAgentSession {
  return {
    externalSessionId: "sess-tiling",
    name: "Tiling session",
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

/**
 * A valid tiling: contiguous, non-overlapping [startMs, endMs) spans with
 * distinct integer startMs (so each row is a natural split boundary, matching
 * the receiver's `(agentSessionId, startMs)` idempotency key). `pad` inflates
 * each row's serialized bytes so a modest row count forces multiple chunks.
 */
function buildSegments(count: number, pad = 0): SyncedActivitySegmentRow[] {
  const padValue = pad > 0 ? "x".repeat(pad) : undefined;
  return Array.from({ length: count }, (_, i) => ({
    phase: "coding",
    startMs: i * 1000,
    endMs: i * 1000 + 999,
    confidence: 0.9,
    evidenceLayers: ["structural"],
    version: 7,
    ...(padValue ? { workItemRef: padValue } : {}),
  }));
}

function collectSegments(
  chunks: SyncedAgentSession[]
): SyncedActivitySegmentRow[] {
  return chunks.flatMap((chunk) => chunk.activitySegmentRows ?? []);
}

const SUPPORTED = true;

describe("ISS-4541: activity-segment tiling is chunked, never truncated", () => {
  test("paginates an oversized tiling across parts with NO row dropped (full fidelity)", () => {
    const segments = buildSegments(40, 400);
    const session = buildSession({ activitySegmentRows: segments });
    // A cap that fits the base but not the whole tiling, forcing pagination.
    const maxBytes =
      estimateSessionPayloadBytes(buildSession({ activitySegmentRows: [] })) +
      2000;

    const chunks = chunkOversizedSession(
      session,
      maxBytes,
      undefined,
      undefined,
      SUPPORTED
    );

    assert.ok(chunks.length > 1, "expected the tiling to span multiple chunks");
    for (const chunk of chunks) {
      assert.ok(
        estimateSessionPayloadBytes(chunk) <= maxBytes,
        "every chunk stays within the byte cap"
      );
    }
    // Full fidelity: every startMs is delivered exactly once, in order.
    const deliveredStarts = collectSegments(chunks).map((row) => row.startMs);
    assert.deepEqual(
      deliveredStarts,
      segments.map((row) => row.startMs),
      "every segment reaches the wire exactly once, in start order"
    );
  });

  test("splits ONLY on segment boundaries — each part is a valid disjoint sub-tiling", () => {
    const segments = buildSegments(40, 400);
    const session = buildSession({ activitySegmentRows: segments });
    const maxBytes =
      estimateSessionPayloadBytes(buildSession({ activitySegmentRows: [] })) +
      2000;

    const chunks = chunkOversizedSession(
      session,
      maxBytes,
      undefined,
      undefined,
      SUPPORTED
    );

    // No startMs appears in two parts (disjoint), and within each part the
    // slice is a contiguous, non-overlapping tiling (sorted, no overlap).
    const seenStarts = new Set<number>();
    for (const chunk of chunks) {
      const slice = chunk.activitySegmentRows ?? [];
      let prevEnd = Number.NEGATIVE_INFINITY;
      for (const row of slice) {
        assert.ok(
          !seenStarts.has(row.startMs),
          `startMs ${row.startMs} must not appear in two parts`
        );
        seenStarts.add(row.startMs);
        assert.ok(
          row.startMs >= prevEnd,
          "each part's rows stay non-overlapping"
        );
        prevEnd = row.endMs;
      }
    }
  });

  test("strips the tiling from the base — no whole-tiling replicated into every chunk", () => {
    const segments = buildSegments(40, 400);
    const session = buildSession({ activitySegmentRows: segments });
    const maxBytes =
      estimateSessionPayloadBytes(buildSession({ activitySegmentRows: [] })) +
      2000;

    const chunks = chunkOversizedSession(
      session,
      maxBytes,
      undefined,
      undefined,
      SUPPORTED
    );

    // A chunk carrying events/tokenEvents (or the opening chunk) must NOT also
    // carry the full tiling — each chunk holds at most its own slice, so the
    // total delivered equals the input, never a multiple of it.
    const totalDelivered = collectSegments(chunks).length;
    assert.equal(
      totalDelivered,
      segments.length,
      "the tiling is delivered once (paginated), not replicated per chunk"
    );
  });

  test("mutation guard: shipping only a prefix (truncate-and-drop) fails full fidelity", () => {
    const segments = buildSegments(40, 400);
    const session = buildSession({ activitySegmentRows: segments });
    const maxBytes =
      estimateSessionPayloadBytes(buildSession({ activitySegmentRows: [] })) +
      2000;

    const chunks = chunkOversizedSession(
      session,
      maxBytes,
      undefined,
      undefined,
      SUPPORTED
    );
    const delivered = collectSegments(chunks);

    // A truncate-and-drop regression would deliver only the rows that fit one
    // payload — strictly fewer than the input. Assert we delivered them ALL.
    assert.equal(
      delivered.length,
      segments.length,
      "a truncate-to-one-payload regression would drop the tail; it must not"
    );
  });

  test("version skew: without multi-part support the tiling rides the base whole (not paginated)", () => {
    // A small tiling that fits the base whole. Not paginated ⇒ every emitted
    // chunk that carries the tiling carries the WHOLE tiling (old behavior).
    const segments = buildSegments(3);
    const session = buildSession({
      activitySegmentRows: segments,
      events: buildEventSlice(30),
    });
    const maxBytes =
      estimateSessionPayloadBytes(
        buildSession({ activitySegmentRows: segments })
      ) + 300;

    const chunks = chunkOversizedSession(
      session,
      maxBytes,
      undefined,
      undefined,
      /* activityChunkingSupported */ false
    );

    assert.ok(chunks.length >= 1);
    // Every chunk replicates the full tiling in the base (old contract) — the
    // receiver REPLACE-ALLs it per chunk, which stays correct.
    for (const chunk of chunks) {
      assert.deepEqual(
        (chunk.activitySegmentRows ?? []).map((row) => row.startMs),
        segments.map((row) => row.startMs),
        "old-cloud path keeps the full tiling in every chunk's base"
      );
    }
  });

  test("P1 #1: old-server bounded fallback — an oversized tiling degrades to a tiling-stripped session, NOT a whole-session dead-letter", () => {
    // A session whose events fit but whose LARGE tiling (riding the base whole,
    // because the server can't chunk it) pushes the base over the cap. Pre-fix
    // this dead-lettered the WHOLE session (losing events/agents/metadata). The
    // bounded fallback must instead ship the session with the tiling OMITTED so
    // the rest syncs now; the tiling defers (omission is a cloud no-op, never a
    // silent clear).
    const segments = buildSegments(200, 800);
    const session = buildSession({
      activitySegmentRows: segments,
      events: buildEventSlice(5),
    });
    const maxBytes =
      estimateSessionPayloadBytes(buildSession({ activitySegmentRows: [] })) +
      2000;

    const prepared = prepareAgentSessionPayload(
      session,
      maxBytes,
      undefined,
      undefined,
      /* activityChunkingSupported */ false
    );

    assert.notEqual(
      prepared.kind,
      "dead-letter",
      "the session must NOT dead-letter — the rest of it syncs, tiling deferred"
    );
    // Collect the sessions actually shipped and prove the tiling is absent (not
    // truncated, not `[]`) while the events survived.
    const shipped = shippedSessions(prepared);
    assert.ok(shipped.length > 0, "the session must ship");
    for (const part of shipped) {
      assert.equal(
        part.activitySegmentRows,
        undefined,
        "the oversized tiling is OMITTED (absent key), a cloud no-op — never a partial"
      );
    }
    const shippedEvents = shipped.reduce(
      (sum, part) => sum + part.events.length,
      0
    );
    assert.equal(
      shippedEvents,
      5,
      "the rest of the session (events) reaches the wire despite the deferred tiling"
    );
  });

  test("version skew: the low-level chunker refuses to truncate an oversized UNSUPPORTED tiling (returns [])", () => {
    // A tiling too large to fit the base under the cap, with pagination OFF:
    // chunkOversizedSession must return [] — it never ships a truncated partial
    // tiling. (prepareAgentSessionPayload then applies the P1 #1 bounded
    // fallback; see the next test.)
    const segments = buildSegments(200, 800);
    const session = buildSession({ activitySegmentRows: segments });
    const maxBytes =
      estimateSessionPayloadBytes(buildSession({ activitySegmentRows: [] })) +
      2000;

    const chunks = chunkOversizedSession(
      session,
      maxBytes,
      undefined,
      undefined,
      /* activityChunkingSupported */ false
    );
    assert.deepEqual(
      chunks,
      [],
      "an oversized tiling with no multi-part support is never truncated by the chunker"
    );
  });

  test("P1 #2: no activity chunk exceeds MAX_SYNCED_ACTIVITY_SEGMENTS rows even when the byte cap would fit more", () => {
    // Tiny (unpadded) segments so the BYTE cap alone would pack far more than
    // MAX_SYNCED_ACTIVITY_SEGMENTS rows into one chunk; the ROW cap must bind.
    const rowCount = MAX_SYNCED_ACTIVITY_SEGMENTS + 250;
    const segments = buildSegments(rowCount);
    const session = buildSession({ activitySegmentRows: segments });
    // A byte cap that is huge (fits every row in one payload). Without the row
    // cap the chunker would emit ONE chunk of `rowCount` rows, which the wire
    // schema (`.max(MAX_SYNCED_ACTIVITY_SEGMENTS)`) rejects → re-prepared
    // forever. With the fix each chunk carries at most the row cap.
    const maxBytes =
      estimateSessionPayloadBytes(buildSession({ activitySegmentRows: [] })) +
      50_000_000;

    const chunks = chunkOversizedSession(
      session,
      maxBytes,
      undefined,
      undefined,
      SUPPORTED
    );

    assert.ok(
      chunks.length >= 2,
      "the row cap must force the oversized tiling across >1 chunk"
    );
    for (const chunk of chunks) {
      assert.ok(
        (chunk.activitySegmentRows ?? []).length <=
          MAX_SYNCED_ACTIVITY_SEGMENTS,
        "no chunk may exceed the receiver's per-payload row cap"
      );
    }
    // Full fidelity is preserved — the row cap paginates, never drops.
    assert.equal(
      collectSegments(chunks).length,
      rowCount,
      "every segment still reaches the wire exactly once"
    );
  });

  test("P1 #3: token events do NOT starve the required tiling of chunk budget", () => {
    // A tiling that needs several chunks, plus a large token-event stream. The
    // tiling is REQUIRED (dead-letter if it can't all ship); tokenEvents are
    // best-effort. Reserving the tiling budget FIRST means the full tiling ships
    // even when the token stream is large. Mutation guard: paginating tokens
    // first (the pre-fix order) would let a big token stream consume the shared
    // MAX_SESSION_SYNC_CHUNKS budget and dead-letter the whole session.
    const segments = buildSegments(40, 400);
    const tokenEvents: SyncedAgentSession["tokenEvents"] = Array.from(
      { length: 60 },
      (_, i) => ({
        externalEventId: `tok-${i}`,
        model: "claude-opus-4",
        inputTokens: i,
        outputTokens: i,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCostUsd: 0.01,
        createdAt: "2026-06-10T10:30:00.000Z",
      })
    );
    const session = buildSession({
      activitySegmentRows: segments,
      tokenEvents,
    });
    const maxBytes =
      estimateSessionPayloadBytes(
        buildSession({ activitySegmentRows: [], tokenEvents: [] })
      ) + 2000;

    const chunks = chunkOversizedSession(
      session,
      maxBytes,
      undefined,
      undefined,
      SUPPORTED
    );

    assert.ok(chunks.length > 0, "the session must not dead-letter");
    // The FULL required tiling ships — never starved by the token stream.
    assert.equal(
      collectSegments(chunks).length,
      segments.length,
      "the required tiling reaches the wire in full despite a large token stream"
    );
  });

  test("stamps every activity-segment chunk with a contiguous {index,total} marker", () => {
    const segments = buildSegments(40, 400);
    const session = buildSession({ activitySegmentRows: segments });
    const maxBytes =
      estimateSessionPayloadBytes(buildSession({ activitySegmentRows: [] })) +
      2000;

    const chunks = chunkOversizedSession(
      session,
      maxBytes,
      undefined,
      undefined,
      SUPPORTED
    );

    const total = chunks.length;
    chunks.forEach((chunk, index) => {
      assert.equal(chunk.chunk?.index, index, "0-based contiguous index");
      assert.equal(chunk.chunk?.total, total, "each chunk carries the total");
    });
  });
});

/** The session(s) a prepared payload actually ships (empty for a dead-letter). */
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

function buildEventSlice(count: number): SyncedAgentSession["events"] {
  return Array.from({ length: count }, (_, i) => ({
    externalEventId: `evt-${i}`,
    eventType: "ToolUse",
    toolName: "Read",
    createdAt: "2026-06-10T10:30:00.000Z",
  }));
}
