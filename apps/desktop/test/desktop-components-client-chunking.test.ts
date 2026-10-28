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
import { SyncReason } from "@closedloop-ai/telemetry-contract/sync";
import {
  AgentSessionSyncMode,
  type SyncedComponent,
} from "@repo/api/src/types/agent-session";
import { test } from "vitest";
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

// --- ISS-9698: Retry-After reaches the caller ------------------------------

/** Thirty minutes, in the header's delta-seconds form and in milliseconds. */
const RETRY_AFTER_SECONDS = "1800";
const RETRY_AFTER_MS = 1_800_000;

test("ISS-9698: a throttled send carries the server's Retry-After to the caller", async () => {
  // The lane's environmental defer gate honors this as a MINIMUM, so without it
  // a 429 asking for half an hour was retried on the staged five-minute rung.
  // Driving the real client is the point: constructing a result with a
  // `retryAfterMs` by hand would leave the header read unasserted, and deleting
  // it from `postChunk` would keep every such test green.
  const { fetchImpl } = recordingFetch(
    () =>
      new Response("slow down", {
        status: 429,
        headers: { "Retry-After": RETRY_AFTER_SECONDS },
      })
  );
  const client = createDesktopComponentsClient(
    componentsClientOptions(fetchImpl)
  );

  const result = await client.sync(makePayload([makeComponent("c-0", 100)]));

  assert.equal(result.outcome, ComponentSyncSendOutcome.LaneFailure);
  assert.equal(result.retryAfterMs, RETRY_AFTER_MS);
});

test("ISS-9698: a failure with no Retry-After OMITS the hint rather than sending zero", async () => {
  // The positive sibling's mirror: absence has to stay distinguishable from a
  // real "retry immediately", because the gate takes `max(staged, hint)` and a
  // fabricated 0 would read as a genuine instruction that happens to be ignored
  // today — a value that becomes wrong the moment the floor is ever removed.
  const { fetchImpl } = recordingFetch(
    () => new Response("upstream unavailable", { status: 503 })
  );
  const client = createDesktopComponentsClient(
    componentsClientOptions(fetchImpl)
  );

  const result = await client.sync(makePayload([makeComponent("c-0", 100)]));

  assert.equal(result.outcome, ComponentSyncSendOutcome.LaneFailure);
  assert.ok(
    !("retryAfterMs" in result),
    "a server that asked for nothing must leave the staged schedule to own the delay"
  );
});

test("ISS-9698: an unparseable Retry-After degrades to the staged schedule", async () => {
  // Cross-repo skew: the header is external text and can be anything. A value
  // this build cannot read must not throw out of the lane's tick and must not
  // produce a plausible-but-wrong delay — it must simply not be a hint.
  for (const header of ["soon", "-30", "NaN", "1e999", "1.5"]) {
    const { fetchImpl } = recordingFetch(
      () =>
        new Response("slow down", {
          status: 429,
          headers: { "Retry-After": header },
        })
    );
    const client = createDesktopComponentsClient(
      componentsClientOptions(fetchImpl)
    );

    const result = await client.sync(makePayload([makeComponent("c-0", 100)]));

    assert.equal(result.outcome, ComponentSyncSendOutcome.LaneFailure);
    assert.ok(
      !("retryAfterMs" in result),
      `Retry-After: ${header} is not a wait this build can honor, so it must be absent`
    );
  }
});

test("ISS-9698 review: a BatchRejected does NOT carry a Retry-After hint", async () => {
  // The field's contract says it is read on the `LaneFailure` arm. A 413 is a
  // permanent per-batch rejection that charges the poison budget and never
  // reaches the environmental gate, so a wait riding along on it would make that
  // contract false — and a later reader could take its presence as proof the
  // failure was lane-wide. Enforced here rather than asserted in prose.
  const { fetchImpl } = recordingFetch(
    () =>
      new Response("too large", {
        status: 413,
        headers: { "Retry-After": RETRY_AFTER_SECONDS },
      })
  );
  const client = createDesktopComponentsClient(
    componentsClientOptions(fetchImpl)
  );

  const result = await client.sync(makePayload([makeComponent("c-0", 100)]));

  assert.equal(result.outcome, ComponentSyncSendOutcome.BatchRejected);
  assert.ok(
    !("retryAfterMs" in result),
    "a permanent per-batch rejection must not carry a lane-wide wait"
  );
});

// --- ISS-8609: the coded 400 the client reads off the response body ---------
//
// Wire spellings are hand-written here, never imported from
// `DesktopComponentsSyncRestErrorCode`: a fixture that reads its expectation off
// the const it guards stays green through a rename, and a rename is a wire break
// for every installed desktop that does not ship with the cloud.
const SKEW_CODE = "schema_version_unsupported";
const CONTENT_CODE = "validation_failed";

/**
 * The keys a plain `{}` answers from `Object.prototype` rather than from its own
 * entries. `__proto__` is listed alongside the rest because it does NOT behave
 * like them — it resolves through an accessor, not a data property — and a fix
 * covering only one of the two shapes would leave the other reachable.
 */
const OBJECT_PROTOTYPE_KEYS = [
  "__proto__",
  "constructor",
  "toString",
  "valueOf",
  "hasOwnProperty",
];

/** A failure body streamed in 4 KiB chunks, far past the client's 8 KiB cap. */
const CAP_PROBE_CHUNK_BYTES = 4096;
const CAP_PROBE_TOTAL_CHUNKS = 64;
const CAP_PROBE_MAX_EXPECTED_CHUNKS = 6;

/** The first-party failure envelope `failure()` emits — `code` at the top level. */
function codedFailureBody(code: string): string {
  return JSON.stringify({ success: false, error: "rejected", code });
}

test("ISS-8609: a coded content 400 reaches the ITEM ladder instead of deferring forever", async () => {
  // The causal case. A 400 defers by the profile's ledger deviation, so
  // BatchRejected is only reachable if the client extracted the body's code and
  // handed it to the classifier. Delete either half and this test reds.
  const { fetchImpl } = recordingFetch(
    () =>
      new Response(codedFailureBody(CONTENT_CODE), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
  );
  const client = createDesktopComponentsClient(
    componentsClientOptions(fetchImpl)
  );

  const result = await client.sync(makePayload([makeComponent("c-0", 100)]));

  assert.equal(result.outcome, ComponentSyncSendOutcome.BatchRejected);
  // The reason travels with the outcome. A content rejection keeps the
  // status-derived reason — it IS a validation failure — which is what makes the
  // skew case below a genuine contrast rather than a second spelling of this one.
  assert.equal(result.reason, SyncReason.ValidationFailed);
});

test("ISS-8609: a coded skew 400 pauses the lane, charges nothing, and is telemetered as a protocol gap", async () => {
  // The compatibility half: coding the skew must not move it. Asserted as its
  // own case rather than folded into the one above, because both cases answering
  // the same outcome would prove nothing about either.
  const { fetchImpl } = recordingFetch(
    () =>
      new Response(codedFailureBody(SKEW_CODE), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
  );
  const client = createDesktopComponentsClient(
    componentsClientOptions(fetchImpl)
  );

  const result = await client.sync(makePayload([makeComponent("c-0", 100)]));

  assert.equal(result.outcome, ComponentSyncSendOutcome.LaneFailure);
  // The half the outcome cannot carry, and the reason this case is not redundant
  // with the bare-400 one below: both defer, but only this one knows WHY. A
  // status-derived reason would report `validation_failed` for a skew, so the
  // give-up channel — the single channel a lane give-up is ever observed on —
  // could not tell "waiting on an API deploy" from "this batch is bad".
  assert.equal(result.reason, SyncReason.ProtocolUnsupported);
});

test("ISS-8609: a first-party envelope with NO code falls through to the status", async () => {
  // The live uncoded shape, and the one the AC's "old server" half is about: a
  // pre-ISS-8609 skew 400 is `badRequestResponse(message)`, i.e. parseable
  // first-party JSON with `success: false` and no `code`. `requireComputeTargetId`
  // still answers exactly this today. Driving it is what executes the
  // envelope-present / code-absent branch — the non-JSON cases below take the
  // `catch` instead and never reach it.
  const { fetchImpl } = recordingFetch(
    () =>
      new Response(
        JSON.stringify({
          success: false,
          error: "Invalid component sync payload",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
  );
  const client = createDesktopComponentsClient(
    componentsClientOptions(fetchImpl)
  );

  const result = await client.sync(makePayload([makeComponent("c-0", 100)]));

  assert.equal(result.outcome, ComponentSyncSendOutcome.LaneFailure);
  assert.equal(result.reason, SyncReason.ValidationFailed);
});

test("ISS-8609: an oversized failure body is declined without parsing", async () => {
  // Susan's bound: this runs on every failing tick, so an intermediary's error
  // page must not be parsed in the main process. Built as VALID JSON carrying a
  // real code, so the only thing that can make it decline is the size check — a
  // test using malformed JSON would pass on the `catch`. The sibling case below
  // pins the other half of that bound: that the body is never fully READ either.
  const padded = JSON.stringify({
    success: false,
    error: "x".repeat(16_384),
    code: CONTENT_CODE,
  });
  const { fetchImpl } = recordingFetch(
    () =>
      new Response(padded, {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
  );
  const client = createDesktopComponentsClient(
    componentsClientOptions(fetchImpl)
  );

  const result = await client.sync(makePayload([makeComponent("c-0", 100)]));

  assert.equal(result.outcome, ComponentSyncSendOutcome.LaneFailure);
});

test("ISS-8609: an oversized failure body is abandoned at the cap, not buffered whole", async () => {
  // The allocation half of Susan's bound. A cap applied AFTER `response.text()`
  // bounds the PARSE and not the memory: a proxy or WAF returning a large non-2xx
  // body on every sync attempt is still buffered in full first. The OUTCOME
  // cannot tell the two implementations apart — both decline the code and defer —
  // so this asserts on the stream itself: how many chunks the peer was asked for,
  // and that the reader was cancelled rather than drained.
  const chunk = new TextEncoder().encode("x".repeat(CAP_PROBE_CHUNK_BYTES));
  let chunksPulled = 0;
  let cancelled = false;
  const { fetchImpl } = recordingFetch(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (chunksPulled >= CAP_PROBE_TOTAL_CHUNKS) {
              controller.close();
              return;
            }
            chunksPulled++;
            controller.enqueue(chunk);
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
  );
  const client = createDesktopComponentsClient(
    componentsClientOptions(fetchImpl)
  );

  const result = await client.sync(makePayload([makeComponent("c-0", 100)]));

  // 8 KiB cap over 4 KiB chunks: the bound is crossed on the third chunk, and
  // the default queuing strategy may have pulled one more ahead of the reader.
  assert.ok(
    chunksPulled <= CAP_PROBE_MAX_EXPECTED_CHUNKS,
    `expected the reader to stop near the cap, pulled ${chunksPulled} of ${CAP_PROBE_TOTAL_CHUNKS} chunks`
  );
  assert.equal(cancelled, true);
  assert.equal(result.outcome, ComponentSyncSendOutcome.LaneFailure);
});

test("ISS-8609: a code colliding with an Object prototype key falls back to the status", async () => {
  // The code is a SERVER-SUPPLIED string indexing this lane's reason map. Read
  // off a plain object literal, `__proto__` answers `Object.prototype` and
  // `constructor` / `toString` / `valueOf` / `hasOwnProperty` answer functions —
  // every one of them truthy, so the `??` status fallback never fires and the
  // lane ships a value outside `SyncReason` on its give-up channel. Asserted on
  // the EMITTED REASON, not on the absence of a key: absence alone would stay
  // green while the wrong value went out.
  for (const hostileCode of OBJECT_PROTOTYPE_KEYS) {
    const { fetchImpl } = recordingFetch(
      () =>
        new Response(codedFailureBody(hostileCode), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        })
    );
    const client = createDesktopComponentsClient(
      componentsClientOptions(fetchImpl)
    );

    const result = await client.sync(makePayload([makeComponent("c-0", 100)]));

    assert.equal(
      result.outcome,
      ComponentSyncSendOutcome.LaneFailure,
      hostileCode
    );
    assert.equal(result.reason, SyncReason.ValidationFailed, hostileCode);
  }
});

test("ISS-8609: a code from a body that is not a first-party envelope is refused", async () => {
  // A 400 need not come from our API: a proxy, WAF or corporate gateway can
  // answer one with its own JSON. Here the code is an INSTRUCTION that decides
  // whether the poison budget is charged, so `extractApiFailureEnvelopeCode`'s
  // `success: false` check is load-bearing — without it an intermediary could
  // walk a healthy inventory into a dead-letter. Paired with the coded case
  // above: the SAME code, and only the envelope differs.
  const { fetchImpl } = recordingFetch(
    () =>
      new Response(JSON.stringify({ code: CONTENT_CODE }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
  );
  const client = createDesktopComponentsClient(
    componentsClientOptions(fetchImpl)
  );

  const result = await client.sync(makePayload([makeComponent("c-0", 100)]));

  assert.equal(result.outcome, ComponentSyncSendOutcome.LaneFailure);
});

test("ISS-8609: an unparseable body degrades to the status rather than throwing", async () => {
  // An HTML error page from an intermediary is the common shape. `JSON.parse`
  // must not escape `postChunk` — a throw here would be caught as a transport
  // error and mislabel a server answer the lane did receive.
  const { fetchImpl } = recordingFetch(
    () =>
      new Response("<html><body>400 Bad Request</body></html>", {
        status: 400,
        headers: { "Content-Type": "text/html" },
      })
  );
  const client = createDesktopComponentsClient(
    componentsClientOptions(fetchImpl)
  );

  const result = await client.sync(makePayload([makeComponent("c-0", 100)]));

  assert.equal(result.outcome, ComponentSyncSendOutcome.LaneFailure);
  // Pinned to the SERVER-ANSWERED reason, not `TransportError`: that is what
  // separates "the code extraction declined" from "`JSON.parse` threw out of
  // `postChunk` and the catch above relabelled a real 400 as a network fault".
  assert.equal(result.reason, SyncReason.ValidationFailed);
});
