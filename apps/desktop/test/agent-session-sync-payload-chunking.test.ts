import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SESSION_PAYLOAD_BYTE_CAP } from "../src/main/agent-sync/agent-session-sync-backoff-policy.js";
import type {
  SyncedAgentSession,
  SyncedAgentSessionTokenEvent,
} from "../src/main/agent-sync/agent-session-sync-contract.js";
import {
  chunkOversizedSession,
  estimateSessionPayloadBytes,
  maxSessionPayloadBytesForBatch,
  prepareAgentSessionPayload,
  sanitizeSessionForSync,
} from "../src/main/agent-sync/agent-session-sync-payload.js";

function buildSession(
  overrides: Partial<SyncedAgentSession> = {}
): SyncedAgentSession {
  return {
    externalSessionId: "sess-chunk",
    name: "Chunk session",
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

function buildEvents(count: number): SyncedAgentSession["events"] {
  return Array.from({ length: count }, (_, i) => ({
    externalEventId: `evt-${i}`,
    eventType: "ToolUse",
    toolName: "Read",
    createdAt: "2026-06-10T10:30:00.000Z",
  }));
}

function buildTokenEvents(count: number): SyncedAgentSessionTokenEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    externalEventId: `tok-${i}`,
    model: "claude-opus-4",
    inputTokens: 100 + i,
    outputTokens: 200 + i,
    cacheReadTokens: 300 + i,
    cacheWriteTokens: 400 + i,
    estimatedCostUsd: 0.01 * i,
    createdAt: "2026-06-10T10:31:00.000Z",
  }));
}

describe("chunkOversizedSession (FEA-2730)", () => {
  test("event-only sessions keep the pre-FEA-2730 shape (no tokenEvents key)", () => {
    const session = buildSession({ events: buildEvents(30) });
    const maxBytes = estimateSessionPayloadBytes(buildSession()) + 400;

    const chunks = chunkOversizedSession(session, maxBytes);

    assert.ok(chunks.length > 1, "expected multiple chunks");
    for (const chunk of chunks) {
      assert.ok(estimateSessionPayloadBytes(chunk) <= maxBytes);
      // No tokenEvents on the session ⇒ chunks must not introduce the key.
      assert.equal(chunk.tokenEvents, undefined);
    }
    const seen = chunks.flatMap((chunk) =>
      chunk.events.map((event) => event.externalEventId)
    );
    assert.deepEqual(
      seen,
      buildEvents(30).map((event) => event.externalEventId)
    );
  });

  test("co-paginates events and tokenEvents into disjoint chunks", () => {
    const session = buildSession({
      events: buildEvents(24),
      tokenEvents: buildTokenEvents(24),
    });
    const maxBytes = estimateSessionPayloadBytes(buildSession()) + 500;

    const chunks = chunkOversizedSession(session, maxBytes);

    assert.ok(chunks.length > 1, "expected multiple chunks");
    for (const chunk of chunks) {
      assert.ok(
        estimateSessionPayloadBytes(chunk) <= maxBytes,
        "each chunk stays within the cap"
      );
      // Each chunk carries a slice of exactly one paginated stream.
      const hasEvents = chunk.events.length > 0;
      const hasTokenEvents = (chunk.tokenEvents?.length ?? 0) > 0;
      assert.ok(
        !(hasEvents && hasTokenEvents),
        "a chunk carries events XOR tokenEvents, never both"
      );
    }

    const eventIds = chunks.flatMap((chunk) =>
      chunk.events.map((event) => event.externalEventId)
    );
    const tokenEventIds = chunks.flatMap((chunk) =>
      (chunk.tokenEvents ?? []).map((event) => event.externalEventId)
    );
    // Every row appears exactly once across all chunks (no loss, no duplication).
    assert.deepEqual(
      eventIds,
      buildEvents(24).map((e) => e.externalEventId)
    );
    assert.deepEqual(
      tokenEventIds,
      buildTokenEvents(24).map((e) => e.externalEventId)
    );
  });

  test("degrades to a metadata chunk instead of dead-lettering when token events can't be paginated", () => {
    // A token event that alone can't fit the byte cap must NOT sink the whole
    // session to [] (which prepareAgentSessionPayload turns into a dead-letter,
    // dropping the session's events/agents/metadata that synced fine before
    // FEA-2730). Token events are keep-all/idempotent cloud-side, so the
    // producer degrades: sync the session core and drop the unpaginatable token
    // events, which resync on a later pass.
    // The degraded metadata chunk carries a real `chunk: { index, total }`
    // marker (FEA-3788), so its base size includes those bytes. Measure the base
    // from a marker-bearing empty chunk — a cap sized off the marker-less base
    // would (correctly) dead-letter because the emitted chunk no longer fits.
    const base = estimateSessionPayloadBytes({
      ...buildSession(),
      events: [],
      tokenEvents: [],
      chunk: { index: 0, total: 1 },
    });
    // Cap admits the base session but not base + a single token event.
    const maxBytes = base + 10;
    const session = buildSession({ tokenEvents: buildTokenEvents(1) });

    const chunks = chunkOversizedSession(session, maxBytes);

    assert.equal(
      chunks.length,
      1,
      "session core still syncs rather than dead-lettering"
    );
    assert.equal(chunks[0]?.events.length, 0);
    assert.deepEqual(chunks[0]?.tokenEvents, []);
  });

  test("paginates a tokenEvent-only session", () => {
    const session = buildSession({ tokenEvents: buildTokenEvents(30) });
    const maxBytes = estimateSessionPayloadBytes(buildSession()) + 500;

    const chunks = chunkOversizedSession(session, maxBytes);

    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      assert.ok(estimateSessionPayloadBytes(chunk) <= maxBytes);
      assert.equal(chunk.events.length, 0);
    }
    const tokenEventIds = chunks.flatMap((chunk) =>
      (chunk.tokenEvents ?? []).map((event) => event.externalEventId)
    );
    assert.deepEqual(
      tokenEventIds,
      buildTokenEvents(30).map((e) => e.externalEventId)
    );
  });
});

describe("FEA-3788: chunk metadata makes a partial apply repairable", () => {
  test("stamps every chunk with a 0-based index and the total count", () => {
    const session = buildSession({ events: buildEvents(30) });
    const maxBytes = estimateSessionPayloadBytes(buildSession()) + 400;

    const chunks = chunkOversizedSession(session, maxBytes);

    assert.ok(chunks.length > 1, "expected multiple chunks");
    const total = chunks.length;
    chunks.forEach((chunk, index) => {
      assert.deepEqual(
        chunk.chunk,
        { index, total },
        `chunk ${index} must carry {index, total}`
      );
    });
    // The last chunk is the only one the cloud commits the revision on; assert it
    // is unambiguously identifiable as index === total - 1.
    const last = chunks.at(-1);
    assert.equal(last?.chunk?.index, total - 1);
  });

  test("co-paginated event+tokenEvent chunks share one contiguous index sequence", () => {
    const session = buildSession({
      events: buildEvents(24),
      tokenEvents: buildTokenEvents(24),
    });
    const maxBytes = estimateSessionPayloadBytes(buildSession()) + 500;

    const chunks = chunkOversizedSession(session, maxBytes);

    assert.ok(chunks.length > 1, "expected multiple chunks");
    const total = chunks.length;
    // Indices must be a dense 0..total-1 run (no gaps between the event-chunk run
    // and the tokenEvent-chunk run) so the cloud's first/last-chunk gates hold.
    assert.deepEqual(
      chunks.map((chunk) => chunk.chunk?.index),
      Array.from({ length: total }, (_, i) => i)
    );
    for (const chunk of chunks) {
      assert.equal(chunk.chunk?.total, total);
    }
  });

  test("prepareAgentSessionPayload preserves the chunk markers on first + remaining chunks", () => {
    const session = buildSession({ events: buildEvents(30) });
    const maxBytes = estimateSessionPayloadBytes(buildSession()) + 400;

    const prepared = prepareAgentSessionPayload(session, maxBytes);

    assert.equal(prepared.kind, "chunked");
    if (prepared.kind !== "chunked") {
      return;
    }
    const chunks = [prepared.firstChunk, ...prepared.remainingChunks];
    assert.equal(prepared.firstChunk.chunk?.index, 0);
    assert.equal(prepared.firstChunk.chunk?.total, prepared.chunkCount);
    chunks.forEach((chunk, index) => {
      assert.equal(chunk.chunk?.index, index);
      assert.equal(chunk.chunk?.total, prepared.chunkCount);
    });
  });

  test("every stamped chunk stays within the byte cap after the marker is written", () => {
    // Regression (codex P2): the `chunk: { index, total }` marker is reserved
    // during sizing, so stamping it must never push a chunk that was packed right
    // up to `maxBytes` past the cap — which would let
    // agent-session-sync-service dead-letter an otherwise-syncable session.
    const session = buildSession({ events: buildEvents(60) });
    // A tight cap forces many chunks packed close to the limit. The base must
    // include the worst-case marker reserve the packer accounts for, plus a small
    // per-chunk event budget, so multiple chunks are produced without dead-lettering.
    const maxBytes =
      estimateSessionPayloadBytes({
        ...buildSession(),
        chunk: { index: 99, total: 100 },
      }) + 120;

    const chunks = chunkOversizedSession(session, maxBytes);

    assert.ok(chunks.length > 1, "expected multiple chunks");
    for (const chunk of chunks) {
      // Measure the FULLY STAMPED chunk (chunkOversizedSession returns stamped
      // chunks), including its real `chunk` marker bytes.
      assert.ok(
        chunk.chunk != null,
        "every chunk is stamped with a real marker"
      );
      assert.ok(
        estimateSessionPayloadBytes(chunk) <= maxBytes,
        `stamped chunk ${chunk.chunk?.index} must stay within the cap`
      );
    }
    // No event is lost across the stamped chunks.
    const seen = chunks.flatMap((chunk) =>
      chunk.events.map((event) => event.externalEventId)
    );
    assert.deepEqual(
      seen,
      buildEvents(60).map((event) => event.externalEventId)
    );
  });

  test("an unchunked (whole-session) payload carries no chunk marker", () => {
    // A session that fits under the cap is implicitly chunk 0 of 1; the cloud
    // treats an absent marker as first AND last chunk. Assert we do not stamp it.
    const session = buildSession({ events: buildEvents(2) });
    const prepared = prepareAgentSessionPayload(
      session,
      SESSION_PAYLOAD_BYTE_CAP
    );

    assert.equal(prepared.kind, "session");
    if (prepared.kind !== "session") {
      return;
    }
    assert.equal(prepared.session.chunk, undefined);
  });
});

describe("prepareAgentSessionPayload token-event routing (FEA-2730)", () => {
  test("routes an oversized session carrying tokenEvents through chunking", () => {
    // An oversized session paginates BOTH the events and tokenEvents streams
    // across whole-session chunks so per-event token analytics survive
    // cloud-side. (FEA-2718 retired the fragment transport; chunking is the only
    // oversized path.)
    const session = buildSession({
      events: buildEvents(6),
      tokenEvents: buildTokenEvents(6),
    });
    const maxBytes = estimateSessionPayloadBytes(buildSession()) + 500;

    const prepared = prepareAgentSessionPayload(session, maxBytes);

    assert.equal(prepared.kind, "chunked");
    if (prepared.kind !== "chunked") {
      return;
    }
    const chunks = [prepared.firstChunk, ...prepared.remainingChunks];
    const tokenEventIds = chunks
      .flatMap((chunk) =>
        (chunk.tokenEvents ?? []).map((event) => event.externalEventId)
      )
      .sort();
    assert.deepEqual(
      tokenEventIds,
      buildTokenEvents(6)
        .map((event) => event.externalEventId)
        .sort()
    );
  });
});

// ---------------------------------------------------------------------------
// T-10.9: components[] emitted on session payloads and rides the base chunk
// ---------------------------------------------------------------------------

function buildComponentUsageItems(
  count: number
): NonNullable<SyncedAgentSession["components"]> {
  return Array.from({ length: count }, (_, i) => ({
    componentKind: "tool",
    componentKey: `tool-${i}`,
    invocations: i + 1,
    errorCount: 0,
  }));
}

describe("components[] in session payloads (T-10.9 / FEA-2923)", () => {
  test("components[] is included verbatim in a normal (non-oversized) session payload", () => {
    const components = buildComponentUsageItems(3);
    const session = buildSession({ components });

    const prepared = prepareAgentSessionPayload(
      session,
      estimateSessionPayloadBytes(buildSession()) + 10_000
    );

    assert.equal(prepared.kind, "session", "fits under the cap");
    if (prepared.kind !== "session") {
      return;
    }
    assert.deepEqual(prepared.session.components, components);
  });

  test("components[] ride every chunk of an oversized session (spread with session metadata)", () => {
    // chunkOversizedSession uses { ...session, events: slice }, so all non-event
    // fields — including components[] — are replicated into every chunk.
    const components = buildComponentUsageItems(5);
    const session = buildSession({
      events: buildEvents(30),
      components,
    });
    // Budget from the per-chunk fixed cost, which now includes components[]
    // (they ride every chunk via `{ ...session, events: slice }`), plus headroom
    // for a few events per chunk. Basing it on the component-less base would be
    // smaller than a single component-bearing chunk, so chunkOversizedSession
    // would dead-letter (return []) instead of paginating.
    const maxBytes =
      estimateSessionPayloadBytes(buildSession({ components })) + 400;

    const chunks = chunkOversizedSession(session, maxBytes);

    assert.ok(
      chunks.length > 1,
      "session is oversized — multiple chunks expected"
    );
    for (const chunk of chunks) {
      assert.deepEqual(
        chunk.components,
        components,
        "every chunk carries the full components[] array"
      );
    }
  });

  test("session without components[] produces no components key on the payload", () => {
    const session = buildSession({ events: buildEvents(2) });
    // Ensure components is not set on the session object.
    assert.equal("components" in session, false);

    const prepared = prepareAgentSessionPayload(
      session,
      estimateSessionPayloadBytes(buildSession()) + 10_000
    );

    assert.equal(prepared.kind, "session");
    if (prepared.kind !== "session") {
      return;
    }
    assert.equal(
      prepared.session.components,
      undefined,
      "components key absent when not provided"
    );
  });
});

// ---------------------------------------------------------------------------
// FEA-3672: raising the per-message metadata text cap (160 → 2500) must not let
// a long conversation bloat metadata past the payload byte cap and dead-letter
// the session.
// ---------------------------------------------------------------------------

describe("FEA-3672: long-conversation metadata stays under the payload cap", () => {
  test("100 near-cap human turns do not dead-letter the session", () => {
    const messages = Array.from({ length: 100 }, () => ({
      role: "user",
      timestamp: "2026-06-10T10:00:00.000Z",
      text: "w".repeat(2500),
    }));
    const session = buildSession({
      metadata: { messages } as SyncedAgentSession["metadata"],
    });
    const maxBytes = maxSessionPayloadBytesForBatch(SESSION_PAYLOAD_BYTE_CAP);

    const prepared = prepareAgentSessionPayload(session, maxBytes);
    assert.notEqual(
      prepared.kind,
      "dead-letter",
      "aggregate text budget keeps metadata under the payload cap"
    );

    // The sanitized metadata's summed preview text is bounded well under the cap:
    // the 60k aggregate budget plus the per-message 160-char floor for turns past
    // the budget (worst case ~76k, far below the payload cap).
    const sanitized = sanitizeSessionForSync(session);
    const meta = sanitized.metadata as { messages: { text?: string }[] };
    const totalTextChars = meta.messages.reduce(
      (sum, m) => sum + (typeof m.text === "string" ? m.text.length : 0),
      0
    );
    assert.ok(
      totalTextChars <= 60_000 + 100 * 160,
      `summed preview text ${totalTextChars} must stay within the aggregate budget + floor`
    );
    // Early turns still carry their full 2500-char preview.
    assert.equal(meta.messages[0].text, "w".repeat(2500));
    // Regression guard (codex review): no turn drops its preview entirely once
    // the aggregate budget is spent — every later turn keeps at least the old
    // 160-char preview so timeline detail never renders `undefined`.
    for (const message of meta.messages) {
      assert.ok(
        typeof message.text === "string" && message.text.length >= 160,
        "every turn keeps at least the 160-char preview floor"
      );
    }
  });
});
