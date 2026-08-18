import assert from "node:assert/strict";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { SyncPayloadEncoding } from "@repo/api/src/types/agent-session";
import type { SessionCursorRow } from "../src/main/agent-sync/agent-session-read-model.js";
import {
  gzipJson,
  identitySyncPayloadSizer,
} from "../src/main/agent-sync/agent-session-sync-compression.js";
import type {
  AgentSessionSyncBatch,
  SyncedAgentSession,
} from "../src/main/agent-sync/agent-session-sync-contract.js";
import type {
  AgentSessionPayloadPreparer,
  PreparedAgentSessionPayload,
} from "../src/main/agent-sync/agent-session-sync-payload.js";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import type { AgentSessionSyncSource } from "../src/main/agent-sync/agent-session-sync-source.js";

/**
 * FEA-4138 service-wiring: prove the negotiated capability drives BOTH the
 * outbound `encoding` stamp and the transport `compress` hint, and that the
 * uncompressed default is unchanged. Minimal in-memory source (backfill mode,
 * no persisted cursor) exercises the accumulate → send seam without the full
 * fake in agent-session-sync-service.test.ts.
 */
class MinimalSyncSource implements AgentSessionSyncSource {
  private readonly sessions: SyncedAgentSession[];
  /** FEA-4152: records prefilter calls so a test can prove gzip bypasses it. */
  findLocallyOversizedCallCount = 0;
  /**
   * FEA-4152: when true, the prefilter flags EVERY candidate as oversized (as
   * a raw>256KiB session does under the identity cap). A test that expects the
   * session to still sync under gzip therefore proves the service bypassed the
   * prefilter — without the bypass the session would be dead-lettered here and
   * never sent.
   */
  flagAllOversized = false;

  constructor(sessions: SyncedAgentSession[]) {
    this.sessions = sessions;
  }

  listAllSessionCursorRows(): SessionCursorRow[] {
    return this.sessions.map((session) => ({
      id: session.externalSessionId,
      updated_at: session.updatedAt,
    }));
  }

  listUpdatedSessionCursorRows(): SessionCursorRow[] {
    return [];
  }

  loadSyncedSessions(ids: string[]): SyncedAgentSession[] {
    return this.sessions.filter((session) =>
      ids.includes(session.externalSessionId)
    );
  }

  findLocallyOversizedSessions(
    ids: string[]
  ): { id: string; payloadBytes: number }[] {
    this.findLocallyOversizedCallCount += 1;
    if (!this.flagAllOversized) {
      return [];
    }
    return ids.map((id) => ({ id, payloadBytes: Number.MAX_SAFE_INTEGER }));
  }

  loadSyncState(): null {
    return null;
  }

  advanceSyncState(): void {
    // in-memory only; nothing to persist
  }
}

function makeSyncedSession(id: string): SyncedAgentSession {
  return {
    externalSessionId: id,
    status: "completed",
    harness: "codex",
    cwd: `/workspace/${id}`,
    startedAt: "2026-06-08T12:00:00.000Z",
    updatedAt: "2026-06-08T12:00:00.000Z",
    agents: [],
    events: [],
    tokenUsageByModel: [
      {
        model: "gpt-5",
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCostUsd: 0.001,
      },
    ],
  };
}

// A highly-repetitive transcript whose slim per-event metadata is large enough
// that it must chunk even under gzip when the wire cap is small — used to
// populate `pendingChunks` with `compress: true` for the downgrade test.
function makeChunkingSyncedSession(id: string): SyncedAgentSession {
  return {
    ...makeSyncedSession(id),
    events: Array.from({ length: 4000 }, (_, index) => ({
      externalEventId: `${id}-event-${index}`,
      eventType: "ToolUse",
      toolName: "Read",
      createdAt: "2026-06-08T12:00:00.000Z",
    })),
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test("FEA-4138: negotiated compression stamps encoding=gzip and asks the transport to compress", async () => {
  const source = new MinimalSyncSource([makeSyncedSession("sess-c-1")]);
  const sent: Array<{
    batch: AgentSessionSyncBatch;
    compress: boolean | undefined;
  }> = [];
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    isSyncCompressionSupported: () => true,
    getSource: () => source,
    sendBatch: (batch, options) => {
      sent.push({ batch, compress: options?.compress });
      return Promise.resolve({ accepted: true });
    },
  });

  service.start();
  await flush();
  service.stop();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].compress, true);
  assert.equal(sent[0].batch.encoding, SyncPayloadEncoding.Gzip);
  // The batch body round-trips through gzip to the same content.
  const restored = JSON.parse(
    gunzipSync(gzipJson(sent[0].batch)).toString("utf8")
  );
  assert.deepEqual(restored, JSON.parse(JSON.stringify(sent[0].batch)));
});

test("FEA-4138 skew: without negotiated compression the batch omits encoding and does not compress", async () => {
  const source = new MinimalSyncSource([makeSyncedSession("sess-c-2")]);
  const sent: Array<{
    batch: AgentSessionSyncBatch;
    compress: boolean | undefined;
  }> = [];
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    // Opposite branch: capability off (also the default when the option is
    // omitted). The assertion below would fail if the service compressed anyway.
    isSyncCompressionSupported: () => false,
    getSource: () => source,
    sendBatch: (batch, options) => {
      sent.push({ batch, compress: options?.compress });
      return Promise.resolve({ accepted: true });
    },
  });

  service.start();
  await flush();
  service.stop();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].compress, false);
  assert.equal(sent[0].batch.encoding, undefined);
  // The uncompressed batch is byte-identical to plain JSON sizing.
  assert.ok(
    identitySyncPayloadSizer.byteLength(sent[0].batch) ===
      Buffer.byteLength(JSON.stringify(sent[0].batch))
  );
});

test("FEA-4152 fix 2: under gzip, a session the identity prefilter flags oversized still syncs (prefilter bypassed)", async () => {
  const source = new MinimalSyncSource([makeSyncedSession("sess-4152-2")]);
  // Model a raw>256KiB session: the identity-cap prefilter would flag it,
  // dead-lettering it before hydration. Under gzip it compresses well under the
  // wire cap, so the service must bypass the prefilter and send it.
  source.flagAllOversized = true;
  const sent: Array<{
    batch: AgentSessionSyncBatch;
    compress: boolean | undefined;
  }> = [];
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    isSyncCompressionSupported: () => true,
    getSource: () => source,
    sendBatch: (batch, options) => {
      sent.push({ batch, compress: options?.compress });
      return Promise.resolve({ accepted: true });
    },
  });

  service.start();
  await flush();
  service.stop();

  // The prefilter was bypassed (never consulted) and the session shipped gzip.
  assert.equal(
    source.findLocallyOversizedCallCount,
    0,
    "gzip negotiation must skip the identity prefilter entirely"
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].compress, true);
  assert.equal(sent[0].batch.sessions[0].externalSessionId, "sess-4152-2");
});

test("FEA-4152 fix 2 skew: without gzip the identity prefilter still runs and dead-letters an oversized session", async () => {
  const source = new MinimalSyncSource([makeSyncedSession("sess-4152-2b")]);
  source.flagAllOversized = true;
  const sent: AgentSessionSyncBatch[] = [];
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    // Opposite branch: no gzip → the prefilter MUST run (this is the legacy
    // path). The oversized flag then drops the session before send, so nothing
    // is transmitted — proving the bypass is gated strictly on gzip.
    isSyncCompressionSupported: () => false,
    getSource: () => source,
    sendBatch: (batch) => {
      sent.push(batch);
      return Promise.resolve({ accepted: true });
    },
  });

  service.start();
  await flush();
  service.stop();

  assert.ok(
    source.findLocallyOversizedCallCount > 0,
    "the identity path must still consult the prefilter"
  );
  assert.equal(sent.length, 0, "the flagged-oversized session is dropped");
});

test("FEA-4152 fix 3: a mid-drain compression downgrade discards gzip chunks and re-prepares under identity", async () => {
  const source = new MinimalSyncSource([makeChunkingSyncedSession("sess-dg")]);
  // Injected preparer: deterministic 2-chunk split sized for the requested
  // encoding. Records each call's `compress` flag so we can prove the second
  // (post-downgrade) preparation runs under identity, not gzip.
  const prepareCompressFlags: Array<boolean | undefined> = [];
  const preparePayloads: AgentSessionPayloadPreparer = (
    sessions,
    _maxBytes,
    compress
  ) => {
    prepareCompressFlags.push(compress);
    const payloads: PreparedAgentSessionPayload[] = sessions.map((session) => {
      const half = Math.ceil(session.events.length / 2);
      const firstChunk: SyncedAgentSession = {
        ...session,
        events: session.events.slice(0, half),
        chunk: { index: 0, total: 2 },
      };
      const secondChunk: SyncedAgentSession = {
        ...session,
        events: session.events.slice(half),
        chunk: { index: 1, total: 2 },
      };
      return {
        kind: "chunked",
        sessionId: session.externalSessionId,
        firstChunk,
        remainingChunks: [secondChunk],
        payloadBytes: 10_000,
        firstChunkBytes: 5000,
        chunkCount: 2,
      };
    });
    return Promise.resolve(payloads);
  };

  let compressionSupported = true;
  const sent: Array<{
    encoding: SyncPayloadEncoding | undefined;
    compress: boolean | undefined;
    chunkIndex: number | undefined;
  }> = [];
  // FEA-2399 determinism: resolve on the FINAL (identity) send instead of a
  // fixed tick count, so the drain loop stops the instant the re-prepared
  // session actually lands rather than after an arbitrary number of pumps.
  const identityResent = deferred<void>();
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    isSyncCompressionSupported: () => compressionSupported,
    getSource: () => source,
    preparePayloads,
    sendBatch: (batch, options) => {
      sent.push({
        encoding: batch.encoding,
        compress: options?.compress,
        chunkIndex: batch.sessions[0]?.chunk?.index,
      });
      // After the FIRST (chunk 0) gzip send, the server capability DOWNGRADES
      // (we reconnected to an older server that never advertised gzip). This
      // fires synchronously before the pinned second chunk can drain, so the
      // next drain hits the downgrade guard rather than posting a gzip chunk
      // the older server would 400 (`Invalid compressed body` → dead-letter).
      if (sent.length === 1) {
        compressionSupported = false;
      } else if (options?.compress === false) {
        // The re-prepared identity send landed — the real completion signal.
        identityResent.resolve();
      }
      return Promise.resolve({ accepted: true });
    },
  });

  // Tick 1: gzip negotiated → first chunk ships compressed, second is pinned as
  // a gzip-sized pending chunk (compress: true).
  service.start();
  await flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].compress, true);
  assert.equal(sent[0].encoding, SyncPayloadEncoding.Gzip);
  assert.equal(sent[0].chunkIndex, 0);

  // Drain: the downgrade guard discards the pinned gzip chunk and lets the
  // still-queued session re-hydrate + re-prepare under identity. Nudge the
  // service until the identity re-send fires, then await its real completion
  // signal. The nudge loop is bounded and THROWS if exhausted (FEA-2399: a
  // silent fall-through would let a stale assertion pass), never relying on a
  // fixed pump count.
  const maxNudges = 20;
  let nudges = 0;
  while (sent.length < 2) {
    if (nudges >= maxNudges) {
      throw new Error(
        `identity re-send did not fire within ${maxNudges} nudges (sent=${sent.length})`
      );
    }
    nudges += 1;
    service.refresh();
    await flush();
  }
  await identityResent.promise;
  service.stop();

  assert.ok(
    sent.length >= 2,
    "session re-sent under identity after the downgrade"
  );
  // No send after the initial gzip chunk may carry a gzip header — that is the
  // whole point: the older server never receives a Content-Encoding: gzip body.
  const postDowngrade = sent.slice(1);
  assert.ok(
    postDowngrade.every(
      (s) => s.compress === false && s.encoding === undefined
    ),
    "post-downgrade sends must be identity (no gzip header)"
  );
  // The pinned gzip chunk (index 1, compress true) was NEVER posted.
  assert.ok(
    !sent
      .slice(1)
      .some(
        (s) => s.compress === true || s.encoding === SyncPayloadEncoding.Gzip
      ),
    "the pinned gzip chunk must be discarded, never posted after the downgrade"
  );
  // Re-preparation ran under identity after the initial gzip preparation.
  assert.equal(prepareCompressFlags[0], true);
  assert.ok(
    prepareCompressFlags.slice(1).some((flag) => flag !== true),
    "re-preparation after downgrade must use identity encoding"
  );
});
