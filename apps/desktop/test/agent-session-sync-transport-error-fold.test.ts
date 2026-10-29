/**
 * @file agent-session-sync-transport-error-fold.test.ts
 * @description ISS-7568 unit coverage for the FEA-3364 thrown-`sendBatch` fold.
 * Drives the pure `applyTransportErrorFold` over a recording fake collaborator
 * and pins the classification the module exists to encode: a typed transport
 * throw (no HTTP answer) defers the LANE and charges no row (ISS-10602), a LOCAL
 * serialization failure is dead-lettered immediately and TERMINAL, and any other
 * throw gets a bounded budget and dead-letters RECOVERABLE so the FEA-3363
 * retry-after path re-drives it.
 *
 * The service suite (`agent-session-sync-service.test.ts`) drives the last two
 * arms through the whole lane and owns the lane-level outcomes: that an untyped
 * throw dead-letters at the budget and is not re-sent, and that a serialization
 * throw dead-letters on the FIRST throw. What it asserts on each is the
 * TELEMETRY reason (`transport_error` for both), which is a different axis from
 * the DEAD-LETTER reason this fold writes — so `transport_serialization`, the
 * non-recoverable flag that makes it terminal, the below-budget path, and which
 * collaborators the dead-letter calls all have no coverage there. That is what
 * this suite owns.
 */

import assert from "node:assert/strict";
import { SyncReason } from "@closedloop-ai/telemetry-contract/sync";
import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import { test } from "vitest";
import { MAX_CONSECUTIVE_TRANSPORT_ERRORS } from "../src/main/agent-sync/agent-session-sync-backoff-policy.js";
import { AgentSessionSyncTransportError } from "../src/main/agent-sync/agent-session-sync-service-helpers.js";
import {
  applyTransportErrorFold,
  type TransportErrorFoldDeps,
} from "../src/main/agent-sync/agent-session-sync-transport-error-fold.js";
import type { LaneEnvironmentalDeferState } from "../src/main/sync/lane-environmental-defer.js";

/**
 * The two dead-letter reasons the fold writes, spelled here as the fold spells
 * them. Deliberately NOT `SyncReason` from `@repo/telemetry-contract`: that is
 * the telemetry attribute vocabulary and has no `transport_serialization`
 * member, so importing it would merge two vocabularies the sync AGENTS.md keeps
 * apart — and would delete this suite's oracle for the terminal arm.
 */
const SERIALIZATION_REASON = "transport_serialization";
const TRANSPORT_ERROR_REASON = "transport_error";

const BATCH_LEFT_QUEUED = /batch left queued for retry/;
const FIRST_ATTEMPT_OF_BUDGET = new RegExp(
  `attempt 1/${MAX_CONSECUTIVE_TRANSPORT_ERRORS}`
);
const DETERMINISTIC_LOCAL_BUG = /a local serialization\/prep failure/;
const EXHAUSTED_BUDGET_CAUSE = new RegExp(
  `${MAX_CONSECUTIVE_TRANSPORT_ERRORS} consecutive transport errors`
);
const PAYLOAD_ONE_KIB = /~1\.0 KiB/;
const THROWN_MESSAGE = /payload worker timed out/;
const LANE_DEFER_NAMES_BUDGETS_INTACT =
  /agent-session batch \(incremental, ~512 B\) threw a transport error \(fetch failed\); deferring 2 session\(s\) for \d+s with retry budgets intact/;

/** A throw the fold must charge to the row: not typed, not a serializer's. */
const untypedThrow = () =>
  new Error("agent-session payload worker timed out after 30000ms");
/** The shape the serialization arm keys on: a `TypeError` naming the encoder. */
const serializationThrow = () =>
  new TypeError("Converting circular structure to JSON");
/** The log is the ONLY record of a stranded batch, so it must name it. */
const WARN_NAMES_LANE_AND_SIZE = /agent-session batch \(incremental, ~512 B\)/;
const ONE_STRANDED_ID = /ids: s1;/;
const TWO_STRANDED_IDS = /ids: s1, s2;/;
const REMAINING_QUEUE_DEPTH =
  /remaining incremental=3 backfill=2 deadLettered=1/;

type DeadLetterCall = { id: string; recoverable: boolean; reason: string };
type LaneDeferCall = { ids: string[]; reason: SyncReason };

const LANE_DEFER_STATE: LaneEnvironmentalDeferState = {
  stalledSinceMs: 0,
  elapsedMs: 0,
  nextAttemptAtMs: 0,
  opened: true,
  givenUp: false,
  gaveUpAtMs: null,
};

type Recorder = {
  deps: TransportErrorFoldDeps;
  counter: Map<string, number>;
  /** Every collaborator call, in order — the fold's contract with the service. */
  calls: string[];
  cleared: string[];
  deadLettered: DeadLetterCall[];
  laneDeferred: LaneDeferCall[];
  discarded: string[][];
  dequeued: Array<{ syncMode: AgentSessionSyncMode; ids: string[] }>;
  infos: string[];
  warnings: string[];
  errors: string[];
};

function makeRecordingDeps(
  counter: Map<string, number> = new Map<string, number>()
): Recorder {
  const calls: string[] = [];
  const cleared: string[] = [];
  const deadLettered: DeadLetterCall[] = [];
  const laneDeferred: LaneDeferCall[] = [];
  const discarded: string[][] = [];
  const dequeued: Array<{ syncMode: AgentSessionSyncMode; ids: string[] }> = [];
  const infos: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const deps: TransportErrorFoldDeps = {
    transportErrorCountById: counter,
    clearRetryStateForId: (id) => {
      calls.push("clearRetryStateForId");
      cleared.push(id);
    },
    markDeadLettered: (id, recoverable, reason) => {
      calls.push("markDeadLettered");
      deadLettered.push({ id, recoverable, reason });
    },
    discardPendingChunksFor: (ids) => {
      calls.push("discardPendingChunksFor");
      discarded.push([...ids]);
    },
    dequeue: (syncMode, ids) => {
      calls.push("dequeue");
      dequeued.push({ syncMode, ids: [...ids] });
    },
    queueSizes: () => {
      calls.push("queueSizes");
      // Distinct non-zero depths so the log's remaining-work tail is checkable.
      return { incremental: 3, backfill: 2, deadLettered: 1 };
    },
    persistCursorIfCaughtUp: () => calls.push("persistCursorIfCaughtUp"),
    scheduleImmediateDrainIfReadyWorkRemains: () =>
      calls.push("scheduleImmediateDrainIfReadyWorkRemains"),
    noteTransportLoss: () => calls.push("noteTransportLoss"),
    deferLaneEnvironmental: (ids, reason) => {
      calls.push("deferLaneEnvironmental");
      laneDeferred.push({ ids: [...ids], reason });
      return LANE_DEFER_STATE;
    },
    logInfo: (message) => {
      calls.push("logInfo");
      infos.push(message);
    },
    logWarn: (message) => {
      calls.push("logWarn");
      warnings.push(message);
    },
    logError: (message) => {
      calls.push("logError");
      errors.push(message);
    },
  };
  return {
    deps,
    counter,
    calls,
    cleared,
    deadLettered,
    laneDeferred,
    discarded,
    dequeued,
    infos,
    warnings,
    errors,
  };
}

test("ISS-7568: a transient throw below the budget only counts and leaves the batch queued", () => {
  const recorder = makeRecordingDeps();
  const deadLettered = applyTransportErrorFold(
    {
      syncMode: AgentSessionSyncMode.Incremental,
      ids: ["s1"],
      payloadBytes: 512,
      error: untypedThrow(),
      maxConsecutive: MAX_CONSECUTIVE_TRANSPORT_ERRORS,
    },
    recorder.deps
  );

  assert.equal(
    deadLettered,
    false,
    "nothing was dead-lettered below the budget"
  );
  assert.equal(recorder.counter.get("s1"), 1, "the transient charge landed");
  assert.deepEqual(
    recorder.calls,
    ["logWarn"],
    "the batch is left queued: no dequeue, no chunk discard, no cursor persist, no drain"
  );
  assert.match(recorder.warnings[0], WARN_NAMES_LANE_AND_SIZE);
  assert.match(recorder.warnings[0], FIRST_ATTEMPT_OF_BUDGET);
  assert.match(recorder.warnings[0], BATCH_LEFT_QUEUED);
});

test("ISS-7568: a serialization throw dead-letters immediately and is TERMINAL", () => {
  const recorder = makeRecordingDeps();
  const deadLettered = applyTransportErrorFold(
    {
      syncMode: AgentSessionSyncMode.Backfill,
      ids: ["s1"],
      payloadBytes: 512,
      error: serializationThrow(),
      // Well below the budget: a deterministic local bug must not wait for it.
      maxConsecutive: MAX_CONSECUTIVE_TRANSPORT_ERRORS,
    },
    recorder.deps
  );

  assert.equal(deadLettered, true);
  assert.deepEqual(recorder.deadLettered, [
    { id: "s1", recoverable: false, reason: SERIALIZATION_REASON },
  ]);
  assert.equal(
    recorder.counter.size,
    0,
    "a serialization failure never charges the transient budget"
  );
  assert.equal(
    recorder.errors.length,
    1,
    "the stranded batch logged at error level"
  );
  assert.match(recorder.errors[0], DETERMINISTIC_LOCAL_BUG);
});

test("ISS-7568: at the budget a transient throw dead-letters as RECOVERABLE", () => {
  const counter = new Map<string, number>([
    ["s1", MAX_CONSECUTIVE_TRANSPORT_ERRORS - 1],
  ]);
  const recorder = makeRecordingDeps(counter);
  const deadLettered = applyTransportErrorFold(
    {
      syncMode: AgentSessionSyncMode.Incremental,
      ids: ["s1"],
      payloadBytes: 1024,
      error: untypedThrow(),
      maxConsecutive: MAX_CONSECUTIVE_TRANSPORT_ERRORS,
    },
    recorder.deps
  );

  assert.equal(deadLettered, true);
  assert.deepEqual(
    recorder.deadLettered,
    [{ id: "s1", recoverable: true, reason: TRANSPORT_ERROR_REASON }],
    "recoverable so the FEA-3363 retry-after path re-enqueues it"
  );
  assert.deepEqual(
    recorder.cleared,
    ["s1"],
    "the per-class retry state was cleared"
  );
  assert.deepEqual(
    recorder.discarded,
    [["s1"]],
    "partial chunks were discarded"
  );
  assert.deepEqual(recorder.dequeued, [
    { syncMode: AgentSessionSyncMode.Incremental, ids: ["s1"] },
  ]);
  assert.deepEqual(
    recorder.calls,
    [
      "clearRetryStateForId",
      "markDeadLettered",
      "discardPendingChunksFor",
      "dequeue",
      "queueSizes",
      "logError",
      "persistCursorIfCaughtUp",
      "scheduleImmediateDrainIfReadyWorkRemains",
    ],
    "the ids leave the queue BEFORE the cursor is asked whether the lane is caught up"
  );
  assert.match(recorder.errors[0], EXHAUSTED_BUDGET_CAUSE);
  assert.match(recorder.errors[0], PAYLOAD_ONE_KIB);
  assert.match(recorder.errors[0], THROWN_MESSAGE);
  assert.match(recorder.errors[0], ONE_STRANDED_ID);
  assert.match(recorder.errors[0], REMAINING_QUEUE_DEPTH);
});

test("ISS-7568: a below-budget id in the batch stays queued while its neighbour dead-letters", () => {
  const counter = new Map<string, number>([
    ["hot", MAX_CONSECUTIVE_TRANSPORT_ERRORS - 1],
    ["cold", 0],
  ]);
  const recorder = makeRecordingDeps(counter);
  const deadLettered = applyTransportErrorFold(
    {
      syncMode: AgentSessionSyncMode.Backfill,
      ids: ["hot", "cold"],
      payloadBytes: 512,
      error: untypedThrow(),
      maxConsecutive: MAX_CONSECUTIVE_TRANSPORT_ERRORS,
    },
    recorder.deps
  );

  assert.equal(deadLettered, true);
  assert.deepEqual(recorder.deadLettered, [
    { id: "hot", recoverable: true, reason: TRANSPORT_ERROR_REASON },
  ]);
  assert.equal(recorder.counter.get("cold"), 1, "the survivor kept its charge");
  assert.deepEqual(
    recorder.discarded,
    [["hot"]],
    "only the dead-lettered id loses its chunks"
  );
  assert.deepEqual(
    recorder.dequeued,
    [{ syncMode: AgentSessionSyncMode.Backfill, ids: ["hot"] }],
    "the dequeue set is the dead-lettered subset, never the whole batch"
  );
});

test("ISS-7568: the serialization arm dead-letters every id in the batch at once", () => {
  const recorder = makeRecordingDeps();
  const deadLettered = applyTransportErrorFold(
    {
      syncMode: AgentSessionSyncMode.Backfill,
      ids: ["s1", "s2"],
      payloadBytes: 512,
      error: serializationThrow(),
      maxConsecutive: MAX_CONSECUTIVE_TRANSPORT_ERRORS,
    },
    recorder.deps
  );

  assert.equal(deadLettered, true);
  assert.deepEqual(recorder.deadLettered, [
    { id: "s1", recoverable: false, reason: SERIALIZATION_REASON },
    { id: "s2", recoverable: false, reason: SERIALIZATION_REASON },
  ]);
  assert.deepEqual(recorder.cleared, ["s1", "s2"]);
  assert.deepEqual(recorder.discarded, [["s1", "s2"]]);
  assert.match(
    recorder.errors[0],
    TWO_STRANDED_IDS,
    "every stranded id is named, separately"
  );
  assert.equal(
    recorder.warnings.length,
    0,
    "a dead-letter never takes the warn path"
  );
});

test("ISS-10602: a typed transport throw defers the LANE and charges no row, even one at the budget edge", () => {
  // "edge" sits one charge from the dead-letter, so a fold that still counted
  // this throw would dead-letter it here; "fresh" has never been charged.
  const counter = new Map<string, number>([
    ["edge", MAX_CONSECUTIVE_TRANSPORT_ERRORS - 1],
  ]);
  const recorder = makeRecordingDeps(counter);
  const deadLettered = applyTransportErrorFold(
    {
      syncMode: AgentSessionSyncMode.Incremental,
      ids: ["edge", "fresh"],
      payloadBytes: 512,
      error: new AgentSessionSyncTransportError("fetch failed", {
        cause: new TypeError("fetch failed"),
      }),
      maxConsecutive: MAX_CONSECUTIVE_TRANSPORT_ERRORS,
    },
    recorder.deps
  );

  assert.equal(deadLettered, false);
  assert.deepEqual(
    recorder.laneDeferred,
    [{ ids: ["edge", "fresh"], reason: SyncReason.TransportError }],
    "every id in the batch defers on the lane gate, under the transport_error cause"
  );
  assert.deepEqual(
    [...recorder.counter],
    [["edge", MAX_CONSECUTIVE_TRANSPORT_ERRORS - 1]],
    "no row is charged, and the charge a row already carries is left as it was"
  );
  assert.deepEqual(
    recorder.calls,
    ["noteTransportLoss", "deferLaneEnvironmental", "logInfo"],
    "nothing is dead-lettered, dequeued, discarded or cleared"
  );
  assert.match(recorder.infos[0], LANE_DEFER_NAMES_BUDGETS_INTACT);
});
