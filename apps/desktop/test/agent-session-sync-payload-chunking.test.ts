import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
  SyncedAgentSession,
  SyncedAgentSessionTokenEvent,
} from "../src/main/agent-session-sync-contract.js";
import {
  chunkOversizedSession,
  estimateSessionPayloadBytes,
  prepareAgentSessionPayload,
} from "../src/main/agent-session-sync-payload.js";

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
    const base = estimateSessionPayloadBytes({
      ...buildSession(),
      events: [],
      tokenEvents: [],
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
