/**
 * @file component-usage-unsendable-unit-visibility.test.ts
 * @description ISS-6999 — the payload chunker's skipped component-usage unit
 * stops being silent.
 *
 * `chunkOversizedSession` skips a `(kind,key)` fold family that no single part
 * can carry, so the rest of the usage set can still paginate. That skip is
 * PERMANENT, not deferred: the usage read is deterministic and
 * `agent_component_session_usage` carries no sync cursor, so the identical unit
 * is re-read and re-skipped on every pass. It reported nothing, because
 * `prepareAgentSessionPayload` runs behind a worker thread where the
 * reader-side sibling's `onDropped` log callback cannot reach — leaving a
 * session that silently ships without those rows indistinguishable from one
 * that genuinely had none.
 *
 * These tests pin:
 *   - DISTINGUISHABILITY, both directions from one fixture family: a prepare
 *     that skipped a unit carries the count, one that skipped nothing does not;
 *   - the conditional tally: no field when the precondition did not hold, and
 *     none on a dead-letter, where nothing shipped at all;
 *   - the bounded-prefix RETRY path, whose different partition would otherwise
 *     report nothing for the exact case the reader's own prefix cannot see;
 *   - the worker boundary: the field survives a structured clone, and a payload
 *     from an older build that never measured it still reads cleanly;
 *   - the production wiring: `prepareCandidatePayloadsIsolated` reaches the
 *     monitored `collector.records_dropped` event with a positive row count,
 *     and stays silent otherwise.
 *
 * The expected reason string and row totals are pinned as INDEPENDENT literals
 * rather than derived from the const under test — the duplication is the test.
 */
import assert from "node:assert/strict";
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import {
  AgentSessionSyncMode,
  MAX_SYNCED_COMPONENT_USAGE,
  type SyncedComponentUsage,
} from "@repo/api/src/types/agent-session";
import { afterEach, describe, test } from "vitest";
import { prepareCandidatePayloadsIsolated } from "../src/main/agent-sync/agent-session-payload-preparation.js";
import {
  type AcceptedAckDeps,
  type AcceptedAckInput,
  processAcceptedAck,
} from "../src/main/agent-sync/agent-session-sync-accepted-ack.js";
import { identitySyncPayloadSizer } from "../src/main/agent-sync/agent-session-sync-compression.js";
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  type SyncedAgentSession,
} from "../src/main/agent-sync/agent-session-sync-contract.js";
import {
  type PreparedAgentSessionPayload,
  prepareAgentSessionPayload,
} from "../src/main/agent-sync/agent-session-sync-payload.js";
import {
  accumulatePreparedPayloads,
  type PendingChunkTransition,
  type PreparedPayloadAccumulator,
  resolvePendingChunkTransition,
} from "../src/main/agent-sync/agent-session-sync-pending-chunks.js";
import { reportCollectorRecordsDropped } from "../src/main/telemetry/collector-records-dropped-telemetry.js";
import { Observability } from "../src/main/telemetry/observability.js";
import { CollectorRecordsDroppedReason } from "../src/main/telemetry/telemetry-protocol.js";

/**
 * The wire string an alert groups by. Pinned here rather than imported from
 * `CollectorRecordsDroppedReason`, so renaming that member cannot silently
 * rewrite what this test claims the monitor sees.
 */
const EXPECTED_DROP_REASON = "component_usage_payload_budget";
const EXPECTED_DROP_CATEGORY = "collector.records_dropped";

/** The sync reason's fate sentence: these rows survive locally, only sync is lost. */
const ROWS_HELD_LOCALLY = /remain in the local store/;
/** The ingestion reasons' fate sentence, which the sync reason must NOT borrow. */
const GONE_EVERYWHERE_CLAIM = /does not exist locally/;
const GONE_EVERYWHERE_SENTENCE = /does not exist locally or upstream/;

// Far above anything these fixtures serialize to, so the BYTE cap can never be
// what forces chunking — only the component-usage row cap may.
const ROOMY_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Each group fits a part alone; fused they do not. `componentUsageMergeKey`
 * groups a slash command with the same-named skill because the desktop cannot
 * know whether the cloud will fold them, so this unit is unsendable while every
 * WIRE group inside it is fine — which is exactly why the reader-side
 * `dropUnsendableComponentGroups` never sees this loss.
 */
const FOLD_BRANCH_ROWS = 300;
/** Both halves of the fused unit: 300 command rows + 300 skill rows. */
const FOLD_UNIT_ROWS = 600;
/** Those same rows as the receiver counts them: a command group and a skill group. */
const FOLD_UNIT_WIRE_GROUPS = 2;

function buildUsage(
  componentKey: string,
  gitBranch: string | null = null,
  componentKind: SyncedComponentUsage["componentKind"] = "tool"
): SyncedComponentUsage {
  return {
    componentKind,
    componentKey,
    externalComponentId: null,
    harness: "claude",
    invocations: 1,
    errorCount: 0,
    firstInvokedAt: "2026-06-10T10:00:00.000Z",
    lastInvokedAt: "2026-06-10T10:30:00.000Z",
    gitBranch,
    componentVersionHash: null,
  };
}

function buildSession(
  components: SyncedComponentUsage[] | undefined,
  externalSessionId = "sess-unsendable-unit"
): SyncedAgentSession {
  return {
    externalSessionId,
    name: "Component usage session",
    status: "active",
    harness: "claude",
    cwd: "/tmp/wt",
    model: "claude-opus-4",
    startedAt: "2026-06-10T10:00:00.000Z",
    updatedAt: "2026-06-10T11:00:00.000Z",
    agents: [],
    events: [],
    tokenUsageByModel: [],
    ...(components ? { components } : {}),
  };
}

/** A command group fused with a same-named skill group past what a part holds. */
function buildFusedUnsendableUnit(): SyncedComponentUsage[] {
  return [
    ...Array.from({ length: FOLD_BRANCH_ROWS }, (_, i) =>
      buildUsage("/deploy", `feat/cmd-${i}`, AgentComponentKind.Command)
    ),
    ...Array.from({ length: FOLD_BRANCH_ROWS }, (_, i) =>
      buildUsage("deploy", `feat/skill-${i}`, AgentComponentKind.Skill)
    ),
  ];
}

/** `count` single-branch groups, every one of them individually sendable. */
function buildSendableGroups(count: number): SyncedComponentUsage[] {
  return Array.from({ length: count }, (_, i) =>
    buildUsage(`tool-${String(i).padStart(4, "0")}`)
  );
}

/** Events fat enough that one fills a chunk, so a COUNT is a chunk count. */
function buildBudgetFillingEvents(count: number): SyncedAgentSession["events"] {
  return Array.from({ length: count }, (_, index) => ({
    externalEventId: `evt-${index}-${"p".repeat(70_000)}`,
    agentExternalId: null,
    eventType: "tool_use",
    toolName: "Read",
    createdAt: "2026-06-10T10:00:00.000Z",
  }));
}

type DroppedRecord = {
  reason: string;
  count: number;
  message: string;
};

/** Every `collector.records_dropped` emission, in order. */
function captureDroppedRecords(): DroppedRecord[] {
  const dropped: DroppedRecord[] = [];
  Observability.init({
    telemetrySend: (event) => {
      if (event.category !== EXPECTED_DROP_CATEGORY) {
        return;
      }
      const record = event.diagnostics?.collectorRecordsDropped;
      if (record) {
        dropped.push({
          reason: record.reason,
          count: record.count,
          message: event.message,
        });
      }
    },
  });
  return dropped;
}

/**
 * Prepare `sessions` and fold the results through the REAL accumulation seam —
 * `prepareCandidatePayloadsIsolated` then `accumulatePreparedPayloads`, exactly
 * as `agent-session-sync-service` drives them.
 *
 * The accumulator is the production frame that decides which prepared payloads
 * actually enter the batch: it leaves a chunked candidate for the next tick once
 * the batch already holds a session. Driving prepare ALONE would let a test
 * assert a report for rows that never reach the wire.
 */
async function drainThroughProductionPath(
  sessions: SyncedAgentSession[],
  maxBytes: number = ROOMY_MAX_BYTES
): Promise<{
  prepared: PreparedAgentSessionPayload[];
  accumulated: PreparedPayloadAccumulator;
  deadLettered: string[];
}> {
  const { prepared } = await prepareCandidatePayloadsIsolated(
    (candidates, candidateMaxBytes) =>
      Promise.resolve(
        candidates.map((session) =>
          prepareAgentSessionPayload(session, candidateMaxBytes)
        )
      ),
    sessions,
    maxBytes
  );
  const accumulated: PreparedPayloadAccumulator = {
    sessions: [],
    syncIds: [],
    accumulatedBytes: 0,
    pendingChunks: null,
  };
  const deadLettered: string[] = [];
  accumulatePreparedPayloads(accumulated, prepared, {
    syncMode: AgentSessionSyncMode.Incremental,
    sendCompress: false,
    activityChunked: false,
    monitoredActivityIncluded: false,
    sizer: identitySyncPayloadSizer,
    byteCap: Number.MAX_SAFE_INTEGER,
    buildBatch: (batchSessions) => ({
      schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
      batchId: "00000000-0000-4000-8000-000000000000",
      syncMode: AgentSessionSyncMode.Incremental,
      sessionCount: batchSessions.length,
      sessions: batchSessions,
    }),
    deadLetter: (sessionId) => deadLettered.push(sessionId),
    logChunking: () => undefined,
  });
  return { prepared, accumulated, deadLettered };
}

/**
 * Drain a pinned chunk tail through the REAL `resolvePendingChunkTransition`
 * until the final chunk, and hand back that last transition.
 *
 * A multi-chunk session's tally is measured on the tick that PREPARED it and is
 * owed on the tick that delivers its LAST bytes — several ticks later. Only the
 * pinned tail bridges those, so a test that skips this drain would never notice
 * a tally that failed to survive the sequence.
 */
function drainTailToFinalChunk(
  accumulated: PreparedPayloadAccumulator
): Extract<PendingChunkTransition, { kind: "send" }> {
  let pending = accumulated.pendingChunks;
  for (;;) {
    const transition = resolvePendingChunkTransition(pending, false);
    if (transition.kind !== "send") {
      throw new Error(`expected a drainable tail, got ${transition.kind}`);
    }
    if (transition.isLast) {
      return transition;
    }
    // `resolvePendingChunkTransition` shifts the chunk off in place, so the same
    // reference is the shortened remainder the next tick would see.
    pending = accumulated.pendingChunks;
  }
}

/**
 * Drive the REAL accepted-ack delivery frame — the only frame allowed to report
 * a skip, because it is the one that knows the server took the bytes and the
 * session is about to be dequeued.
 *
 * Defaults describe the reporting case (final chunk, server confirmed every id
 * sent), so each test overrides only the one fact it is pinning.
 */
async function driveAcceptedAck(
  overrides: Partial<AcceptedAckInput> = {}
): Promise<void> {
  const ids = overrides.ids ?? ["sess-delivered"];
  await processAcceptedAck(
    {
      syncMode: AgentSessionSyncMode.Incremental,
      sessionCount: ids.length,
      payloadBytes: 4096,
      latencyMs: 120,
      hasMoreChunks: false,
      remainingChunks: null,
      acceptedSessionIds: ids,
      ...overrides,
      ids,
    },
    inertAcceptedAckDeps()
  );
}

/** The inert half of the ack deps: everything this suite does not assert on. */
function inertAcceptedAckDeps(): AcceptedAckDeps {
  return {
    rowState: {
      timeoutCountById: new Map(),
      rateLimitedCountById: new Map(),
      unknownAckReasonCountById: new Map(),
      ingestionFailedCountById: new Map(),
      laneStalledSinceMsById: new Map(),
      validationFailedCountById: new Map(),
      ackOmittedCountById: new Map(),
      validationBisectIds: new Set(),
      transportErrorCountById: new Map(),
      clearTransportTimeoutBudgetFor: () => undefined,
      nextRetryAfterMs: new Map(),
      deadLetterCountById: new Map(),
      chunkValidationCycleById: new Map(),
      ackOmittedCycleById: new Map(),
      deadLetteredIds: new Map(),
    },
    // ISS-7957: models a store in which every acked id still HAD a row, which
    // is what `deleteMany` would report for these fixtures. The absent-row
    // case — where the count and the ack length diverge — is the subject of
    // `agent-session-outbox-cleared-rows.test.ts`.
    clearOutboxDurably: (ids) =>
      Promise.resolve({ cleared: true, deletedRowCount: ids.length }),
    sourceStateGeneration: () => 0,
    isStarted: () => true,
    // ISS-8116: these bags exercise ack folding, not identity; the pass-level
    // switch has its own suite (agent-session-sync-pass-identity-guards).
    isCurrentSourceIdentity: () => true,
    dequeue: () => undefined,
    clearLaneGiveUp: () => undefined,
    persistCursorIfCaughtUp: () => undefined,
    applyBoundedFold: () => undefined,
    deadLetteredCount: () => 0,
    resetDeadLetterRevisitAfterDrainedAck: () => undefined,
    queueSizes: () => ({ incremental: 0, backfill: 0 }),
    discardPendingChunkTail: () => undefined,
    schedulePendingPartDrain: () => undefined,
    scheduleImmediateDrainIfReadyWorkRemains: () => undefined,
    emitTelemetry: () => undefined,
    logInfo: () => undefined,
    logError: () => undefined,
  };
}

describe("ISS-6999 unsendable component-usage unit visibility", () => {
  afterEach(() => {
    Observability.reset();
  });

  test("a skipped unit is distinguishable from a session that skipped nothing", () => {
    // BOTH DIRECTIONS FROM ONE FIXTURE FAMILY. An implementation that stamped
    // the field on every prepare would satisfy the first assertion alone, so
    // the same shape with a sendable unit must come back clean.
    const skipped = prepareAgentSessionPayload(
      buildSession([
        ...buildFusedUnsendableUnit(),
        ...buildSendableGroups(MAX_SYNCED_COMPONENT_USAGE + 20),
      ]),
      ROOMY_MAX_BYTES
    );
    const clean = prepareAgentSessionPayload(
      buildSession(buildSendableGroups(MAX_SYNCED_COMPONENT_USAGE + 20)),
      ROOMY_MAX_BYTES
    );

    assert.deepEqual(
      skipped.unsendableComponentUnits,
      { units: FOLD_UNIT_WIRE_GROUPS, rows: FOLD_UNIT_ROWS },
      "the fused command+skill family is 2 wire groups / 600 rows that never sync"
    );
    assert.equal(
      clean.unsendableComponentUnits,
      undefined,
      "a paginated set with nothing unsendable must not claim a skip"
    );
  });

  test("a starved component-usage tail is counted, not just the unsendable unit", () => {
    // The pre-filter tally cannot see this loss. When the shared
    // MAX_SESSION_SYNC_CHUNKS budget runs out mid-stream the packer keeps the
    // parts it built and drops the rest, and that tail is dropped just as
    // permanently — the usage read is deterministic and re-packs identically.
    // Measuring the delivered chunks against the session's own declared set is
    // what catches it; a tally taken from the budget filter alone reports zero
    // and the event is suppressed entirely.
    const perChunkBytes = 120_000;
    const components = buildSendableGroups(MAX_SYNCED_COMPONENT_USAGE + 40);
    const session = buildSession(components, "sess-starved");
    session.events = buildBudgetFillingEvents(99);

    const prepared = prepareAgentSessionPayload(session, perChunkBytes);
    const delivered = deliveredComponentRows(prepared);

    assert.ok(
      delivered < components.length,
      "the fixture must actually starve the usage stream, or it proves nothing"
    );
    assert.deepEqual(
      prepared.unsendableComponentUnits,
      {
        units: components.length - delivered,
        rows: components.length - delivered,
      },
      "every declared row the chunks do not carry is counted (one row per group here)"
    );
  });

  test("a dead-lettered session reports no skip, on the payload or the sink", async () => {
    // Nothing shipped, so nothing shipped WITHOUT its units. Reporting here
    // would count a loss against a session the cloud never received at all.
    //
    // BOTH sinks are asserted deliberately. The tally is computed before the
    // chunker knows whether it will dead-letter, so a refactor that published it
    // at partition time instead of at the committing return would leave the
    // FIELD undefined — the dead-letter arm never stamps — while still lighting
    // up the monitored event. Only the second assertion catches that.
    const tinyCap = 200;
    const dropped = captureDroppedRecords();
    const components = [
      ...buildFusedUnsendableUnit(),
      ...buildSendableGroups(MAX_SYNCED_COMPONENT_USAGE + 20),
    ];

    const prepared = prepareAgentSessionPayload(
      buildSession(components),
      tinyCap
    );
    const { deadLettered } = await drainThroughProductionPath(
      [buildSession(components, "sess-dead-letter")],
      tinyCap
    );

    assert.equal(
      prepared.kind,
      "dead-letter",
      "the fixture must actually dead-letter, or it proves nothing"
    );
    assert.deepEqual(
      deadLettered,
      ["sess-dead-letter"],
      "and it must dead-letter through the production drain too"
    );
    assert.equal(
      prepared.unsendableComponentUnits,
      undefined,
      "a dead-letter delivered no bytes, so it may not report a delivery gap"
    );
    assert.deepEqual(
      dropped,
      [],
      "and the monitored sink stays silent — nothing shipped without its units"
    );
  });

  test("the bounded-prefix retry reports the rows ITS partition leaves behind", () => {
    // The fused unit alone: pagination delivers nothing, so the ISS-6884
    // bounded-prefix retry wins and ships one whole WIRE group. That is a
    // different partition from the fold-family one, and reporting the
    // fold-family tally there would describe bytes that are not being sent —
    // while reporting nothing would blank the exact case the reader's own
    // bounded prefix cannot see.
    const prepared = prepareAgentSessionPayload(
      buildSession(buildFusedUnsendableUnit()),
      ROOMY_MAX_BYTES
    );

    const delivered = deliveredComponentRows(prepared);
    assert.equal(
      delivered,
      FOLD_BRANCH_ROWS,
      "one whole wire group still ships, exactly as the population cap delivered"
    );
    assert.deepEqual(
      prepared.unsendableComponentUnits,
      { units: 1, rows: FOLD_BRANCH_ROWS },
      "and the wire group that did NOT ship is counted, not silently dropped"
    );
  });

  test("the count survives the worker's structured-clone boundary", () => {
    // The production preparer runs in a worker thread and answers over
    // `postMessage`, so the field is only useful if it clones. A plain-number
    // shape is what makes that true; a Map or a class instance would not be.
    const prepared = prepareAgentSessionPayload(
      buildSession([
        ...buildFusedUnsendableUnit(),
        ...buildSendableGroups(MAX_SYNCED_COMPONENT_USAGE + 20),
      ]),
      ROOMY_MAX_BYTES
    );

    const roundTripped = structuredClone(prepared);

    assert.deepEqual(
      roundTripped.unsendableComponentUnits,
      { units: FOLD_UNIT_WIRE_GROUPS, rows: FOLD_UNIT_ROWS },
      "the skip must reach the main thread intact or it has no sink at all"
    );
  });

  test("a payload from a build that never measured the skip degrades to silent", async () => {
    // Version skew, the direction that actually happens: an in-flight payload
    // shaped by an older preparer carries no field. It must read as "nothing
    // skipped" and emit nothing — never as a zero-count record the wire schema
    // would reject, and never as an exception.
    const dropped = captureDroppedRecords();
    const oldShapePayload: PreparedAgentSessionPayload = {
      kind: "session",
      session: buildSession(buildSendableGroups(3)),
      payloadBytes: 128,
    };

    const { prepared } = await prepareCandidatePayloadsIsolated(
      () => Promise.resolve([oldShapePayload]),
      [buildSession(buildSendableGroups(3))],
      ROOMY_MAX_BYTES
    );

    assert.equal(prepared.length, 1, "the old-shape payload is passed through");
    assert.equal(
      prepared[0].unsendableComponentUnits,
      undefined,
      "an absent field stays absent rather than being defaulted to a zero"
    );
    assert.deepEqual(dropped, [], "and nothing is reported for it");
  });

  test("a prepared payload the batch leaves for the next tick reports nothing", async () => {
    // THE OVER-REPORT GUARD. Only a chunked payload can carry a skip, and
    // `accumulatePreparedPayloads` leaves a chunked candidate for the next tick
    // once the batch already holds a session. Reporting at prepare time would
    // count the deferred session's rows against a batch that never carried them
    // — and count them AGAIN when it is re-prepared next tick.
    const dropped = captureDroppedRecords();

    const { accumulated } = await drainThroughProductionPath([
      buildSession(buildSendableGroups(2), "sess-plain"),
      buildSession(buildFusedUnsendableUnit(), "sess-deferred"),
    ]);

    assert.deepEqual(
      accumulated.syncIds,
      ["sess-plain"],
      "the fixture must actually defer the skipping session, or it proves nothing"
    );
    assert.deepEqual(
      dropped,
      [],
      "the deferred session's rows are not reported against a batch that omitted it"
    );
  });

  test("a delivered payload reaches the monitored dropped-records event", async () => {
    // The wiring assertion: a helper nobody calls is not a sink. This drives
    // prepare, the accumulation seam, AND the accepted-ack delivery frame the
    // service actually reports from, then reads the emitted event rather than a
    // mock's arguments.
    const dropped = captureDroppedRecords();

    const { accumulated } = await drainThroughProductionPath([
      buildSession(
        [
          ...buildFusedUnsendableUnit(),
          ...buildSendableGroups(MAX_SYNCED_COMPONENT_USAGE + 20),
        ],
        "sess-monitored"
      ),
    ]);

    assert.deepEqual(
      accumulated.syncIds,
      ["sess-monitored"],
      "the payload must actually enter the batch, or the report describes nothing"
    );
    assert.equal(
      dropped.length,
      0,
      "the fold alone must stay silent — nothing has reached the wire yet"
    );

    // This session needs several chunks, so its tally rides the PINNED TAIL
    // across ticks and is owed only on the last one. Draining it here is the
    // point: a tally that did not survive the sequence would report nothing.
    const final = drainTailToFinalChunk(accumulated);
    assert.ok(
      final.remainingChunks === 0,
      "the fixture must actually span several chunks, or it proves nothing"
    );

    await driveAcceptedAck({
      ids: ["sess-monitored"],
      unsendableComponentUnits: final.unsendableComponentUnits,
    });

    assert.equal(dropped.length, 1, "exactly one event for the delivery");
    assert.equal(
      dropped[0].reason,
      EXPECTED_DROP_REASON,
      "grouped under the reason an alert can filter on"
    );
    assert.equal(
      dropped[0].count,
      FOLD_UNIT_ROWS,
      "counted in ROWS — the records that will not sync, not the groupings"
    );
  });

  test("a delivered payload that skipped nothing emits no event", async () => {
    // The negative sibling of the assertion above, on the same sink. Without it
    // an implementation that emitted on every delivery would still look correct,
    // and a `0` on every healthy install is what makes an alert unreadable.
    const dropped = captureDroppedRecords();

    const { accumulated } = await drainThroughProductionPath([
      buildSession(
        buildSendableGroups(MAX_SYNCED_COMPONENT_USAGE + 20),
        "sess-clean"
      ),
    ]);

    assert.deepEqual(
      accumulated.syncIds,
      ["sess-clean"],
      "the same seam ran — silence here is a decision, not a skipped code path"
    );
    await driveAcceptedAck({
      ids: ["sess-clean"],
      unsendableComponentUnits: accumulated.unsendableComponentUnits,
    });

    assert.deepEqual(
      dropped,
      [],
      "a healthy delivery must stay silent rather than report a drop of zero"
    );
  });

  test("two skipping sessions report once, for the one that was delivered", async () => {
    // A chunked payload claims the whole batch, so the second never enters this
    // tick and must not be counted for it. This pins the cadence to DELIVERED
    // payloads rather than to prepare passes: one event, carrying only the rows
    // the delivered session left behind — never the sum of both.
    const dropped = captureDroppedRecords();

    const { accumulated } = await drainThroughProductionPath([
      buildSession(buildFusedUnsendableUnit(), "sess-a"),
      buildSession(buildFusedUnsendableUnit(), "sess-b"),
    ]);

    assert.deepEqual(
      accumulated.syncIds,
      ["sess-a"],
      "only the first chunked session enters this batch"
    );
    await driveAcceptedAck({
      ids: ["sess-a"],
      unsendableComponentUnits: accumulated.unsendableComponentUnits,
    });

    assert.equal(
      dropped.length,
      1,
      "one event, for the delivered session only"
    );
    assert.equal(
      dropped[0].count,
      FOLD_BRANCH_ROWS,
      "carrying only its rows — summing both would report a loss this batch never made"
    );
  });

  test("a payload folded into a batch that never ships reports nothing", async () => {
    // whitlockk (cid 3846110703) / codex (cid 3846063729) — THE DOUBLE-COUNT GUARD,
    // and the reason the report moved off the fold. Entering the batch is an
    // in-memory step: an empty batch, a stale source, a capability downgrade, and
    // a throwing `sendBatch` all still sit between it and the wire, and each
    // leaves the session queued for a re-prepare that measures these identical
    // rows again. Only an ack may report, so a tick that folds and then returns
    // must stay silent — no matter how large the skip it folded.
    const dropped = captureDroppedRecords();

    const { accumulated } = await drainThroughProductionPath([
      buildSession(buildFusedUnsendableUnit(), "sess-never-sent"),
    ]);

    assert.deepEqual(
      accumulated.syncIds,
      ["sess-never-sent"],
      "the fixture must actually fold the skipping session, or it proves nothing"
    );
    assert.equal(
      accumulated.unsendableComponentUnits?.rows,
      FOLD_BRANCH_ROWS,
      "the tally is carried on the accumulator, ready for an ack that may never come"
    );
    assert.deepEqual(
      dropped,
      [],
      "a fold that never reached the wire reports no loss"
    );
  });

  test("a non-final chunk of a skipping session reports nothing", async () => {
    // Gated on the FINAL chunk, exactly as the sibling tiling-strip delivery is.
    // A mid-sequence chunk has dequeued nothing and its tail can still be
    // discarded whole, which would re-prepare the session and measure the same
    // rows again — so an ack that still owes chunks may not report.
    const dropped = captureDroppedRecords();

    await driveAcceptedAck({
      ids: ["sess-mid-sequence"],
      hasMoreChunks: true,
      remainingChunks: 2,
      unsendableComponentUnits: { units: 1, rows: FOLD_BRANCH_ROWS },
    });

    assert.deepEqual(
      dropped,
      [],
      "a session still owing chunks has not permanently lost anything yet"
    );
  });

  test("the event tells operators these rows are still in the local store", async () => {
    // codex (cid 3846063735). The shared emitter's message used to end with a
    // fixed "That data does not exist locally or upstream." — true of the
    // ingestion reasons, which destroy the record, and FALSE of this one. These
    // rows are still sitting in `agent_component_session_usage`; only their trip
    // to the cloud is lost. An operator told they are gone locally goes looking
    // for a recovery that is not needed, and never performs the one that is.
    const dropped = captureDroppedRecords();

    await driveAcceptedAck({
      ids: ["sess-message"],
      unsendableComponentUnits: { units: 1, rows: FOLD_BRANCH_ROWS },
    });

    assert.equal(dropped.length, 1, "one event to read the message off");
    assert.match(
      dropped[0].message,
      ROWS_HELD_LOCALLY,
      "the sync reason must state that the rows are still held locally"
    );
    assert.doesNotMatch(
      dropped[0].message,
      GONE_EVERYWHERE_CLAIM,
      "and must not repeat the ingestion reasons' claim of total loss"
    );
  });

  test("an ingestion reason still states that its records are gone entirely", () => {
    // The negative sibling: the fix above must not blunt the message for the
    // reasons where total loss IS the truth. Driving the emitter directly is the
    // point — a per-reason branch that collapsed back to one sentence would pass
    // the test above and fail this one.
    const dropped = captureDroppedRecords();

    reportCollectorRecordsDropped({
      reason: CollectorRecordsDroppedReason.SessionResponseBudget,
      count: 3,
    });

    assert.equal(dropped.length, 1, "one event to read the message off");
    assert.match(
      dropped[0].message,
      GONE_EVERYWHERE_SENTENCE,
      "a record the worker boundary destroyed is gone everywhere, and must say so"
    );
  });

  test("a session the server's echo omitted reports nothing", async () => {
    // Counted over the ids the SERVER confirmed, not the ids the client sent.
    // An omitted row stays queued and re-sends, so reporting it here would
    // describe a loss that has not happened — and would describe it again when
    // the row is re-delivered.
    const dropped = captureDroppedRecords();

    await driveAcceptedAck({
      ids: ["sess-omitted"],
      acceptedSessionIds: [],
      unsendableComponentUnits: { units: 1, rows: FOLD_BRANCH_ROWS },
    });

    assert.deepEqual(
      dropped,
      [],
      "the server persisted nothing, so nothing was permanently dropped"
    );
  });
});

/** Component-usage rows the prepared payload actually puts on the wire. */
function deliveredComponentRows(payload: PreparedAgentSessionPayload): number {
  if (payload.kind === "session") {
    return payload.session.components?.length ?? 0;
  }
  if (payload.kind === "chunked") {
    return [payload.firstChunk, ...payload.remainingChunks].reduce(
      (total, chunk) => total + (chunk.components?.length ?? 0),
      0
    );
  }
  return 0;
}
