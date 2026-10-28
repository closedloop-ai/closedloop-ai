/**
 * @file db-host-reply-boundary-work-selection.test.ts
 * @description ISS-8135 — the ISS-8115 boundary, continued onto the three
 * remaining sync-lane replies that SELECT or CONDEMN durable work.
 *
 * `db-host-invoke-dispatch` delivers the child's structured clone VERBATIM and
 * the main side is a single cast on a forwarding Proxy, so malformed and unknown
 * input is REACHABLE here: the types forbid it in-process, and the types are not
 * what runs at this boundary.
 *
 * Three subjects, each covered at two layers:
 *  1. the boundary reader itself (round trip, unknown keys, malformed), and
 *  2. the PRODUCTION path that consumes it, so deleting the call site cannot
 *     leave the suite green.
 *
 * Every refusal below has a positive sibling on the same subject, so none can
 * pass by simply never accepting anything. No fixture is derived from the schema
 * that polices it.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "vitest";
import { recordOutboxReEnqueue } from "../src/main/agent-sync/agent-session-outbox-writers.js";
import { selectHydratableCandidateIds } from "../src/main/agent-sync/agent-session-payload-preparation.js";
import { MAX_DEAD_LETTERED_IDS } from "../src/main/agent-sync/agent-session-sync-backoff-policy.js";
import type { DeadLetterLifecycleDeps } from "../src/main/agent-sync/agent-session-sync-dead-letter-lifecycle.js";
import { enforceDeadLetterCap } from "../src/main/agent-sync/agent-session-sync-dead-letter-lifecycle.js";
import {
  reconcilePendingOutbox,
  requeueResumeOutboxIds,
  type SessionDispositionDeps,
} from "../src/main/agent-sync/agent-session-sync-dispositions.js";
import type {
  AgentSessionSyncSource,
  LocallyOversizedSessionRow,
} from "../src/main/agent-sync/agent-session-sync-source.js";
import { feedIdsIntoBackfillQueue } from "../src/main/agent-sync/backfill-queue-feed.js";
import { OutboxResumeOutcome } from "../src/main/agent-sync/session-outbox-engine-state.js";
import {
  readDeadLetterReEnqueueConfirmation,
  readLocallyOversizedSessions,
  readPendingOutboxIds,
} from "../src/main/agent-sync/sync-source-reply-boundary.js";
import {
  DB_HOST_REPLY_REJECTED_CATEGORY,
  resetDbHostReplyRejectionThrottle,
} from "../src/main/telemetry/db-host-reply-rejection.js";
import { Observability } from "../src/main/telemetry/observability.js";
import type { TelemetryEventPayload } from "../src/main/telemetry/telemetry-protocol.js";
import { DbHostRejectedReplyOp } from "../src/main/telemetry/telemetry-protocol.js";

/**
 * Record what reaches the telemetry lane, restoring the singleton exactly.
 *
 * Assigns the original back rather than deleting the key: `getTelemetryEmitter`
 * is a `static`, so it is an own property of the class itself and deleting it
 * would remove the method outright for every later test in this process.
 */
function captureTelemetry(sink: TelemetryEventPayload[]): () => void {
  const original = Observability.getTelemetryEmitter;
  Observability.getTelemetryEmitter = () => ({
    emit: (event: TelemetryEventPayload) => {
      sink.push(event);
    },
  });
  return () => {
    Observability.getTelemetryEmitter = original;
  };
}

let restoreTelemetry: (() => void) | null = null;
afterEach(() => {
  restoreTelemetry?.();
  restoreTelemetry = null;
});

/** Arm the capture and hand back the sink. */
function armTelemetry(): TelemetryEventPayload[] {
  const sink: TelemetryEventPayload[] = [];
  restoreTelemetry = captureTelemetry(sink);
  return sink;
}

/** The op paths a rejection was reported against, in order. */
function rejectedOps(sink: TelemetryEventPayload[]): unknown[] {
  return sink
    .filter((event) => event.category === DB_HOST_REPLY_REJECTED_CATEGORY)
    .map((event) => event.diagnostics?.dbHostReplyRejected?.op);
}

// The monitored rejection facet is throttled per op by module-level state that
// outlives a case, so a later case asserting the same op would read an earlier
// one's claim — green in file order, red run alone.
beforeEach(() => {
  resetDbHostReplyRejectionThrottle();
});

/** Every rejection event, whatever its op. */
function rejections(sink: TelemetryEventPayload[]): TelemetryEventPayload[] {
  return sink.filter(
    (event) => event.category === DB_HOST_REPLY_REJECTED_CATEGORY
  );
}

/* ------------------------------------------------------------------ *
 * 1. loadPendingOutboxIds — the once-per-identity resume selector
 * ------------------------------------------------------------------ */

/**
 * Hand-written, NOT derived from the schema that polices it: this is what the
 * db-host child actually answers for an outbox holding two un-acked rows.
 */
const PENDING_IDS = ["session-alpha", "session-beta"];

/**
 * A bare `string[]` reply has no unknown-KEY surface at all — there is no object
 * for a newer peer to add a field to — so the loose/strict distinction that the
 * cursor and oversize shapes are tested for does not apply here, and no
 * unknown-key case is written for it. The same is true of the boolean verdict in
 * section 2. Stated rather than silently omitted, so the gap reads as a property
 * of the contract instead of a missing case.
 */
test("pending outbox ids: a real id list survives the boundary, including through a structured clone", () => {
  const sink = armTelemetry();
  assert.deepEqual(readPendingOutboxIds(PENDING_IDS), PENDING_IDS);
  assert.deepEqual(
    readPendingOutboxIds(structuredClone(PENDING_IDS)),
    PENDING_IDS
  );
  // An empty outbox is a POSITIVE claim (the read ran, nothing is owed), not a
  // fault. It must travel, or a device that is genuinely caught up could never
  // finish its resume.
  assert.deepEqual(readPendingOutboxIds([]), []);
  assert.deepEqual(rejectedOps(sink), [], "no rejection for well-formed input");
});

test("pending outbox ids: every unreadable reply degrades to NOT-READ, never to an empty outbox", () => {
  const sink = armTelemetry();
  const malformed: readonly unknown[] = [
    null,
    undefined,
    42,
    0,
    "session-alpha",
    "",
    true,
    false,
    {},
    { ids: PENDING_IDS },
    [1, 2, 3],
    ["session-alpha", null],
    ["session-alpha", 7],
    [["session-alpha"]],
    new Set(PENDING_IDS),
    new Map(),
  ];
  for (const value of malformed) {
    // The monitored emit is throttled per op, so a loop walking many shapes of
    // ONE op inside one window would otherwise report only the first. Each shape
    // is a separate fault here, so each gets its own window.
    resetDbHostReplyRejectionThrottle();
    assert.equal(
      readPendingOutboxIds(value),
      undefined,
      `expected ${JSON.stringify(String(value))} to read as NOT-READ`
    );
  }
  assert.equal(
    rejectedOps(sink).length,
    malformed.length,
    "each rejection is reported once"
  );
  assert.deepEqual(
    new Set(rejectedOps(sink)),
    new Set([DbHostRejectedReplyOp.LoadPendingOutboxIds]),
    "reported against the op whose reply was refused"
  );
});

test("pending outbox ids: a rejection carries the bounded op path and nothing from the rejected value", () => {
  const sink = armTelemetry();
  const secret = ["session-with-a-name-nobody-should-ship", 7];
  assert.equal(readPendingOutboxIds(secret), undefined);
  const [event] = rejections(sink);
  assert.ok(event, "the refusal reached the monitored path");
  assert.deepEqual(
    event.diagnostics?.dbHostReplyRejected,
    { op: DbHostRejectedReplyOp.LoadPendingOutboxIds },
    "the op path is the whole payload"
  );
  assert.ok(
    !event.message.includes("session-with-a-name-nobody-should-ship"),
    "the value that could not be trusted does not travel in the message"
  );
});

/** The live in-memory queue state the resume/idle paths append to. */
function newQueueState() {
  return {
    backfillQueue: [] as string[],
    backfillQueuedIds: new Set<string>(),
    incrementalQueuedIds: new Set<string>(),
    deadLetteredIds: new Map<string, number>(),
  };
}

/**
 * Disposition deps wired to the REAL `feedIdsIntoBackfillQueue`, so a non-array
 * reply reaches the same `for...of` it reaches in production rather than a
 * forgiving double that would hide the throw.
 */
function newDispositionDeps(
  state: ReturnType<typeof newQueueState>,
  warnings: string[]
): SessionDispositionDeps {
  return {
    feedIntoBackfillQueue: (ids: string[]) =>
      feedIdsIntoBackfillQueue(state, ids),
    isTracked: (id: string) =>
      state.backfillQueuedIds.has(id) ||
      state.incrementalQueuedIds.has(id) ||
      state.deadLetteredIds.has(id),
    isCurrentSourceState: () => true,
    readSourceKey: () => "target-a",
    logWarn: (message: string) => {
      warnings.push(message);
    },
    logInfo: () => undefined,
    onDurableWorkQueued: () => undefined,
    scheduleImmediateDrainIfReadyWorkRemains: () => undefined,
    queueSizes: () => ({ incremental: 0, backfill: 0, deadLettered: 0 }),
  } as unknown as SessionDispositionDeps;
}

test("resume: an unreadable pending-outbox reply leaves the identity UN-HYDRATED and queues nothing", async () => {
  const sink = armTelemetry();
  // `null` is the exact shape the caller's `?? []` used to flatten into "the
  // outbox is empty" — a positive claim that COMPLETES the once-per-identity
  // read and strands the un-acked prefix for the life of the process. A
  // non-array reached `feedIdsIntoBackfillQueue`'s `for...of`, which sits
  // OUTSIDE the try that guards the await, and threw out of hydration.
  for (const reply of [null, 42, "session-alpha", { ids: PENDING_IDS }]) {
    const state = newQueueState();
    const warnings: string[] = [];
    const resumed = await requeueResumeOutboxIds(
      {
        sourceKey: "target-a",
        loadPendingIds: () => reply,
        readLiveSourceKey: () => "target-a",
      },
      newDispositionDeps(state, warnings)
    );
    // ISS-9823 narrowed this from `false` to the fault member: every reply in
    // this loop is a read that did not happen, which must NOT share an answer
    // with the superseded-identity arm below.
    assert.equal(
      resumed,
      OutboxResumeOutcome.ReadFailed,
      `expected ${JSON.stringify(String(reply))} to leave the identity un-hydrated`
    );
    assert.deepEqual(state.backfillQueue, [], "nothing was queued");
    assert.equal(warnings.length, 1, "the degradation is stated, not silent");
  }
  assert.deepEqual(
    new Set(rejectedOps(sink)),
    new Set([DbHostRejectedReplyOp.LoadPendingOutboxIds])
  );
});

test("resume: a genuine id list is still queued and the identity stays hydrated (positive sibling)", async () => {
  const sink = armTelemetry();
  const state = newQueueState();
  const warnings: string[] = [];
  const resumed = await requeueResumeOutboxIds(
    {
      sourceKey: "target-a",
      loadPendingIds: () => PENDING_IDS,
      readLiveSourceKey: () => "target-a",
    },
    newDispositionDeps(state, warnings)
  );
  assert.equal(resumed, OutboxResumeOutcome.Seeded);
  assert.deepEqual(
    state.backfillQueue,
    PENDING_IDS,
    "the un-acked prefix is re-selected"
  );
  assert.deepEqual(rejectedOps(sink), []);
});

test("resume: a genuinely EMPTY outbox completes the read (positive sibling)", async () => {
  const sink = armTelemetry();
  const state = newQueueState();
  const warnings: string[] = [];
  const resumed = await requeueResumeOutboxIds(
    {
      sourceKey: "target-a",
      loadPendingIds: () => [],
      readLiveSourceKey: () => "target-a",
    },
    newDispositionDeps(state, warnings)
  );
  // The sibling of the case above, and the reason it cannot be satisfied by
  // refusing everything: a device that really is caught up must still be able to
  // finish hydrating, or the resume would re-arm forever.
  assert.equal(
    resumed,
    OutboxResumeOutcome.Seeded,
    "an empty outbox is a complete answer"
  );
  assert.deepEqual(state.backfillQueue, []);
  assert.deepEqual(warnings, [], "nothing to state");
  assert.deepEqual(rejectedOps(sink), []);
});

test("idle reconcile: an unreadable reply reconciles nothing and does not throw", async () => {
  const sink = armTelemetry();
  const state = newQueueState();
  const warnings: string[] = [];
  await reconcilePendingOutbox(
    () => null,
    () => true,
    newDispositionDeps(state, warnings)
  );
  assert.deepEqual(state.backfillQueue, [], "nothing was reconciled");
  assert.equal(warnings.length, 1);
  assert.deepEqual(rejectedOps(sink), [
    DbHostRejectedReplyOp.LoadPendingOutboxIds,
  ]);
});

test("idle reconcile: untracked pending rows are still requeued (positive sibling)", async () => {
  const sink = armTelemetry();
  const state = newQueueState();
  const warnings: string[] = [];
  await reconcilePendingOutbox(
    () => PENDING_IDS,
    () => true,
    newDispositionDeps(state, warnings)
  );
  assert.deepEqual(
    state.backfillQueue,
    PENDING_IDS,
    "stranded rows are put back on the lane"
  );
  assert.deepEqual(rejectedOps(sink), []);
});

/* ------------------------------------------------------------------ *
 * 2. reEnqueueRecoveredDeadLetter — the hand-off confirmation
 * ------------------------------------------------------------------ */

test("re-enqueue verdict: both booleans travel, and `false` is not a version-skew fault", () => {
  const sink = armTelemetry();
  assert.equal(readDeadLetterReEnqueueConfirmation(true), true);
  // `false` is what the contract answers when the row may still be sitting
  // `dead_lettered`. It is a real verdict, not a refusal, and must not be
  // reported as one — otherwise a healthy peer reporting a failed write would
  // look identical to a peer this build cannot parse.
  assert.equal(readDeadLetterReEnqueueConfirmation(false), false);
  assert.deepEqual(rejectedOps(sink), []);
});

test("re-enqueue verdict: a TRUTHY non-boolean must never read as CONFIRMED (ISS-8135 regression)", () => {
  const sink = armTelemetry();
  // The consumer's gate is `if (!handedOff)` — a truthiness test — so every one
  // of these read as a confirmed durable hand-off and released the session's
  // last in-memory reference. `[]` is the trap worth naming: an empty array is
  // truthy in JavaScript.
  const truthy: readonly unknown[] = [
    {},
    [],
    [false],
    1,
    -1,
    "ok",
    "true",
    "false",
    new Set(),
    new Map(),
    { confirmed: true },
  ];
  for (const value of truthy) {
    // Per-shape window — see the pending-outbox-ids loop above.
    resetDbHostReplyRejectionThrottle();
    assert.equal(
      readDeadLetterReEnqueueConfirmation(value),
      false,
      `expected ${JSON.stringify(String(value))} to establish no confirmation`
    );
  }
  assert.equal(rejectedOps(sink).length, truthy.length);
  assert.deepEqual(
    new Set(rejectedOps(sink)),
    new Set([DbHostRejectedReplyOp.ReEnqueueRecoveredDeadLetter])
  );
});

test("re-enqueue verdict: falsy non-booleans are refused too, not coerced", () => {
  const sink = armTelemetry();
  // These already degraded safely by accident (falsy → not confirmed). They are
  // still refused rather than coerced, so the reader answers on what the peer
  // SAID rather than on how JavaScript happens to weigh it, and the version skew
  // is counted either way.
  const falsy: readonly unknown[] = [null, undefined, 0, "", Number.NaN];
  for (const value of falsy) {
    // Per-shape window — see the pending-outbox-ids loop above.
    resetDbHostReplyRejectionThrottle();
    assert.equal(readDeadLetterReEnqueueConfirmation(value), false);
  }
  assert.equal(rejectedOps(sink).length, falsy.length);
});

/** A source whose re-enqueue delegate answers exactly `reply`. */
function sourceAnswering(reply: unknown): AgentSessionSyncSource {
  return {
    reEnqueueRecoveredDeadLetter: () => Promise.resolve(reply),
  } as unknown as AgentSessionSyncSource;
}

test("outbox writer: a truthy non-boolean reply is reported as NOT confirmed", async () => {
  const sink = armTelemetry();
  const confirmed = await recordOutboxReEnqueue(
    { sourceKey: "target-a", source: sourceAnswering({}) },
    "session-alpha"
  );
  assert.equal(confirmed, false);
  assert.deepEqual(rejectedOps(sink), [
    DbHostRejectedReplyOp.ReEnqueueRecoveredDeadLetter,
  ]);
});

test("outbox writer: a real `true` still confirms the hand-off (positive sibling)", async () => {
  const sink = armTelemetry();
  const confirmed = await recordOutboxReEnqueue(
    { sourceKey: "target-a", source: sourceAnswering(true) },
    "session-alpha"
  );
  assert.equal(confirmed, true);
  assert.deepEqual(rejectedOps(sink), []);
});

test("outbox writer: a source with no re-enqueue delegate is not a version-skew fault", async () => {
  const sink = armTelemetry();
  // A legacy/fake source has no durable ledger to lose the row in, which is the
  // same "nothing durable" `true` `clearOutboxOnAck` returns. Behaving as
  // designed is not a monitored fault.
  const confirmed = await recordOutboxReEnqueue(
    { sourceKey: "target-a", source: {} as AgentSessionSyncSource },
    "session-alpha"
  );
  assert.equal(confirmed, true);
  assert.deepEqual(rejectedOps(sink), []);
});

/** Lifecycle deps over one dead-letter map, with a scripted hand-off verdict. */
function newLifecycleDeps(
  deadLetteredIds: Map<string, number>,
  recordOutboxReEnqueueImpl: (id: string) => Promise<boolean>
): DeadLetterLifecycleDeps {
  return {
    deadLetteredIds,
    deadLetterCountById: new Map<string, number>(),
    chunkValidationCycleById: new Map<string, number>(),
    ackOmittedCycleById: new Map<string, number>(),
    backfillQueue: [],
    backfillQueuedIds: new Set<string>(),
    incrementalQueue: [],
    incrementalQueuedIds: new Set<string>(),
    hasPendingChunks: () => false,
    isHistoricalBackfillEnabled: () => true,
    wasDeadLetterRevisitedThisIdleCycle: () => false,
    setDeadLetterRevisitedThisIdleCycle: () => undefined,
    clearFailureStateForId: () => undefined,
    recordOutboxDeadLetter: () => undefined,
    recordOutboxReEnqueue: recordOutboxReEnqueueImpl,
    logInfo: () => undefined,
    logWarn: () => undefined,
  };
}

/** An over-cap dead-letter map: the cap plus `overflow` ids, oldest first. */
function overCapDeadLetters(overflow: number): Map<string, number> {
  const map = new Map<string, number>();
  for (let index = 0; index < MAX_DEAD_LETTERED_IDS + overflow; index += 1) {
    map.set(`session-${index}`, Number.POSITIVE_INFINITY);
  }
  return map;
}

test("dead-letter cap: a truthy non-boolean must not release the session's last reference", async () => {
  armTelemetry();
  const deadLetteredIds = overCapDeadLetters(3);
  const before = deadLetteredIds.size;
  const deps = newLifecycleDeps(deadLetteredIds, (id) =>
    // The db-host reply travels through the real writer, so this exercises the
    // boundary rather than substituting a value for it.
    recordOutboxReEnqueue(
      { sourceKey: "target-a", source: sourceAnswering({}) },
      id
    )
  );
  enforceDeadLetterCap(deps);
  // The hand-offs are awaited inside a floating promise chain; yield until the
  // microtask queue behind them has drained rather than sleeping a fixed window.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(
    deadLetteredIds.size,
    before,
    "an unconfirmed hand-off keeps every id; the next cap pass retries it"
  );
  assert.ok(
    deadLetteredIds.has("session-0"),
    "the oldest id — the one eviction targets first — is still tracked"
  );
});

test("dead-letter cap: a real `true` still releases the evicted ids (positive sibling)", async () => {
  armTelemetry();
  const deadLetteredIds = overCapDeadLetters(3);
  const before = deadLetteredIds.size;
  const deps = newLifecycleDeps(deadLetteredIds, (id) =>
    recordOutboxReEnqueue(
      { sourceKey: "target-a", source: sourceAnswering(true) },
      id
    )
  );
  enforceDeadLetterCap(deps);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  // The sibling that stops the case above passing by never releasing anything:
  // a confirmed hand-off must still bound the map.
  assert.equal(deadLetteredIds.size, before - 3);
  assert.ok(!deadLetteredIds.has("session-0"), "the oldest was handed off");
});

/* ------------------------------------------------------------------ *
 * 3. findLocallyOversizedSessions — the pre-send oversize DROP
 * ------------------------------------------------------------------ */

/** Hand-written: one proven-oversized row as the db-host child measures it. */
const OVERSIZED: LocallyOversizedSessionRow = {
  id: "session-alpha",
  payloadBytes: 400_000,
};

const CANDIDATES = ["session-alpha", "session-beta"];

/** The cap the caller asks about; `OVERSIZED` clears it, which is the point. */
const CONTENT_BYTE_CAP = 262_144;

test("oversize proof: a real row survives the boundary, including through a structured clone", () => {
  const sink = armTelemetry();
  assert.deepEqual(
    readLocallyOversizedSessions([OVERSIZED], CONTENT_BYTE_CAP),
    [OVERSIZED]
  );
  assert.deepEqual(
    readLocallyOversizedSessions(
      structuredClone([OVERSIZED]),
      CONTENT_BYTE_CAP
    ),
    [OVERSIZED]
  );
  // "nothing is oversized" is the overwhelmingly common healthy answer.
  assert.deepEqual(readLocallyOversizedSessions([], CONTENT_BYTE_CAP), []);
  // One byte over the cap is the smallest real proof there is.
  const barely = { id: "s", payloadBytes: CONTENT_BYTE_CAP + 1 };
  assert.deepEqual(readLocallyOversizedSessions([barely], CONTENT_BYTE_CAP), [
    barely,
  ]);
  assert.deepEqual(rejectedOps(sink), []);
});

test("oversize proof: a row that does not clear the cap proves nothing and is COUNTED", () => {
  const sink = armTelemetry();
  // codex review (#6041). BEHAVIOR CHANGE in this diff, deliberately: a row was
  // previously accepted on its SHAPE alone, so a skewed peer answering
  // `{ id, payloadBytes: 0 }` was condemned — `selectHydratableCandidateIds`
  // only tests whether the id is PRESENT in the returned map, never the size.
  // The producer's relation is `payloadBytes > maxBytes`, and the delegate
  // contract says an implementation "must only return an ID when the old full
  // hydrate path would also have locally dead-lettered it", so a row at or below
  // the cap is a peer contradicting its own contract.
  const belowCap: readonly unknown[] = [
    [{ id: "s", payloadBytes: 0 }],
    [{ id: "s", payloadBytes: 1 }],
    // Exactly AT the cap: `>` is the producer's relation, so this still fits.
    [{ id: "s", payloadBytes: CONTENT_BYTE_CAP }],
    // One clearing row does not launder the sibling that does not.
    [OVERSIZED, { id: "session-beta", payloadBytes: 12 }],
  ];
  for (const value of belowCap) {
    // Per-shape window — see the pending-outbox-ids loop above.
    resetDbHostReplyRejectionThrottle();
    assert.deepEqual(
      readLocallyOversizedSessions(value, CONTENT_BYTE_CAP),
      [],
      `expected ${JSON.stringify(value)} to prove nothing oversized`
    );
  }
  assert.equal(rejectedOps(sink).length, belowCap.length);
  assert.deepEqual(
    new Set(rejectedOps(sink)),
    new Set([DbHostRejectedReplyOp.FindLocallyOversizedSessions])
  );
});

test("oversize proof: a NEWER peer's extra key rides through — the schema is loose, not strict", () => {
  const sink = armTelemetry();
  // The whole reason this boundary is loose: a `.strict()` schema would reject
  // the ENTIRE proof over one key it was never taught, so a newer child that
  // started reporting, say, a compressed estimate would make every session look
  // hydratable and push the drop decision downstream on every single pass.
  const richer = {
    ...OVERSIZED,
    compressedPayloadBytes: 90_000,
    somethingThisBuildHasNeverHeardOf: { nested: true },
  };
  const parsed = readLocallyOversizedSessions([richer], CONTENT_BYTE_CAP);
  assert.equal(parsed.length, 1, "an unknown key must not cost the proof");
  assert.equal(parsed[0]?.id, OVERSIZED.id);
  assert.equal(parsed[0]?.payloadBytes, OVERSIZED.payloadBytes);
  assert.deepEqual(rejectedOps(sink), [], "an unknown key is not a fault");
});

test("oversize proof: every unreadable reply degrades to CONDEMNS-NOTHING", () => {
  const sink = armTelemetry();
  const malformed: readonly unknown[] = [
    null,
    undefined,
    42,
    "session-alpha",
    true,
    {},
    { rows: [OVERSIZED] },
    [null],
    [42],
    ["session-alpha"],
    [[OVERSIZED]],
    // Missing a required field — each one alone.
    [{ id: OVERSIZED.id }],
    [{ payloadBytes: OVERSIZED.payloadBytes }],
    // A known field of the wrong type — each one alone.
    [{ ...OVERSIZED, id: 7 }],
    [{ ...OVERSIZED, id: null }],
    [{ ...OVERSIZED, payloadBytes: "400000" }],
    [{ ...OVERSIZED, payloadBytes: null }],
    [{ ...OVERSIZED, payloadBytes: Number.NaN }],
    [{ ...OVERSIZED, payloadBytes: Number.POSITIVE_INFINITY }],
    [{ ...OVERSIZED, payloadBytes: -1 }],
    // A byte COUNT, so a fraction is not a measurement — and this one would
    // still have been condemned, and then formatted into the drop's log line
    // and put on the wire, as though it were.
    [{ ...OVERSIZED, payloadBytes: 400_000.5 }],
    [{ ...OVERSIZED, payloadBytes: Number.MAX_SAFE_INTEGER + 2 }],
    new Set([OVERSIZED]),
    new Map(),
  ];
  for (const value of malformed) {
    // Per-shape window — see the pending-outbox-ids loop above.
    resetDbHostReplyRejectionThrottle();
    assert.deepEqual(
      readLocallyOversizedSessions(value, CONTENT_BYTE_CAP),
      [],
      `expected ${JSON.stringify(value)} to prove nothing oversized`
    );
  }
  assert.equal(rejectedOps(sink).length, malformed.length);
  assert.deepEqual(
    new Set(rejectedOps(sink)),
    new Set([DbHostRejectedReplyOp.FindLocallyOversizedSessions])
  );
});

test("oversize proof: one bad row refuses the WHOLE proof, not just that row", () => {
  const sink = armTelemetry();
  // Filtering to the rows that parse would condemn some sessions on trusted
  // sizes while silently hydrating others whose row was dropped, and nothing
  // downstream could tell the two populations apart.
  const mixed = [OVERSIZED, { id: "session-beta", payloadBytes: null }];
  assert.deepEqual(readLocallyOversizedSessions(mixed, CONTENT_BYTE_CAP), []);
  assert.deepEqual(rejectedOps(sink), [
    DbHostRejectedReplyOp.FindLocallyOversizedSessions,
  ]);
});

/** A source whose oversize delegate answers exactly `reply`. */
function oversizeSourceAnswering(reply: unknown): AgentSessionSyncSource {
  return {
    findLocallyOversizedSessions: () => Promise.resolve(reply),
  } as unknown as AgentSessionSyncSource;
}

/** Drive the production selector and report what it condemned. */
async function runSelection(source: AgentSessionSyncSource): Promise<{
  hydratable: string[];
  condemned: [string, unknown][];
}> {
  const condemned: [string, unknown][] = [];
  const hydratable = await selectHydratableCandidateIds(
    source,
    [...CANDIDATES],
    false,
    {
      contentByteCap: CONTENT_BYTE_CAP,
      deadLetterOversized: (id, payloadBytes) => {
        condemned.push([id, payloadBytes]);
      },
    }
  );
  return { hydratable, condemned };
}

test("pre-send drop: a `null` payloadBytes must not condemn the session (ISS-8135 regression)", async () => {
  const sink = armTelemetry();
  // `null` passed the caller's own `payloadBytes === undefined` "not oversized"
  // test and went straight to the drop — which dequeues the session, marks it
  // dead-lettered and emits the drop telemetry, all on a size the peer never
  // measured.
  const { hydratable, condemned } = await runSelection(
    oversizeSourceAnswering([{ id: "session-alpha", payloadBytes: null }])
  );
  assert.deepEqual(condemned, [], "an unreadable size proof condemns nothing");
  assert.deepEqual(hydratable, CANDIDATES, "every candidate is still hydrated");
  assert.deepEqual(rejectedOps(sink), [
    DbHostRejectedReplyOp.FindLocallyOversizedSessions,
  ]);
});

test("pre-send drop: a genuinely oversized session is still condemned (positive sibling)", async () => {
  const sink = armTelemetry();
  // The sibling that stops the case above passing by never condemning anything:
  // a session the store really did prove un-shippable must still be dropped
  // before the hydrate, which is the whole point of the FEA-4152 proof.
  const { hydratable, condemned } = await runSelection(
    oversizeSourceAnswering([OVERSIZED])
  );
  assert.deepEqual(condemned, [[OVERSIZED.id, OVERSIZED.payloadBytes]]);
  assert.deepEqual(hydratable, ["session-beta"]);
  assert.deepEqual(rejectedOps(sink), []);
});

test("pre-send drop: a source with no oversize delegate is not a version-skew fault", async () => {
  const sink = armTelemetry();
  // A legacy/fake source predates the proof entirely; it hydrates everything and
  // the downstream byte cap still bounds a genuinely un-shippable session. That
  // is designed behavior, not a peer this build cannot parse.
  const { hydratable, condemned } = await runSelection(
    {} as AgentSessionSyncSource
  );
  assert.deepEqual(condemned, []);
  assert.deepEqual(hydratable, CANDIDATES);
  assert.deepEqual(
    rejectedOps(sink),
    [],
    "an absent delegate must not be counted as a rejected reply"
  );
});
