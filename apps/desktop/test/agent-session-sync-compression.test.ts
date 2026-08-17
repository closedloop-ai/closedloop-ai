import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { gunzipSync } from "node:zlib";
import { SyncPayloadEncoding } from "@repo/api/src/types/agent-session";
import { SYNC_DECOMPRESSED_BYTE_CEILING } from "@repo/api/src/types/agent-session-sync-limits";
import {
  gzipJson,
  gzippedByteLength,
  gzipSyncPayloadSizer,
  identitySyncPayloadSizer,
  rawJsonByteLength,
  syncPayloadSizerFor,
} from "../src/main/agent-sync/agent-session-sync-compression.js";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import {
  chunkOversizedSession,
  estimateSessionPayloadBytes,
  prepareAgentSessionPayload,
} from "../src/main/agent-sync/agent-session-sync-payload.js";

function buildSession(
  overrides: Partial<SyncedAgentSession> = {}
): SyncedAgentSession {
  return {
    externalSessionId: "sess-compress",
    name: "Compress session",
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

// Highly-repetitive events model a real agent transcript, which gzip crushes.
function buildEvents(count: number): SyncedAgentSession["events"] {
  return Array.from({ length: count }, (_, i) => ({
    externalEventId: `evt-${i}`,
    eventType: "ToolUse",
    toolName: "Read",
    createdAt: "2026-06-10T10:30:00.000Z",
  }));
}

describe("FEA-4138 sync payload compression sizing", () => {
  test("gzip byte length is much smaller than raw JSON for a transcript", () => {
    const session = buildSession({ events: buildEvents(400) });
    const rawBytes = Buffer.byteLength(JSON.stringify(session));
    const gzipBytes = gzippedByteLength(session);
    assert.ok(gzipBytes < rawBytes, "gzip must shrink the payload");
    // Repetitive transcript rows compress well past 2x; assert a conservative
    // structural ratio (not timing) so the rescue/chunk-reduction claim holds.
    assert.ok(
      gzipBytes * 2 < rawBytes,
      `expected >2x compression, got raw=${rawBytes} gzip=${gzipBytes}`
    );
  });

  test("a session that CHUNKS uncompressed ships as ONE session compressed", () => {
    const session = buildSession({ events: buildEvents(400) });
    // Cap between the compressed and raw sizes: raw exceeds it (would chunk),
    // compressed fits under it (single request, no chunking).
    const rawBytes = estimateSessionPayloadBytes(
      session,
      identitySyncPayloadSizer
    );
    const gzipBytes = estimateSessionPayloadBytes(
      session,
      gzipSyncPayloadSizer
    );
    const maxBytes = Math.floor((rawBytes + gzipBytes) / 2);
    assert.ok(gzipBytes <= maxBytes && rawBytes > maxBytes, "cap is between");

    const rawPrepared = prepareAgentSessionPayload(
      session,
      maxBytes,
      identitySyncPayloadSizer
    );
    const gzipPrepared = prepareAgentSessionPayload(
      session,
      maxBytes,
      gzipSyncPayloadSizer
    );
    assert.equal(rawPrepared.kind, "chunked");
    assert.equal(gzipPrepared.kind, "session");
  });

  test("compression reduces the chunk COUNT for a large session", () => {
    const session = buildSession({ events: buildEvents(600) });
    // A cap small enough to force chunking under BOTH sizers, so the comparison
    // is chunk-count vs chunk-count (compressed packs more rows per chunk).
    const maxBytes = gzippedByteLength(buildSession()) + 2000;

    const rawChunks = chunkOversizedSession(
      session,
      maxBytes,
      identitySyncPayloadSizer
    );
    const gzipChunks = chunkOversizedSession(
      session,
      maxBytes,
      gzipSyncPayloadSizer
    );
    assert.ok(rawChunks.length > 0 && gzipChunks.length > 0);
    assert.ok(
      gzipChunks.length < rawChunks.length,
      `expected fewer compressed chunks: raw=${rawChunks.length} gzip=${gzipChunks.length}`
    );
    // Compressed chunks must each fit the cap under compressed sizing.
    for (const chunk of gzipChunks) {
      assert.ok(
        estimateSessionPayloadBytes(chunk, gzipSyncPayloadSizer) <= maxBytes
      );
    }
    // No event row lost or duplicated across the compressed chunks.
    const seen = gzipChunks.flatMap((chunk) =>
      chunk.events.map((event) => event.externalEventId)
    );
    assert.deepEqual(
      seen.sort(),
      buildEvents(600)
        .map((event) => event.externalEventId)
        .sort()
    );
  });

  test("gzipJson round-trips back to the original value", () => {
    const session = buildSession({ events: buildEvents(50) });
    const restored = JSON.parse(gunzipSync(gzipJson(session)).toString("utf8"));
    assert.deepEqual(restored, JSON.parse(JSON.stringify(session)));
  });

  test("syncPayloadSizerFor selects encoding by flag", () => {
    assert.equal(syncPayloadSizerFor(true).encoding, SyncPayloadEncoding.Gzip);
    assert.equal(
      syncPayloadSizerFor(false).encoding,
      SyncPayloadEncoding.Identity
    );
  });
});

describe("FEA-4152 compression-aware chunking vs the decompressed ceiling", () => {
  test("the gzip sizer exposes raw JSON bytes as its decompressed length", () => {
    const session = buildSession({ events: buildEvents(50) });
    // Wire (compressed) bytes are much smaller than what the server decodes.
    assert.ok(
      gzipSyncPayloadSizer.byteLength(session) <
        gzipSyncPayloadSizer.decompressedByteLength(session)
    );
    // Decompressed length is exactly the raw JSON length for BOTH encodings.
    assert.equal(
      gzipSyncPayloadSizer.decompressedByteLength(session),
      rawJsonByteLength(session)
    );
    assert.equal(
      identitySyncPayloadSizer.decompressedByteLength(session),
      identitySyncPayloadSizer.byteLength(session)
    );
  });

  test("a payload that gzips UNDER the wire cap but decompresses OVER the ceiling is chunked, not shipped whole", () => {
    // A highly-repetitive transcript: raw JSON is large, gzip is tiny.
    const session = buildSession({ events: buildEvents(800) });
    const wireBytes = estimateSessionPayloadBytes(
      session,
      gzipSyncPayloadSizer
    );
    const rawBytes = estimateSessionPayloadBytes(
      session,
      identitySyncPayloadSizer
    );
    // Model the real cap/ceiling relationship with small synthetic limits so
    // the test stays fast: the WHOLE payload fits the compressed wire cap, but
    // its decompressed size exceeds the ceiling. Without the second constraint
    // this ships as ONE `session` (→ route 400 `Invalid compressed body` →
    // dead-letter); with it, the packer must split further.
    const maxBytes = wireBytes + 10_000; // whole payload fits the wire cap
    const maxDecompressedBytes = Math.floor(rawBytes / 4); // but NOT the ceiling
    assert.ok(
      wireBytes <= maxBytes && rawBytes > maxDecompressedBytes,
      "fixture must gzip-under-cap but decompress-over-ceiling"
    );

    const prepared = prepareAgentSessionPayload(
      session,
      maxBytes,
      gzipSyncPayloadSizer,
      maxDecompressedBytes
    );
    assert.equal(
      prepared.kind,
      "chunked",
      "must chunk further rather than ship whole and 400"
    );
    if (prepared.kind !== "chunked") {
      return;
    }
    const chunks = [prepared.firstChunk, ...prepared.remainingChunks];
    assert.ok(chunks.length >= 2, "the ceiling forces multiple chunks");
    // Every emitted chunk clears BOTH the compressed wire cap AND the
    // decompressed ceiling, so the route accepts each one.
    for (const chunk of chunks) {
      assert.ok(
        estimateSessionPayloadBytes(chunk, gzipSyncPayloadSizer) <= maxBytes,
        "chunk under the compressed wire cap"
      );
      assert.ok(
        rawJsonByteLength(chunk) <= maxDecompressedBytes,
        "chunk under the decompressed ceiling"
      );
    }
    // No event row lost or duplicated across the ceiling-bounded chunks.
    const seen = chunks
      .flatMap((chunk) => chunk.events.map((event) => event.externalEventId))
      .sort();
    assert.deepEqual(
      seen,
      buildEvents(800)
        .map((event) => event.externalEventId)
        .sort()
    );
  });

  test("chunkOversizedSession bounds every chunk by the decompressed ceiling under gzip", () => {
    const session = buildSession({ events: buildEvents(600) });
    const wireBytes = estimateSessionPayloadBytes(
      session,
      gzipSyncPayloadSizer
    );
    const rawBytes = rawJsonByteLength(session);
    const maxBytes = wireBytes + 10_000;
    const maxDecompressedBytes = Math.floor(rawBytes / 3);

    const chunks = chunkOversizedSession(
      session,
      maxBytes,
      gzipSyncPayloadSizer,
      maxDecompressedBytes
    );
    assert.ok(chunks.length >= 3, "expected the ceiling to drive >=3 chunks");
    for (const chunk of chunks) {
      assert.ok(rawJsonByteLength(chunk) <= maxDecompressedBytes);
    }
  });

  test("FEA-4152 (wongk): gzip chunking measures compression O(chunks·log), not O(N) per event", () => {
    // A highly-compressible transcript that must split into several ceiling-
    // bounded chunks. The old packer re-gzipped the whole growing prefix after
    // EVERY event (O(N²) gzip → 30s worker timeout for a 4 MiB session); the
    // additive-raw pack gzips only each SEALED chunk once (plus a bounded probe
    // when a sealed chunk still overflows the wire cap). Count the gzip calls
    // (a structural property, not timing) to prove the quadratic regression is
    // gone: it must be far below the event count.
    const eventCount = 600;
    const session = buildSession({ events: buildEvents(eventCount) });
    let byteLengthCalls = 0;
    const countingGzipSizer: typeof gzipSyncPayloadSizer = {
      encoding: gzipSyncPayloadSizer.encoding,
      byteLength: (value) => {
        byteLengthCalls += 1;
        return gzipSyncPayloadSizer.byteLength(value);
      },
      decompressedByteLength: gzipSyncPayloadSizer.decompressedByteLength,
    };
    const rawBytes = rawJsonByteLength(session);
    const wireBytes = gzipSyncPayloadSizer.byteLength(session);
    const maxBytes = wireBytes + 10_000; // whole payload fits the wire cap
    const maxDecompressedBytes = Math.floor(rawBytes / 5); // ceiling forces splits

    const chunks = chunkOversizedSession(
      session,
      maxBytes,
      countingGzipSizer,
      maxDecompressedBytes
    );
    assert.ok(chunks.length >= 5, "the ceiling must drive several chunks");
    // Every chunk still clears both caps (correctness preserved).
    for (const chunk of chunks) {
      assert.ok(rawJsonByteLength(chunk) <= maxDecompressedBytes);
      assert.ok(gzipSyncPayloadSizer.byteLength(chunk) <= maxBytes);
    }
    // The gzip `byteLength` (compression) work is bounded by the number of
    // sealed chunks plus a small per-chunk probe factor — NOT the event count.
    // A quadratic packer would call it ~O(N)=600+ times; assert it stays far
    // below that so a regression to per-event gzip fails here.
    assert.ok(
      byteLengthCalls <= chunks.length * 4,
      `gzip measured ${byteLengthCalls} times for ${chunks.length} chunks over ${eventCount} events (must be O(chunks), not O(events))`
    );
    assert.ok(
      byteLengthCalls < eventCount,
      "gzip must not be measured per event"
    );
  });

  test("the identity path is unchanged: the 4 MiB ceiling never binds under the 256 KiB wire cap", () => {
    // A session that ships whole under identity stays a single `session` — the
    // real ceiling default (4 MiB) is far above the wire cap, so passing it has
    // no effect on the legacy path.
    const session = buildSession({ events: buildEvents(5) });
    const prepared = prepareAgentSessionPayload(
      session,
      SYNC_DECOMPRESSED_BYTE_CEILING, // wire cap well above the tiny payload
      identitySyncPayloadSizer,
      SYNC_DECOMPRESSED_BYTE_CEILING
    );
    assert.equal(prepared.kind, "session");
  });
});
