/**
 * ISS-8710 — the tail-chunk drain measures its BUILT batch against the request
 * cap before posting it.
 *
 * The chunker packs SESSIONS against `SESSION_PAYLOAD_CONTENT_BYTE_CAP`, which
 * is `SESSION_PAYLOAD_BYTE_CAP` minus the RAW width of the batch envelope. That
 * subtraction is exact under identity encoding, because a batch's JSON embeds
 * the session's own serialization verbatim. It is NOT a bound under gzip: the
 * packer is handed the same raw-derived budget together with the gzip sizer, so
 * it packs to `gzip(session) <= rawCap - rawEnvelope` while the route judges
 * `gzip(batch) <= rawCap`, and `gzip(batch) - gzip(session)` is content-
 * dependent rather than the raw envelope width. Measured on this branch under
 * node 24.18.1, the widest such delta over 20 incompressible sessions packed to
 * the budget was 188 B against a 200 B reserve — it holds, by 12 bytes, on a
 * quantity nothing bounds.
 *
 * `accumulateSessionPayload` / `accumulateChunkedPayload` already re-measure a
 * lone session or a first chunk against the cap with the tick's own sizer, so
 * they never depend on that margin. `resolvePendingChunkTransition` — the
 * tail-chunk drain, the one lane that reaches the wire — built the batch and
 * posted it. These cases pin the missing re-measure, and that it judges wire
 * bytes rather than raw ones.
 *
 * The boundary itself is deliberately NOT pinned within a few bytes of 256 KiB:
 * deflate block boundaries move with a zlib bump, so such a case would assert
 * the compressor, not the lane. Each case here drives the decision on a fixture
 * that is unambiguously over or under its cap.
 */
import assert from "node:assert/strict";
import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import { test } from "vitest";
import type { BoundedFailureFoldConfig } from "../src/main/agent-sync/agent-session-sync-ack-fold.js";
import {
  MAX_CONSECUTIVE_VALIDATION_FAILED,
  SESSION_PAYLOAD_BYTE_CAP,
  SESSION_PAYLOAD_CONTENT_BYTE_CAP,
  VALIDATION_FAILED_BACKOFF_MS,
} from "../src/main/agent-sync/agent-session-sync-backoff-policy.js";
import { rawJsonByteLength } from "../src/main/agent-sync/agent-session-sync-compression.js";
import {
  type AgentSessionSyncTransportPayload,
  buildAgentSessionSyncBatch,
  type SyncedAgentSession,
} from "../src/main/agent-sync/agent-session-sync-contract.js";
import { applyPendingChunkDiscard } from "../src/main/agent-sync/agent-session-sync-dispositions.js";
import {
  estimateSessionPayloadBytes,
  type PreparedAgentSessionPayload,
} from "../src/main/agent-sync/agent-session-sync-payload.js";
import {
  type PendingChunks,
  resolvePendingChunkTransition,
} from "../src/main/agent-sync/agent-session-sync-pending-chunks.js";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import { buildAgentSessionSyncSourceKey } from "../src/main/agent-sync/agent-session-sync-source.js";
import { CHUNK_VALIDATION_FAILED_REASON } from "../src/main/agent-sync/agent-session-sync-validation-failure.js";
import {
  type DesktopSyncBatchEventInput,
  DesktopSyncBatchOutcome,
} from "../src/main/telemetry/app-otel-runtime.js";
import {
  pumpSyncDrainTurn,
  runWithMockedNow,
} from "./agent-session-sync-service-fixtures.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";

const TAIL_SESSION_ID = "sess-tail-cap";
const COMPUTE_TARGET = "tail-cap-target";
const SOURCE_KEY = buildAgentSessionSyncSourceKey(COMPUTE_TARGET);
/** Bounded so a lane that never dead-letters fails loudly instead of hanging. */
const MAX_DRIVE_STEPS = 60;
/** Compresses to a few hundred bytes while serializing to ~200 KiB raw. */
const COMPRESSIBLE_PADDING = "a".repeat(200_000);

test("ISS-8710: an identity tail chunk one byte past the route cap is refused, not posted", () => {
  // The smallest fixture the route would reject. No injected cap: this drives
  // the production default.
  const transition = resolvePendingChunkTransition(
    pinnedTail([tailOfWrappedBytes(SESSION_PAYLOAD_BYTE_CAP + 1)]),
    false
  );

  assert.equal(
    transition.kind,
    "reject-oversized",
    "the tail drain posted a batch one byte past the route cap; the chunker's budget is raw-derived and only the built batch settles what the route judges"
  );
  assert.equal(
    transition.kind === "reject-oversized" && transition.sessionId,
    TAIL_SESSION_ID
  );
  assert.equal(
    transition.kind === "reject-oversized" && transition.chunkBytes,
    SESSION_PAYLOAD_BYTE_CAP + 1
  );
});

test("ISS-8710: an identity tail chunk landing exactly ON the route cap still drains", () => {
  // POSITIVE CONTROL, and the other half of the boundary. Without it the case
  // above is satisfied by a guard that refuses every tail, which would strand
  // every chunked session on earth.
  const chunk = tailOfWrappedBytes(SESSION_PAYLOAD_BYTE_CAP);
  assert.ok(
    estimateSessionPayloadBytes(chunk) > SESSION_PAYLOAD_CONTENT_BYTE_CAP,
    "this chunk is larger than the packer's budget and still fits, because the budget reserves the WIDEST envelope and this tail emits a narrower one — the fixture must keep proving that the guard judges the built batch, not the budget"
  );

  const transition = resolvePendingChunkTransition(pinnedTail([chunk]), false);

  assert.equal(transition.kind, "send");
  assert.equal(
    transition.kind === "send" && transition.accumulatedBytes,
    SESSION_PAYLOAD_BYTE_CAP
  );
});

test("ISS-8710: a refused tail is left whole rather than partly consumed", () => {
  // `send` shifts the drained chunk off in place. A refusal must not, or the
  // caller — which drops the tail and dead-letters the session — would be
  // reporting on a sequence it had already silently shortened by one chunk.
  const pending = pinnedTail([
    tailOfWrappedBytes(SESSION_PAYLOAD_BYTE_CAP + 1),
    sessionWithPadding("n".repeat(1024)),
  ]);

  const transition = resolvePendingChunkTransition(pending, false);

  assert.equal(transition.kind, "reject-oversized");
  assert.equal(pending.chunks.length, 2);
});

test("ISS-8710: a gzip tail is judged on its COMPRESSED bytes, not its raw ones", () => {
  // One fixture, both arms. Raw it is ~200 KiB; gzipped it is a few hundred
  // bytes. Against a 20 KiB cap the encoding is the whole answer, so a guard
  // that measured the wrong unit fails one arm or the other.
  const chunk = sessionWithPadding(COMPRESSIBLE_PADDING);
  const cap = 20_000;
  assert.ok(
    rawJsonByteLength(chunk) > cap,
    "the fixture must be raw-oversized or the identity arm proves nothing"
  );

  const gzipped = resolvePendingChunkTransition(
    pinnedTail([chunk], { compress: true }),
    true,
    true,
    true,
    undefined,
    cap
  );
  const identity = resolvePendingChunkTransition(
    pinnedTail([chunk], { compress: false }),
    false,
    true,
    true,
    undefined,
    cap
  );

  assert.equal(
    gzipped.kind,
    "send",
    "a chunk that gzips well under the cap was refused, so the drain is measuring raw bytes the wire never carries"
  );
  assert.equal(
    identity.kind,
    "reject-oversized",
    "the same chunk sent uncompressed exceeds the cap and must be refused"
  );
});

test("ISS-8710: the refusal reports the bytes it measured, in the tail's own encoding", () => {
  const chunk = sessionWithPadding(COMPRESSIBLE_PADDING);
  // Below even the compressed size, so the gzip arm refuses too and carries a
  // byte count to compare against the raw serialization.
  const transition = resolvePendingChunkTransition(
    pinnedTail([chunk], { compress: true }),
    true,
    true,
    true,
    undefined,
    300
  );

  assert.equal(transition.kind, "reject-oversized");
  const measured =
    transition.kind === "reject-oversized" ? transition.chunkBytes : 0;
  assert.ok(measured > 300, "the reported size must be the one that failed");
  assert.ok(
    measured < rawJsonByteLength(chunk),
    `the refusal reported ${measured} bytes for a chunk that raw-serializes to ${rawJsonByteLength(chunk)}; a gzip tail must be reported in gzip bytes or the dead-letter telemetry names a size the wire never carried`
  );
});

test("ISS-8710: the service refuses an over-cap tail chunk WITHOUT stranding the session", async () => {
  // End to end through the real service. The preparer hands back a first chunk
  // that fits and a tail chunk that cannot: the first ships, the tail is pinned,
  // and the next drain tick must refuse it. Injected because the real packer
  // never emits such a tail under identity — the unit mismatch that produces one
  // lives on the gzip path, where the boundary is a moving zlib target.
  const source = new FakeSyncSource([
    makeSyncedSession(TAIL_SESSION_ID, "2026-06-08T12:00:00.000Z"),
  ]);
  const sent: AgentSessionSyncTransportPayload[] = [];
  const telemetry: DesktopSyncBatchEventInput[] = [];
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    preparePayloads: () => Promise.resolve([overCapChunkedPayload()]),
    sendBatch: (batch) => {
      sent.push(batch);
      return Promise.resolve({ accepted: true });
    },
    onSyncBatchTelemetry: (event) => {
      telemetry.push(event);
    },
  });

  service.start();
  await pumpSyncDrainTurn();
  await pumpSyncDrainTurn();
  // Read before `stop()`, which clears the lane's in-memory failure state.
  const progress = service.getSyncProgress();
  service.stop();

  assert.equal(
    sent.length,
    1,
    `the drain posted ${sent.length} batches; the pinned tail exceeds the route cap once wrapped, so only the first chunk may reach the wire`
  );
  assert.equal(sent[0]?.sessions[0]?.name, "first-chunk");
  // The behaviour that matters, and the one a terminal disposition would break:
  // the FIRST refusal spends one attempt of the session's bounded budget and
  // defers. It must not dead-letter, because the wire rejection this replaces
  // did not either — see `applyPendingChunkDiscard`.
  assert.deepEqual(
    telemetry
      .filter((event) => event.outcome === DesktopSyncBatchOutcome.DeadLetter)
      .map((event) => event.reason),
    [],
    "the first refusal dead-lettered the session; the 413 it replaces spent one bounded attempt and deferred"
  );
  assert.equal(progress.deadLetteredSessions, 0);
  assert.equal(
    progress.pendingBackfillSessions,
    1,
    "the session must stay queued so a later re-prepare — under a different negotiated cap, encoding or source size — can still deliver it"
  );
});

test("ISS-8710: a tail refusal that dead-letters survives a restart (tamsinb review)", async () => {
  // THE STRAND THIS DEFENDS. The refusal path returns without ever reaching
  // `handleBatchAck` — nothing is sent — so it is the only dead-letter site that
  // could skip the cursor persist. That persist is not an optimization here: a
  // dead-letter flips the durable outbox row to `dead_lettered`, which
  // `loadPendingOutboxIds` filters out, so `sync_state.dead_lettered_ids` is the
  // ONLY record a restart can find the session by (`applyResumedCursor` seeds it
  // back for the idle-cycle revisit). Lose it and the next boot sees no pending
  // row, no recorded dead-letter, and a watermark already past the session,
  // whose `initializeBackfillQueueIfNeeded` early-return means nothing ever
  // re-selects it — locally-captured data that never reaches the cloud.
  const source = new FakeSyncSource([
    makeSyncedSession(TAIL_SESSION_ID, "2026-06-08T12:00:00.000Z"),
  ]);
  const sent: AgentSessionSyncTransportPayload[] = [];
  const buildService = (): AgentSessionSyncService =>
    new AgentSessionSyncService({
      isHttpReady: () => true,
      getSource: () => source,
      getSyncComputeTargetId: () => COMPUTE_TARGET,
      preparePayloads: () => Promise.resolve([overCapChunkedPayload()]),
      sendBatch: (batch) => {
        sent.push(batch);
        return Promise.resolve({ accepted: true as const });
      },
    });

  // Spend the whole validation budget on the refusal, stepping the clock past
  // each backoff rather than sleeping on it.
  const service = buildService();
  let deadLettered = false;
  await runWithMockedNow(async ({ advance }) => {
    service.start();
    for (let step = 0; step < MAX_DRIVE_STEPS; step += 1) {
      await pumpSyncDrainTurn();
      if (service.getSyncProgress().deadLetteredSessions > 0) {
        deadLettered = true;
        return;
      }
      advance(VALIDATION_FAILED_BACKOFF_MS + 1);
      service.refresh();
    }
  });
  service.stop();

  assert.ok(
    deadLettered,
    `the refused tail never dead-lettered after ${MAX_DRIVE_STEPS} steps — the budget this test spends is unbounded, so the restart half below would prove nothing`
  );
  // THE PREMISE, asserted rather than assumed: with the row dead-lettered, the
  // pending-outbox path genuinely cannot find it, which is what makes the cursor
  // the single point of failure.
  assert.equal(
    source.outbox.get(`${SOURCE_KEY}\0${TAIL_SESSION_ID}`)?.status,
    "dead_lettered"
  );
  assert.deepEqual(
    source.pendingOutboxIds(SOURCE_KEY),
    [],
    "the dead-lettered row is invisible to `loadPendingOutboxIds`, so nothing but the cursor can bring this session back"
  );
  // THE FIX. Without the persist in the discard branch this is `[]`.
  assert.deepEqual(
    source.persistedSyncState(SOURCE_KEY)?.deadLetteredIds,
    [TAIL_SESSION_ID],
    "the dead-letter was never recorded in the durable cursor, so nothing on disk remembers the session at all"
  );

  // THE RESTART. A fresh service over the same durable state — the boot that
  // strands the session when the record above is missing.
  const sentBeforeRestart = sent.length;
  const resumed = buildService();
  let reSelected = false;
  await runWithMockedNow(async ({ advance }) => {
    resumed.start();
    for (let step = 0; step < MAX_DRIVE_STEPS; step += 1) {
      await pumpSyncDrainTurn();
      if (sent.length > sentBeforeRestart) {
        reSelected = true;
        return;
      }
      advance(VALIDATION_FAILED_BACKOFF_MS + 1);
      resumed.refresh();
    }
  });
  resumed.stop();

  assert.ok(
    reSelected,
    "the restarted lane never re-attempted the session: no pending outbox row, no cursor dead-letter, and a watermark already past it — the session is stranded on this machine forever"
  );
  assert.equal(
    sent.at(-1)?.sessions[0]?.externalSessionId,
    TAIL_SESSION_ID,
    "the resumed lane sent something, but not this session — the revisit must reach the stranded row itself"
  );
});

test("ISS-8710: the refusal folds as a RECOVERABLE chunk-envelope rejection, not a terminal oversize one", () => {
  // The disposition is the whole of Susan's concern, so assert the fold config
  // itself: `locally_oversized` is `recoverable: false` (infinite set-aside),
  // while the multi-part `validation_failed` class this routes through keeps its
  // re-drive cycles. Drives the real `applyValidationFailure` through the real
  // `applyPendingChunkDiscard`.
  const folds: BoundedFailureFoldConfig[] = [];
  const counter = new Map<string, number>();
  for (
    let attempt = 0;
    attempt < MAX_CONSECUTIVE_VALIDATION_FAILED;
    attempt++
  ) {
    counter.set(TAIL_SESSION_ID, attempt);
    applyPendingChunkDiscard(
      {
        kind: "reject-oversized",
        sessionId: TAIL_SESSION_ID,
        syncMode: AgentSessionSyncMode.Incremental,
        chunkBytes: SESSION_PAYLOAD_BYTE_CAP + 1,
      },
      {
        counter,
        recoverableDeadLetterCountFor: () => 0,
        markForBisection: () => undefined,
        clearBisectionFlag: () => undefined,
        applyBoundedFold: (config) => folds.push(config),
        logInfo: () => undefined,
        formatBytes: (bytes) => String(bytes),
      },
      // The fold is captured rather than performed, so no dead-letter lands and
      // the persistence half stays inert — this case is about the fold CONFIG.
      // The persist itself is driven end to end by the restart case above.
      {
        queueSizes: () => ({ incremental: 0, backfill: 0, deadLettered: 0 }),
        persistCursorIfCaughtUp: () => undefined,
        scheduleImmediateDrainIfReadyWorkRemains: () => undefined,
      }
    );
  }

  assert.equal(folds.length, MAX_CONSECUTIVE_VALIDATION_FAILED);
  const exhausting = folds.at(-1);
  assert.equal(
    exhausting?.recoverable,
    true,
    "the exhausted budget dead-lettered TERMINALLY; a tail-chunk rejection is not reproducible from the persisted row, so it keeps its re-drive cycles"
  );
  assert.equal(exhausting?.reason, CHUNK_VALIDATION_FAILED_REASON);
  assert.equal(exhausting?.maxConsecutive, MAX_CONSECUTIVE_VALIDATION_FAILED);
});

/** A pinned chunk tail for {@link TAIL_SESSION_ID}, drainable as-is. */
function pinnedTail(
  chunks: SyncedAgentSession[],
  overrides: Partial<PendingChunks> = {}
): PendingChunks {
  return {
    sessionId: TAIL_SESSION_ID,
    syncMode: AgentSessionSyncMode.Incremental,
    chunks,
    compress: false,
    activityChunked: false,
    monitoredActivityIncluded: false,
    ...overrides,
  };
}

function baseSession(): SyncedAgentSession {
  return {
    externalSessionId: TAIL_SESSION_ID,
    status: "completed",
    harness: "codex",
    cwd: "/workspace/tail-cap",
    startedAt: "2026-06-08T12:00:00.000Z",
    updatedAt: "2026-06-08T12:01:00.000Z",
    agents: [],
    events: [],
    tokenUsageByModel: [],
  };
}

function sessionWithPadding(padding: string): SyncedAgentSession {
  return { ...baseSession(), name: padding };
}

/**
 * A tail chunk whose BUILT batch serializes to EXACTLY `targetWrappedBytes`
 * under identity encoding — the number the route judges, and the only quantity
 * these cases are about.
 *
 * The envelope width is measured from the real builder on the exact shape
 * {@link pinnedTail} drains, not taken from `AGENT_SESSION_SYNC_BATCH_ENVELOPE_BYTES`:
 * that constant is a MAX over every shape the builder can emit, so this
 * narrower one would land short of the target and the boundary would be off by
 * however much this envelope under-fills the reserve.
 */
function tailOfWrappedBytes(targetWrappedBytes: number): SyncedAgentSession {
  const probe = sessionWithPadding("");
  const envelopeBytes =
    rawJsonByteLength(buildTailBatch(probe)) - rawJsonByteLength(probe);
  const shortfall =
    targetWrappedBytes - envelopeBytes - estimateSessionPayloadBytes(probe);
  if (shortfall < 0) {
    throw new Error(
      `base tail batch is ${-shortfall} bytes past the ${targetWrappedBytes}-byte target, so it cannot be padded to it`
    );
  }
  return sessionWithPadding("n".repeat(shortfall));
}

/** The envelope `resolvePendingChunkTransition` wraps a {@link pinnedTail} in. */
function buildTailBatch(session: SyncedAgentSession) {
  return buildAgentSessionSyncBatch({
    batchId: "00000000-0000-4000-8000-000000000000",
    syncMode: AgentSessionSyncMode.Incremental,
    sessions: [session],
    compress: false,
    dataSyncLevel: undefined,
  });
}

function overCapChunkedPayload(): PreparedAgentSessionPayload {
  return {
    kind: "chunked",
    sessionId: TAIL_SESSION_ID,
    firstChunk: { ...baseSession(), name: "first-chunk" },
    // Comfortably over rather than exactly one byte over: the drain builds this
    // tail under whichever sync mode the pass selected, and those mode strings
    // differ in width, so an exact-boundary fixture here would pin the mode
    // rather than the refusal. The boundary itself is pinned above.
    remainingChunks: [tailOfWrappedBytes(SESSION_PAYLOAD_BYTE_CAP + 1024)],
    payloadBytes: SESSION_PAYLOAD_BYTE_CAP * 2,
    firstChunkBytes: 512,
    chunkCount: 2,
  };
}
