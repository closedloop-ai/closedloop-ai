/**
 * @file desktop-components-client-chunking.test.ts
 * @description FEA-3621: the desktop→cloud component sync client used to POST
 * the entire component set in a single request. A large org's batch serializes
 * to more than the server's 256 KiB body cap
 * (`DESKTOP_COMPONENTS_SYNC_REQUEST_MAX_BYTES`), so the request was rejected
 * with HTTP 413 and those components never synced — wedging the lane.
 *
 * These tests prove the fix: `sync` splits the components array into sub-cap
 * chunks by *serialized byte size* (not element count), POSTs each chunk
 * separately, and:
 *   - all components still reach the server (union of every chunk == input),
 *   - every request body stays under the server cap (no 413),
 *   - `sync` reports `Accepted` only when EVERY chunk is acked (atomic cursor
 *     advance), and a single failing chunk aborts the batch so the caller
 *     retries the whole thing — idempotent, no dropped/double-counted rows.
 *
 * ISS-4542: `sync` no longer resolves a bare boolean — it resolves a classified
 * {@link ComponentSyncSendResult} (`accepted` / `lane-failure` / `batch-rejected`)
 * so the caller can distinguish a transient lane-wide pause from a permanent
 * per-batch rejection that should charge the dead-letter budget.
 *
 * FEA-3692: an oversized component (one that alone exceeds the per-request budget)
 * is NO LONGER silently skipped-with-success. The sub-cap rows are still POSTed
 * best-effort, but `sync` reports `BatchRejected` (ISS-4542) so the caller does not
 * advance the durable cursor past a definition that never reached the cloud —
 * proving the lane never reports batch success for silently dropped component data.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AgentSessionSyncMode,
  type SyncedComponent,
} from "@repo/api/src/types/agent-session";
import { ComponentSyncSendOutcome } from "../src/main/agent-sync/agent-component-sync-dead-letter.js";
import {
  COMPONENTS_CHUNK_BYTE_BUDGET,
  COMPONENTS_SYNC_REQUEST_MAX_BYTES,
  chunkComponentsByByteSize,
  createDesktopComponentsClient,
} from "../src/main/dashboard/desktop-components-client.js";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";

const CLIENT_TAG = "components-sync-client";
const NOW = "2026-07-21T00:00:00.000Z";
const API_ORIGIN = "https://api.closedloop.test";
const COMPUTE_TARGET = "target-chunk";

function clientLogMessages(): string[] {
  return gatewayLog
    .getEntries()
    .filter((e) => e.tag === CLIENT_TAG)
    .map((e) => e.message);
}

/** Build a component whose JSON serializes to roughly `approxBytes`. */
function makeComponent(
  externalId: string,
  approxBytes: number
): SyncedComponent {
  const base = {
    externalId,
    componentKind: "mcp",
    componentKey: "myserver",
    harness: null,
    name: null,
    version: null,
    description: null,
    sourceUrl: null,
    installPath: null,
    packId: null,
    scope: null,
    projectPath: null,
    metadata: null,
    content: "",
    contentHash: null,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    uninstalledAt: null,
  };
  const overhead = JSON.stringify(base).length;
  const pad = Math.max(0, approxBytes - overhead);
  return { ...base, content: "x".repeat(pad) };
}

function makePayload(components: SyncedComponent[]) {
  return {
    schemaVersion: 1 as const,
    batchId: "batch-chunk",
    syncMode: AgentSessionSyncMode.Incremental,
    componentCount: components.length,
    components,
  };
}

function componentsClientOptions(fetchImpl: typeof fetch) {
  return {
    fetch: fetchImpl,
    getAccessToken: () => Promise.resolve<string | null>("access-token"),
    getApiOrigin: () => API_ORIGIN,
    getComputeTargetId: () => COMPUTE_TARGET,
  };
}

/** A fetch stub that records each request body and returns 200 by default. */
function recordingFetch(
  responder: (callIndex: number) => Response = () =>
    new Response(JSON.stringify({ success: true, data: { synced: true } }), {
      status: 200,
    })
) {
  const bodies: string[] = [];
  const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    bodies.push(body);
    return Promise.resolve(responder(bodies.length - 1));
  }) as typeof fetch;
  return { fetchImpl, bodies };
}

// --- Pure chunker unit tests ---------------------------------------------

test("chunkComponentsByByteSize splits by serialized byte size, not element count", () => {
  // 6 components at ~100 KiB each = ~600 KiB total; budget is ~254 KiB, so we
  // expect multiple chunks, NOT one chunk of 6.
  const components = Array.from({ length: 6 }, (_, i) =>
    makeComponent(`c-${i}`, 100_000)
  );
  const { chunks, oversized } = chunkComponentsByByteSize(components);

  assert.equal(oversized.length, 0);
  assert.ok(chunks.length > 1, `expected >1 chunk, got ${chunks.length}`);

  // Every chunk's serialized body must be under the server cap.
  for (const chunk of chunks) {
    const bodyBytes = new TextEncoder().encode(
      JSON.stringify(makePayload(chunk))
    ).byteLength;
    assert.ok(
      bodyBytes <= COMPONENTS_SYNC_REQUEST_MAX_BYTES,
      `chunk body ${bodyBytes} exceeds cap ${COMPONENTS_SYNC_REQUEST_MAX_BYTES}`
    );
  }

  // No component is dropped and none is duplicated across chunks.
  const flat = chunks.flat();
  assert.equal(flat.length, components.length);
  assert.deepEqual(
    flat.map((c) => c.externalId),
    components.map((c) => c.externalId),
    "order preserved, no drops/dupes"
  );
});

test("chunkComponentsByByteSize isolates a single oversized component", () => {
  const small = makeComponent("small", 1000);
  const huge = makeComponent("huge", COMPONENTS_CHUNK_BYTE_BUDGET + 50_000);
  const small2 = makeComponent("small-2", 1000);

  const { chunks, oversized } = chunkComponentsByByteSize([
    small,
    huge,
    small2,
  ]);

  assert.equal(oversized.length, 1);
  assert.equal(oversized[0].externalId, "huge");
  // The two small components still chunk (the huge one is set aside, not in a body).
  const flat = chunks.flat().map((c) => c.externalId);
  assert.deepEqual(flat, ["small", "small-2"]);
});

// --- Client integration tests --------------------------------------------

test("sync splits a >256 KiB payload into multiple sub-cap requests; all components sync, no 413", async () => {
  gatewayLog.clear();
  const components = Array.from({ length: 6 }, (_, i) =>
    makeComponent(`c-${i}`, 100_000)
  );
  const { fetchImpl, bodies } = recordingFetch();
  const client = createDesktopComponentsClient(
    componentsClientOptions(fetchImpl)
  );

  const result = await client.sync(makePayload(components));

  assert.equal(
    result.outcome,
    ComponentSyncSendOutcome.Accepted,
    "all chunks acked → Accepted"
  );
  assert.equal(
    result.firstUnsentChunkIndex,
    null,
    "a fully-accepted batch has no unsent chunk"
  );
  assert.ok(bodies.length > 1, `expected multiple POSTs, got ${bodies.length}`);

  // Every request body is under the server cap (would have 413'd otherwise).
  for (const body of bodies) {
    const bytes = new TextEncoder().encode(body).byteLength;
    assert.ok(
      bytes <= COMPONENTS_SYNC_REQUEST_MAX_BYTES,
      `request body ${bytes} exceeds cap ${COMPONENTS_SYNC_REQUEST_MAX_BYTES}`
    );
  }

  // Every original component reached the server exactly once across the chunks.
  const seen = bodies.flatMap(
    (body) =>
      (JSON.parse(body) as { components: { externalId: string }[] }).components
  );
  assert.deepEqual(
    seen.map((c) => c.externalId).sort(),
    components.map((c) => c.externalId).sort()
  );
});

test("sync reports LaneFailure if any chunk fails (atomic cursor advance → whole batch retries)", async () => {
  gatewayLog.clear();
  const components = Array.from({ length: 6 }, (_, i) =>
    makeComponent(`c-${i}`, 100_000)
  );
  // Fail the second request with a 5xx; the client must abort and report a
  // LaneFailure so the caller does not advance the cursor past the un-acked rows
  // (a 5xx is lane-wide — it never charges the poison budget).
  const { fetchImpl, bodies } = recordingFetch((i) =>
    i === 1
      ? new Response("boom", { status: 500 })
      : new Response(
          JSON.stringify({ success: true, data: { synced: true } }),
          {
            status: 200,
          }
        )
  );
  const client = createDesktopComponentsClient(
    componentsClientOptions(fetchImpl)
  );

  const result = await client.sync(makePayload(components));

  assert.equal(
    result.outcome,
    ComponentSyncSendOutcome.LaneFailure,
    "a failed 5xx chunk → LaneFailure (batch not accepted, lane paused)"
  );
  // The failing chunk was the second one (index 1); the cursor page from there on
  // never reached the cloud.
  assert.equal(result.firstUnsentChunkIndex, 1, "the second chunk was unsent");
  // It stopped at the failing chunk rather than continuing to send later ones.
  assert.equal(bodies.length, 2, "aborted after the failing chunk");
  assert.ok(
    clientLogMessages().some((m) => m.includes("chunk 2/")),
    `expected a named chunk-failure log, got: ${JSON.stringify(clientLogMessages())}`
  );
});

test("sync re-run is idempotent: the same batch produces the same chunked requests", async () => {
  const components = Array.from({ length: 6 }, (_, i) =>
    makeComponent(`c-${i}`, 100_000)
  );

  const first = recordingFetch();
  const clientA = createDesktopComponentsClient(
    componentsClientOptions(first.fetchImpl)
  );
  const secondRun = recordingFetch();
  const clientB = createDesktopComponentsClient(
    componentsClientOptions(secondRun.fetchImpl)
  );

  assert.equal(
    (await clientA.sync(makePayload(components))).outcome,
    ComponentSyncSendOutcome.Accepted
  );
  assert.equal(
    (await clientB.sync(makePayload(components))).outcome,
    ComponentSyncSendOutcome.Accepted
  );

  // Re-running the identical batch yields the identical chunk boundaries — the
  // server upserts by key, so replaying is a no-op change, never a duplicate.
  assert.equal(first.bodies.length, secondRun.bodies.length);
  const idsOf = (bodies: string[]) =>
    bodies.map((body) =>
      (JSON.parse(body) as { components: { externalId: string }[] }).components
        .map((c) => c.externalId)
        .join(",")
    );
  assert.deepEqual(idsOf(first.bodies), idsOf(secondRun.bodies));
});

test("FEA-3692: an oversized component sends the sub-cap rest but reports BatchRejected (no cursor advance past dropped data)", async () => {
  // Safety net: with content clamped by serialized byte size upstream this is
  // unreachable for real bodies, but if a component STILL exceeds the per-request
  // budget on its own the lane must NOT report batch success — that would advance
  // the durable cursor past a definition that never reached the cloud (silent data
  // loss). It sends the sub-cap rows best-effort (they upsert idempotently) and
  // reports `BatchRejected` (ISS-4542) — a permanent per-batch problem — so the
  // caller's bounded dead-letter budget advances past the poison row instead of
  // head-of-line-blocking the lane forever.
  gatewayLog.clear();
  const components = [
    makeComponent("ok-1", 1000),
    makeComponent("too-big", COMPONENTS_CHUNK_BYTE_BUDGET + 50_000),
    makeComponent("ok-2", 1000),
  ];
  const { fetchImpl, bodies } = recordingFetch();
  const client = createDesktopComponentsClient(
    componentsClientOptions(fetchImpl)
  );

  const result = await client.sync(makePayload(components));

  assert.equal(
    result.outcome,
    ComponentSyncSendOutcome.BatchRejected,
    "oversized component present → BatchRejected so the cursor does not advance past it (dead-letter budget charges)"
  );
  // The sub-cap rows were still POSTed (best effort, idempotent) — only the
  // oversized one is held back.
  const seen = bodies.flatMap(
    (body) =>
      (JSON.parse(body) as { components: { externalId: string }[] }).components
  );
  assert.deepEqual(seen.map((c) => c.externalId).sort(), ["ok-1", "ok-2"]);
  // No emitted body carries the oversized component (that would 413).
  assert.ok(
    !seen.some((c) => c.externalId === "too-big"),
    "oversized component is never placed in a request body"
  );
  assert.ok(
    clientLogMessages().some((m) => m.includes("oversized")),
    `expected an oversized-retained log, got: ${JSON.stringify(clientLogMessages())}`
  );
});

test("FEA-3692: a batch of ONLY oversized components reports BatchRejected (never reports success for dropped data)", async () => {
  // Regression for the exact silent-data-loss path: the pre-fix client returned
  // `true` when `chunks.length === 0` (every component oversized), advancing the
  // cursor past components that never reached the cloud. It must now report
  // `BatchRejected` (ISS-4542) and emit no request body.
  gatewayLog.clear();
  const components = [
    makeComponent("huge-1", COMPONENTS_CHUNK_BYTE_BUDGET + 50_000),
    makeComponent("huge-2", COMPONENTS_CHUNK_BYTE_BUDGET + 90_000),
  ];
  const { fetchImpl, bodies } = recordingFetch();
  const client = createDesktopComponentsClient(
    componentsClientOptions(fetchImpl)
  );

  const result = await client.sync(makePayload(components));

  assert.equal(
    result.outcome,
    ComponentSyncSendOutcome.BatchRejected,
    "all-oversized batch must not report success (cursor stays put, dead-letter budget charges)"
  );
  assert.equal(bodies.length, 0, "no sub-cap chunk to send → no POST emitted");
});
